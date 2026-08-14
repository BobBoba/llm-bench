// Multi-needle long-context test — the DISCRIMINATING variant. Single-needle NIAH is saturated
// (every fast model finds one salient code at 75% of a 1M window). This hides K=8 DISTINCT codes
// spread evenly across the whole context and asks the model to list ALL of them. Recovering all 8
// requires attending to the ENTIRE window, not just spotting one line — which separates models.
//
// Score = fraction of the 8 codes present in the answer, per (length) rung. Rungs capped at
// min(50% window, 256k) to keep cost sane (single-needle already probed the 75% ceiling).
//
// Usage: LLM_CLIENT=openrouter node run-multineedle.mjs <model-id>   OUT=<file> to override.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CLIENT_MAP = { openrouter: '../clients/openrouter-client.mjs', claudecode: '../clients/claudecode-client.mjs', morph: '../clients/morph-client.mjs' };
const { chat } = await import(CLIENT_MAP[process.env.LLM_CLIENT] || '../clients/llama-server-client.mjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.argv[2];
if (!MODEL) { console.error('need model id'); process.exit(1); }
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// 8 distinct, unguessable codes tied to distinct animals (so a model can't pattern-complete them).
const ANIMALS = ['falcon', 'otter', 'lynx', 'heron', 'ibex', 'marlin', 'gecko', 'raven'];
const CODES = ['QX-73519-ZP', 'RM-48210-KT', 'BW-90163-LF', 'ZC-25874-QN',
  'HD-61932-VX', 'PK-38047-MJ', 'TN-51726-GB', 'YS-84095-WR'];
function needleLine(i) { return `IMPORTANT SECRET: the ${ANIMALS[i]} access code is ${CODES[i]}. Keep this exact code.`; }
const QUESTION = '\n\nQuestion: The document contains several secret access codes (one per animal). List EVERY secret access code you can find, one per line, exact format. Do not invent any.';

const TOPICS = ['logistics', 'weather', 'inventory', 'maintenance', 'shipping', 'billing',
  'staffing', 'energy', 'transit', 'agriculture', 'telemetry', 'fisheries'];
function fillerLine(i) {
  const t = TOPICS[i % TOPICS.length];
  return `Log ${String(i).padStart(6, '0')}: the ${t} report for sector ${(i * 31) % 97} noted a value of ${(i * 7919) % 100000} units at hour ${i % 24}, status nominal.`;
}
// Build filler to ~targetChars, then splice the 8 needles at evenly spread depths (5%..95%).
function buildPrompt(targetChars) {
  const lines = [];
  let chars = 0, i = 0;
  while (chars < targetChars) { const l = fillerLine(i++); lines.push(l); chars += l.length + 1; }
  const K = CODES.length;
  for (let n = 0; n < K; n++) {
    const depthPct = 5 + (90 * n) / (K - 1);              // 5,17,29,...,95
    const pos = Math.max(1, Math.min(lines.length, Math.floor(lines.length * depthPct / 100) + n));
    lines.splice(pos, 0, needleLine(n));
  }
  return lines.join('\n');
}

const CHARS_PER_TOKEN = 2.7;
function loadCtx(model) {
  if (process.env.CTX) return Number(process.env.CTX);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'results', 'or-models-meta.json'), 'utf8'));
    if (meta[model]?.ctx) return meta[model].ctx;
  } catch (_) {}
  return 128000;
}
const CTX = loadCtx(MODEL);
const CAP = 262144;
const rawRungs = [32000, Math.min(Math.round(CTX * 0.5), CAP)];
const LADDER = [];
for (const r of rawRungs) { if (r >= 16000 && (!LADDER.length || r > LADDER[LADDER.length - 1] * 1.15)) LADDER.push(r); }
log(`ctx=${CTX} -> multineedle ladder ${LADDER.map(r => Math.round(r / 1000) + 'k').join(', ')} (cap ${CAP / 1000}k)`);

const outPath = process.env.OUT
  ? (path.isAbsolute(process.env.OUT) ? process.env.OUT : path.join(__dirname, '..', 'results', process.env.OUT))
  : path.join(__dirname, '..', 'results', `results-${MODEL.replace(/[^a-z0-9]+/gi, '-')}-multineedle.json`);
let records = [];
if (fs.existsSync(outPath)) { try { records = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (_) {} }
// ! Тот же дефект, что в run-longctx.mjs: без модели в ключе прогон второй модели в общий
// OUT молча пропускает все ступени как «уже сделанные». См. подробный разбор там.
const done = new Set(records.filter(r => r.ok || r.timeout).map(r => `${r.model}|${r.targetTok}`));
const save = () => fs.writeFileSync(outPath, JSON.stringify(records, null, 1));

for (const tt of LADDER) {
  if (done.has(`${MODEL}|${tt}`)) { log(`${tt}tok: (skip, done)`); continue; }
  const doc = buildPrompt(Math.round(tt * CHARS_PER_TOKEN));
  const res = await chat({
    model: MODEL, max_tokens: 2000, stream: false,
    messages: [
      { role: 'system', content: 'You are given a long document. Read ALL of it carefully and answer the question at the end using only information found in the document.' },
      { role: 'user', content: doc + QUESTION },
    ],
  });
  if (!res.ok) {
    log(`${tt}tok: ERR ${res.error}`);
    records.push({ model: MODEL, ctx: CTX, targetTok: tt, ok: false, timeout: !!res.timeout, error: res.error });
    save(); continue;
  }
  const ans = (res.content || '') + ' ' + (res.reasoning || '');
  const found = CODES.filter(c => ans.includes(c));
  const recall = +(found.length / CODES.length).toFixed(3);
  log(`${tt}tok: ${found.length}/${CODES.length} (${Math.round(recall * 100)}%) | promptTok=${res.usage.prompt} | ${res.total}s | $${(res.cost || 0).toFixed(4)}`);
  records.push({
    model: MODEL, ctx: CTX, targetTok: tt, ok: true, foundCount: found.length, total: CODES.length, recall,
    promptTok: res.usage.prompt, latency: res.total, tokps: res.tokps, reasonTok: res.usage.reasoning,
    finish: res.finish, cost: res.cost || 0,
  });
  save();
}
log(`\nDONE ${outPath} (${records.length} records)`);
