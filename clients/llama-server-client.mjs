// Client for llama.cpp-based OpenAI-compatible servers (bare llama-server, Unsloth Studio,
// LM Studio) — исторически назывался lmstudio-client, переименован [[14.08.2026]]: LM Studio
// давно не единственный и не основной бэкенд. Env-переменные LMSTUDIO_BASE / LMSTUDIO_API_KEY /
// LMSTUDIO_KEY_FILE сохранены как есть — их знают все кампанейские скрипты и playbook.
// Mirrors the OpenRouter `chat()` of the original ZDR harness, but:
//   * points at a local LM Studio server (no auth, no provider routing, no cost),
//   * measures TTFT + tok/s via streaming (LM Studio's `stats` object is empty),
//   * separates `reasoning_content` (ornith models are reasoners) from final content,
//   * supports tool-use (non-streaming) for the agentic mode.
//
// Endpoint base is configurable via env LMSTUDIO_BASE (default localhost:1234).
//
// AUTH: LM Studio itself needs none, but the same OpenAI-compatible contract is served by
// Unsloth Studio on the GPU stand, which DOES require a bearer token (отдаёт 401 без него).
// Ключ берётся из env LMSTUDIO_API_KEY или из файла LMSTUDIO_KEY_FILE; когда ни то, ни другое
// не задано, заголовок не отправляется вовсе — поведение для LM Studio не меняется.
// Значение никогда не логируется.
import fs from 'fs';

const BASE = (process.env.LMSTUDIO_BASE || 'http://localhost:1234/v1').replace(/\/$/, '');
const API_KEY = (process.env.LMSTUDIO_API_KEY
  || (process.env.LMSTUDIO_KEY_FILE && fs.existsSync(process.env.LMSTUDIO_KEY_FILE)
      ? fs.readFileSync(process.env.LMSTUDIO_KEY_FILE, 'utf8') : '')).trim();
const AUTH = API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One chat completion.
//   opts: { model, messages, max_tokens, tools, tool_choice, stream }
// Returns { ok, content, reasoning, tool_calls, usage:{prompt,completion,reasoning},
//           finish, ttft, total, tokps } or { ok:false, error }.
// 20 min reliable wall-clock cap per call по умолчанию. Переопределяется LLM_DEADLINE_MS:
// плотная модель на 3090 (~25 т/с) с большим бюджетом рассуждений в 20 минут физически
// не укладывается — первый же юнит Qwen3.6-27B-MTP сгорел по дедлайну [[12.08.2026]].
const DEADLINE_MS = Number(process.env.LLM_DEADLINE_MS || 1200000);

