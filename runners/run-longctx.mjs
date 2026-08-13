// Long-context "needle in a haystack" (NIAH) test — generalized to any client (default target:
// OpenRouter under ZDR). Hides one unique fact (the "needle") at a given DEPTH inside filler
// text of a target token length, then asks the model to retrieve it. Scoring is OBJECTIVE:
// does the exact needle code appear in the answer? Measures retrieval accuracy vs
// (context length × depth) plus prefill latency — the real test of a long-context claim.
//
// Length ladder is PER-MODEL: [8k, 25%, 50%, 75% of the model's own context window]. The top
// rung is 75% of the declared window (the point where big-window models tend to degrade).
// Depths 10/50/90 on rungs <=256k; only depth 50 on larger rungs (giant prefill is expensive).
//
// Usage: LLM_CLIENT=openrouter node run-longctx.mjs <model-id>
//   CTX=<tokens> to override the window if the model isn't in or-models-meta.json.
//   OUT=<file> to override output file.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CLIENT_MAP = { openrouter: '../clients/openrouter-client.mjs', claudecode: '../clients/claudecode-client.mjs', morph: '../clients/morph-client.mjs' };
const { chat } = await import(CLIENT_MAP[process.env.LLM_CLIENT] || '../clients/lmstudio-client.mjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.argv[2];
if (!MODEL) { console.error('need model id'); process.exit(1); }
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// Unique needle — a code that cannot appear in filler and cannot be guessed.
const CODE = 'QX-73519-ZP';
const NEEDLE = `IMPORTANT SECRET: The Obsidian Gate unlock code is ${CODE}. Remember this exact code.`;
const QUESTION = '\n\nQuestion: Somewhere in the document above is the Obsidian Gate unlock code. What is it? Reply with ONLY the code, nothing else.';

// Deterministic, varied filler (no trivial repetition the model can compress away).
const TOPICS = ['logistics', 'weather', 'inventory', 'maintenance', 'shipping', 'billing',
  'staffing', 'energy', 'transit', 'agriculture', 'telemetry', 'fisheries'];
function fillerLine(i) {
  const t = TOPICS[i % TOPICS.length];
  return `Log ${String(i).padStart(6, '0')}: the ${t} report for sector ${(i * 31) % 97} noted a value of ${(i * 7919) % 100000} units at hour ${i % 24}, status nominal.`;
}
function buildPrompt(targetChars, depthPct) {
  const lines = [];
  let chars = 0, i = 0;
  while (chars < targetChars) { const l = fillerLine(i++); lines.push(l); chars += l.length + 1; }
  const pos = Math.max(1, Math.min(lines.length - 1, Math.floor(lines.length * depthPct / 100)));
  lines.splice(pos, 0, NEEDLE);
  return lines.join('\n');
}

// Calibrated on the actual filler: ~2.72 chars/token (short log lines, many digits). Using 3.6
// overshot targets by ~1.33×, which would push the 75% rung past the real window. Actual
// prompt_tokens are still recorded from usage, so the reported length is the true one.
const CHARS_PER_TOKEN = 2.7;
const DEPTHS = [10, 50, 90];

// ---- per-model length ladder from the declared context window (75% cap) ----
function loadCtx(model) {
  if (process.env.CTX) return Number(process.env.CTX);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'results', 'or-models-meta.json'), 'utf8'));
    if (meta[model]?.ctx) return meta[model].ctx;
  } catch (_) {}
  return 128000; // safe default
}
const CTX = loadCtx(MODEL);
// rungs: 8k baseline, then 25/50/75% of the window; dedup + keep strictly increasing.
const rawRungs = [8000, Math.round(CTX * 0.25), Math.round(CTX * 0.50), Math.round(CTX * 0.75)];
const LADDER = [];
for (const r of rawRungs) { if (r >= 4000 && (!LADDER.length || r > LADDER[LADDER.length - 1] * 1.15)) LADDER.push(r); }
log(`ctx=${CTX} tok -> ladder ${LADDER.map(r => Math.round(r / 1000) + 'k').join(', ')} (max = 75% window)`);

const outPath = process.env.OUT
  ? (path.isAbsolute(process.env.OUT) ? process.env.OUT : path.join(__dirname, '..', 'results', process.env.OUT))
  : path.join(__dirname, '..', 'results', `results-${MODEL.replace(/[^a-z0-9]+/gi, '-')}-longctx.json`);
let records = [];
if (fs.existsSync(outPath)) { try { records = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (_) {} }
// ! Ключ пропуска ОБЯЗАН включать модель. Раннер писался под «один OUT на модель», и без
// имени модели в ключе прогон второй модели в ОБЩИЙ файл молча пропускает ВСЕ ступени как
// «уже сделанные». Сбой тихий и коварный: фаза выглядит мгновенно успешной, в отчёт попадают
// чужие цифры. Поймано в кампании по квантам [[02.08.2026]], где все точки пишут в один
// results-quants-longctx.json. Правка обратно совместима: для старых одномодельных файлов
// ключ просто строже, но для той же модели совпадает по-прежнему.
const done = new Set(records.filter(r => r.ok || r.timeout).map(r => `${r.model}|${r.targetTok}|${r.depth}`));
const save = () => fs.writeFileSync(outPath, JSON.stringify(records, null, 1));

for (const tt of LADDER) {
  // depth sweep only on smaller rungs; giant prefill (>256k) gets depth 50 only.
  const depths = tt > 256000 ? [50] : DEPTHS;
  for (const d of depths) {
    if (done.has(`${MODEL}|${tt}|${d}`)) { log(`${tt}tok d${d}: (skip, done)`); continue; }
    const doc = buildPrompt(Math.round(tt * CHARS_PER_TOKEN), d);
    const res = await chat({
      model: MODEL, max_tokens: 4000, stream: false,
      messages: [
        { role: 'system', content: 'You are given a long document. Read it carefully and answer the question at the end using only information found in the document.' },
        { role: 'user', content: doc + QUESTION },
      ],
    });
    if (!res.ok) {
      log(`${tt}tok d${d}: ERR ${res.error}`);
      records.push({ model: MODEL, ctx: CTX, targetTok: tt, depth: d, ok: false, timeout: !!res.timeout, error: res.error });
      save(); continue;
    }
    const ans = (res.content || '') + ' ' + (res.reasoning || '');
    const found = ans.includes(CODE);
    log(`${tt}tok d${d}: ${found ? 'FOUND' : 'MISS'} | promptTok=${res.usage.prompt} | ${res.total}s | tok/s=${res.tokps} | reason=${res.usage.reasoning} | ans=${JSON.stringify((res.content || '').slice(0, 40))}`);
    records.push({
      model: MODEL, ctx: CTX, targetTok: tt, depth: d, ok: true, found,
      promptTok: res.usage.prompt, latency: res.total, tokps: res.tokps,
      reasonTok: res.usage.reasoning, finish: res.finish, cost: res.cost || 0, answer: (res.content || '').slice(0, 120),
    });
    save();
  }
}
log(`\nDONE ${outPath} (${records.length} records)`);
