// OpenRouter client with the SAME chat() interface as llama-server-client.mjs, so the existing
// run-rust.mjs / run-knowledge.mjs runners work unchanged against cloud models (e.g. to add
// a fresh Anthropic model like Sonnet 5 to the local comparison on identical tasks).
//
// Differences vs the LM Studio client: Bearer auth, Anthropic-style routing
// (data_collection:'deny'), reasoning effort, and real usage.cost capture. Same reliable
// Promise.race deadline. Key from env OPENROUTER_API_KEY or /tmp/.orkey (never logged).

import fs from 'fs';
const KEY = (process.env.OPENROUTER_API_KEY || fs.readFileSync(process.env.ORKEY_FILE || '/tmp/.orkey', 'utf8')).trim();
const DEADLINE_MS = 1200000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function attempt({ body, stream, signal }) {
  const t0 = Date.now();
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal,
  });
  if (!stream) {
    const txt = await r.text();
    if (!txt) return { ok: false, retry: true, error: 'empty_response' };
    let d; try { d = JSON.parse(txt); } catch (_) { return { ok: false, retry: true, error: 'bad_json: ' + txt.slice(0, 120) }; }
    if (d.error) return { ok: false, error: JSON.stringify(d.error).slice(0, 160) };
    const msg = d.choices?.[0]?.message || {};
    const u = d.usage || {};
    const total = (Date.now() - t0) / 1000;
    return {
      ok: true, content: msg.content || '', reasoning: msg.reasoning || msg.reasoning_content || '',
      tool_calls: msg.tool_calls || [], finish: d.choices?.[0]?.finish_reason,
      usage: { prompt: u.prompt_tokens || 0, completion: u.completion_tokens || 0, reasoning: u.completion_tokens_details?.reasoning_tokens || 0 },
      cost: Number(u.cost || 0), ttft: null, total: +total.toFixed(2),
      tokps: total > 0 ? +((u.completion_tokens || 0) / total).toFixed(1) : 0,
    };
  }
  // streaming
  // ! Ошибка API в стрим-режиме приходит НЕ как SSE, а обычным JSON-телом без строк `data:`
  //   (например 404 «нет эндпоинта под текущую data policy»). Старый разбор пропускал не-`data:`
  //   строки молча и возвращал ok:true с ПУСТЫМ контентом — 12 «нулевых» записей
  //   kat-coder-pro-v2 в hard0804 выглядели как провал модели, а не ошибка маршрутизации
  //   [[04.08.2026]]. Поэтому не-2xx ответ разбираем как JSON-ошибку ДО чтения стрима.
  if (!r.ok) {
    const txt = await r.text();
    let d; try { d = JSON.parse(txt); } catch (_) { d = null; }
    return { ok: false, error: (d && d.error ? JSON.stringify(d.error) : `http ${r.status}: ${txt}`).slice(0, 200) };
  }
  let ttft = null, content = '', reasoning = '', finish = null, cost = 0, apiErr = null;
  let usage = { prompt: 0, completion: 0, reasoning: 0 };
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim(); if (data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch (_) { continue; }
      // Ошибка может прийти и SSE-событием посреди стрима (обрыв у провайдера).
      if (j.error) { apiErr = JSON.stringify(j.error).slice(0, 200); continue; }
      const delta = j.choices?.[0]?.delta || {};
      if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
      const rc = delta.reasoning || delta.reasoning_content;
      if ((delta.content || rc) && ttft === null) ttft = (Date.now() - t0) / 1000;
      if (delta.content) content += delta.content;
      if (rc) reasoning += rc;
      if (j.usage) { usage = { prompt: j.usage.prompt_tokens || 0, completion: j.usage.completion_tokens || 0, reasoning: j.usage.completion_tokens_details?.reasoning_tokens || 0 }; cost = Number(j.usage.cost || 0); }
    }
  }
  const total = (Date.now() - t0) / 1000;
  // Пустой стрим без единого содержательного дельта-чанка — это ошибка, а не «модель промолчала»:
  // честный пустой ответ имеет finish_reason, у обрыва/ошибки его нет.
  if (apiErr) return { ok: false, error: apiErr };
  if (!content && !reasoning && finish == null) return { ok: false, retry: true, error: 'empty_stream' };
  const genTime = ttft != null ? Math.max(0.001, total - ttft) : total;
  return {
    ok: true, content, reasoning, tool_calls: [], finish, usage, cost,
    ttft: ttft != null ? +ttft.toFixed(3) : null, total: +total.toFixed(2),
    tokps: usage.completion > 0 ? +(usage.completion / genTime).toFixed(1) : 0,
  };
}

async function chat({ model, messages, max_tokens = 40000, tools, tool_choice, stream = false, temperature = 0.2 }) {
  const body = {
    model, messages, temperature, max_tokens, usage: { include: true },
    provider: { data_collection: 'deny' }, reasoning: { effort: 'medium' },
  };
  if (stream) body.stream = true;
  if (tools) { body.tools = tools; body.tool_choice = tool_choice || 'auto'; }
  for (let a = 0; a < 3; a++) {
    const ctrl = new AbortController();
    let timer;
    const deadline = new Promise((_, rej) => { timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} rej(new Error('__TIMEOUT__')); }, DEADLINE_MS); });
    try {
      const res = await Promise.race([attempt({ body, stream, signal: ctrl.signal }), deadline]);
      clearTimeout(timer);
      if (res.ok) return res;
      if (res.retry && a < 2) { await sleep(2500); continue; }
      return res;
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

export { chat, sleep };