// One attempt against the server. `signal` lets the caller abort the socket.
async function attempt({ body, stream, signal }) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH },
    body: JSON.stringify(body), signal,
  });

  if (!stream) {
    const txt = await r.text();
    if (!txt) return { ok: false, retry: true, error: 'empty_response' };
    let d; try { d = JSON.parse(txt); } catch (_) { return { ok: false, retry: true, error: 'bad_json: ' + txt.slice(0, 120) }; }
    if (d.error) return { ok: false, error: JSON.stringify(d.error).slice(0, 160) };
    const msg = d.choices?.[0]?.message || {};
    const total = (Date.now() - t0) / 1000;
    const u = d.usage || {};
    const compTok = u.completion_tokens || 0;
    // Тот же провал счётчика, что в стрим-ветке: llama-server не отдаёт reasoning_tokens —
    // оцениваем долей символов канала размышлений в измеренном completion.
    let reasonTok = u.completion_tokens_details?.reasoning_tokens || 0;
    const rc = msg.reasoning_content || '';
    if (!reasonTok && rc && compTok > 0) {
      reasonTok = Math.round(compTok * (rc.length / (rc.length + (msg.content || '').length || 1)));
    }
    return {
      ok: true, content: msg.content || '', reasoning: rc,
      tool_calls: msg.tool_calls || [], finish: d.choices?.[0]?.finish_reason,
      usage: { prompt: u.prompt_tokens || 0, completion: compTok, reasoning: reasonTok },
      ttft: null, total: +total.toFixed(2), tokps: total > 0 ? +(compTok / total).toFixed(1) : 0,
    };
  }

  // ---- streaming path: capture TTFT + tok/s ----
  let ttft = null, content = '', reasoning = '', finish = null;
  let usage = { prompt: 0, completion: 0, reasoning: 0 };
  // Вызовы инструментов приходят в потоке ПО ЧАСТЯМ: имя обычно целиком в первом чанке, а
  // `arguments` доклеивается кусками. Собираем их по полю `index`, иначе агентный режим в
  // потоковом транспорте не увидел бы ни одного вызова.
  const tcAcc = new Map();
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  let raw = '';                                    // full body, kept to detect non-SSE error replies
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    const chunk = dec.decode(value, { stream: true }); raw += chunk; buf += chunk; let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim(); if (data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch (_) { continue; }
      const delta = j.choices?.[0]?.delta || {};
      if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
      if ((delta.content || delta.reasoning_content) && ttft === null) ttft = (Date.now() - t0) / 1000;
      if (delta.content) content += delta.content;
      if (delta.reasoning_content) reasoning += delta.reasoning_content;
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? 0;
        if (!tcAcc.has(i)) tcAcc.set(i, { id: tc.id || `call_${i}`, type: 'function', function: { name: '', arguments: '' } });
        const acc = tcAcc.get(i);
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function.name += tc.function.name;
        if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
        if (ttft === null) ttft = (Date.now() - t0) / 1000;
      }
      if (j.usage) usage = { prompt: j.usage.prompt_tokens || 0, completion: j.usage.completion_tokens || 0, reasoning: j.usage.completion_tokens_details?.reasoning_tokens || 0 };
    }
  }
  // A failed load / bad request replies with a plain JSON error object (no `data:` lines),
  // so the loop above yields nothing. Surface it as a real error instead of a silent empty ok.
  if (!content && !reasoning && usage.completion === 0 && tcAcc.size === 0) {
    let err = null; try { const e = JSON.parse(raw.trim()); if (e && e.error) err = e.error; } catch (_) {}
    if (err || !r.ok) return { ok: false, error: 'load/stream_error: ' + (JSON.stringify(err) || `http ${r.status}`).slice(0, 160) };
  }
  const total = (Date.now() - t0) / 1000;
  const genTime = ttft != null ? Math.max(0.001, total - ttft) : total; // tok/s of the decode phase
  // ! llama-server НЕ заполняет completion_tokens_details.reasoning_tokens, поэтому у
  //   рассуждающих моделей в отчётах стоял reason=0, хотя reasoning_content реально шёл
  //   (найдено на Muse-Glimmer [[14.08.2026]]: 1742 символа размышлений при «reasoning: 0»).
  //   Токены размышлений при этом входят в ОБЩИЙ completion — делим измеренный итог
  //   пропорционально длинам двух каналов. Это производная оценка, но детерминированная и
  //   честнее нуля; если сервер счётчик даёт (LM Studio) — используется его значение.
  if (!usage.reasoning && reasoning && usage.completion > 0) {
    const share = reasoning.length / (reasoning.length + content.length || 1);
    usage.reasoning = Math.round(usage.completion * share);
  }
  return {
    ok: true, content, reasoning, tool_calls: [...tcAcc.values()], finish,
    usage, ttft: ttft != null ? +ttft.toFixed(3) : null, total: +total.toFixed(2),
    tokps: usage.completion > 0 ? +(usage.completion / genTime).toFixed(1) : 0,
  };
}

