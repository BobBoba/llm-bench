// Замер prefill/generation через НАТИВНЫЙ эндпоинт llama.cpp `/completion`.
//
// Зачем не llama-bench: в сборке Unsloth Studio (b10194) её попросту нет — поставляются
// только llama-server, llama-quantize и диффузионный сервер. Брать llama-bench из другой
// (стоковой) сборки нельзя: это смешало бы два движка в одном сравнении.
//
// Замер через сервер даже честнее — цифры снимаются с того самого тракта, который потом
// обслуживает батарею тестов. Поле `timings` llama.cpp отдаёт всегда на `/completion`
// (в OpenAI-совместимом `/v1/chat/completions` оно есть не во всех версиях, поэтому
// используем нативный путь).
//
// Usage: node probe-speed.mjs <base> <label> [deepTokens]
//   base       http://192.168.89.53:8080
//   label      метка точки (имя кванта), попадает в результат
//   deepTokens глубина «тяжёлого» замера в токенах (0 = пропустить), по умолчанию 250000
//
// env OUT=results/… — файл результата (дозаписывается, идемпотентно по label+depth).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv[2] || 'http://192.168.89.53:8080').replace(/\/$/, '');
const LABEL = process.argv[3];
const DEEP_TOKENS = process.argv[4] !== undefined ? Number(process.argv[4]) : 250000;
if (!LABEL) { console.error('usage: node probe-speed.mjs <base> <label> [deepTokens]'); process.exit(1); }

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// Тот же генератор наполнителя, что в run-longctx.mjs — детерминированный, без тривиальных
// повторов, которые модель могла бы «сжать». Калибровка та же: ~2.7 символа на токен.
const TOPICS = ['logistics', 'weather', 'inventory', 'maintenance', 'shipping', 'billing',
  'staffing', 'energy', 'transit', 'agriculture', 'telemetry', 'fisheries'];
const CHARS_PER_TOKEN = 2.7;

function filler(targetTokens) {
  const targetChars = Math.floor(targetTokens * CHARS_PER_TOKEN);
  const lines = [];
  let chars = 0, i = 0;
  while (chars < targetChars) {
    const t = TOPICS[i % TOPICS.length];
    const l = `Log ${String(i).padStart(6, '0')}: the ${t} report for sector ${(i * 31) % 97} noted a value of ${(i * 7919) % 100000} units at hour ${i % 24}, status nominal.`;
    lines.push(l); chars += l.length + 1; i++;
  }
  return lines.join('\n');
}

// Один замер.
//
// `cache_prompt: false` — обязательно: иначе повторный прогон переиспользовал бы KV
// предыдущего и prefill измерился бы как «мгновенный», обнулив весь смысл кривой.
//
// `ignore_eos: true` — тоже обязательно, и это не очевидно. Наполнитель заканчивается
// обычной строкой журнала, поэтому модель считает текст завершённым и выдаёт EOS сразу
// же. Без этого флага замер получал ОДИН токен и делил его на околонулевое время,
// выдавая фиктивный миллион токенов в секунду. С флагом модель обязана произвести все
// n_predict токенов, и измеряется именно скорость генерации, а не скорость,
// с которой модель решила замолчать.
async function probe(prompt, nPredict, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/completion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt, n_predict: nPredict, cache_prompt: false, temperature: 0, ignore_eos: true,
      }),
      signal: ctrl.signal,
    });
    const d = await r.json();
    const t = d.timings || {};
    const predicted = t.predicted_n ?? null;
    // Страховка от того же класса ошибок: на выборке меньше 8 токенов число не имеет
    // статистического смысла, и лучше честный null, чем правдоподобная чепуха в отчёте.
    const tg = (predicted != null && predicted >= 8 && t.predicted_per_second != null)
      ? +t.predicted_per_second.toFixed(1) : null;
    return {
      ok: true,
      wall: +((Date.now() - t0) / 1000).toFixed(1),
      promptTokens: t.prompt_n ?? null,
      ppTokPerSec: t.prompt_per_second != null ? +t.prompt_per_second.toFixed(1) : null,
      predictedTokens: predicted,
      tgTokPerSec: tg,
      tgUnreliable: tg == null || undefined,
      prefillSec: t.prompt_ms != null ? +(t.prompt_ms / 1000).toFixed(1) : null,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  } finally { clearTimeout(timer); }
}

const outPath = process.env.OUT
  ? (path.isAbsolute(process.env.OUT) ? process.env.OUT : path.join(__dirname, '..', 'results', process.env.OUT))
  : path.join(__dirname, '..', 'results', 'results-quants-speed.json');

let all = [];
try { all = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (_) {}
const done = new Set(all.map(r => `${r.label}|${r.depth}`));
const save = () => fs.writeFileSync(outPath, JSON.stringify(all, null, 2));

// --- мелкая точка: чистая скорость движка без давления глубокого KV ---
if (!done.has(`${LABEL}|shallow`)) {
  log(`[${LABEL}] shallow (2k prompt, 128 tok)…`);
  const r = await probe(filler(2000), 128, 600000);
  all.push({ label: LABEL, depth: 'shallow', targetTokens: 2000, ...r });
  save();
  log(`  pp=${r.ppTokPerSec} tg=${r.tgTokPerSec} (${r.promptTokens} промпт-токенов)`);
} else { log(`[${LABEL}] shallow — уже есть, пропуск`); }

// --- глубокая точка: то, ради чего кампания. Prefill 250k занимает минуты, поэтому
// таймаут щедрый (45 мин): у самых медленных квантов на CPU-offload иначе оборвётся. ---
if (DEEP_TOKENS > 0 && !done.has(`${LABEL}|deep`)) {
  log(`[${LABEL}] deep (${DEEP_TOKENS} prompt, 128 tok) — это надолго…`);
  const r = await probe(filler(DEEP_TOKENS), 128, 2700000);
  all.push({ label: LABEL, depth: 'deep', targetTokens: DEEP_TOKENS, ...r });
  save();
  log(`  pp=${r.ppTokPerSec} tg=${r.tgTokPerSec} prefill=${r.prefillSec}s (${r.promptTokens} промпт-токенов)`);
} else if (DEEP_TOKENS > 0) { log(`[${LABEL}] deep — уже есть, пропуск`); }

log(`OK -> ${outPath}`);