// One chat completion with a RELIABLE deadline. AbortController alone does not always
// interrupt a stalled streaming read (undici), so we Promise.race the whole attempt
// against a wall-clock deadline — guaranteeing chat() returns even if the stream hangs.
// Timeouts are NOT retried (a model that can't answer in 20 min won't on retry either).
//   opts: { model, messages, max_tokens, tools, tool_choice, stream }
// Returns { ok, content, reasoning, tool_calls, usage, finish, ttft, total, tokps }
//      or { ok:false, error, timeout? }.
// Сэмплинг: умолчание temperature 0.2 — контрольная константа всей таблицы. Для прогонов
// «на рекомендованных настройках производителя» — env LLM_TEMPERATURE / LLM_TOP_P / LLM_TOP_K
// (отдельной строкой результатов, основную не подменять).
const ENV_TEMP = process.env.LLM_TEMPERATURE !== undefined ? Number(process.env.LLM_TEMPERATURE) : undefined;
const ENV_TOP_P = process.env.LLM_TOP_P !== undefined ? Number(process.env.LLM_TOP_P) : undefined;
const ENV_TOP_K = process.env.LLM_TOP_K !== undefined ? Number(process.env.LLM_TOP_K) : undefined;

async function chat({ model, messages, max_tokens = 40000, tools, tool_choice, stream = false, temperature = 0.2 }) {
  // ! ЗАПРОСЫ С ИНСТРУМЕНТАМИ ВСЕГДА СТРИМЯТСЯ, даже если вызывающий просил иначе.
  //   Причина — ограничение HTTP-клиента, а не сервера: у `fetch` в Node умолчание
  //   `headersTimeout` равно 300 с, а нестриминговый ответ отдаёт заголовки только по
  //   завершении генерации. Медленная модель (Seed-OSS-36B тратит 15–17 тыс. токенов и
  //   свыше 300 с на агентный шаг) обрывалась клиентом с `TypeError: fetch failed`, тогда как
  //   сервер продолжал считать; в результатах это выглядело как `steps=0, latency=0` —
  //   молчаливая потеря всей агентной фазы, неотличимая от отказа модели.
  //   Поднять таймаут нечем: он задаётся только undici-диспетчером, а пакета undici нет.
  //   При стриминге заголовки приходят сразу и потолок исчезает; содержательно ответ тот же,
  //   вызовы инструментов собираются из дельт выше. Побочно появляется честный TTFT.
  if (tools) stream = true;
  // Бюджет вывода можно поднять переменной окружения, не трогая раннеры. Нужно для моделей,
  // которые не укладываются в штатные 40000 токенов: Apriel-1.5-15b-Thinker упёрлась в лимит
  // во ВСЕХ шести одношотовых RUST-прогонах и потому дала 0% — это отсечение по бюджету, а не
  // отказ модели, и подавать такой ноль как результат нельзя. Значение по умолчанию не меняется,
  // поэтому прежние строки таблицы остаются сопоставимыми.
  if (process.env.LLM_MAX_TOKENS) max_tokens = Number(process.env.LLM_MAX_TOKENS);
  const body = { model, messages, temperature: ENV_TEMP ?? temperature, max_tokens, stream };
  if (ENV_TOP_P !== undefined) body.top_p = ENV_TOP_P;
  if (ENV_TOP_K !== undefined) body.top_k = ENV_TOP_K;
  // LM Studio omits `usage` from stream chunks unless explicitly asked.
  if (stream) body.stream_options = { include_usage: true };
  if (tools) { body.tools = tools; body.tool_choice = tool_choice || 'auto'; }

  for (let a = 0; a < 3; a++) {
    const ctrl = new AbortController();
    let timer;
    const deadline = new Promise((_, rej) => { timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} rej(new Error('__TIMEOUT__')); }, DEADLINE_MS); });
    try {
      const res = await Promise.race([attempt({ body, stream, signal: ctrl.signal }), deadline]);
      clearTimeout(timer);
      if (res.ok) return res;
      if (res.retry && a < 2) { await sleep(2000); continue; }
      return res; // non-retryable server error (or out of retries)
    } catch (e) {
      clearTimeout(timer);
      try { ctrl.abort(); } catch (_) {}
      if (String(e && e.message).includes('__TIMEOUT__')) return { ok: false, timeout: true, error: `timeout>${DEADLINE_MS / 1000}s` };
      if (a < 2) { await sleep(2500); continue; }
      return { ok: false, error: 'network: ' + String(e && e.message) };
    }
  }
  return { ok: false, error: 'exhausted' };
}

export { chat, sleep, BASE };
