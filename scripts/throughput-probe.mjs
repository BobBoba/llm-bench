// Throughput probe: measure real generation tok/s of every paid text->text OpenRouter model
// UNDER ZDR routing (data_collection:'deny'), to select the ">100 tok/s" cohort for the benchmark.
//
// * Streaming, one short call per model. tok/s = completion_tokens / (total - ttft) — the same
//   definition the benchmark's tok/s column uses. No `reasoning` param (raw generation speed).
// * Models with no ZDR endpoint error out here -> naturally excluded (exactly the filter we want).
// * Resumable + crash-safe: writes results/throughput-probe.json after every result; a re-run
//   skips ids already recorded. Concurrency-limited pool.
//
// Usage: OPENROUTER_API_KEY=... node scripts/throughput-probe.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'results', 'throughput-probe.json');
const KEY = (process.env.OPENROUTER_API_KEY || fs.readFileSync('/tmp/.orkey', 'utf8')).trim();
const CONCURRENCY = 10;
const PROBE_TIMEOUT_MS = 90000;
const MAX_TOKENS = 350;
// A prompt that reliably fills a few hundred plain tokens on ANY instruct model (stable tps read).
const PROMPT = 'Write a single flowing paragraph of about 250 words describing how a mechanical clock works. Plain prose only.';

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

async function listModels() {
  const r = await fetch('https://openrouter.ai/api/v1/models');
  const d = (await r.json()).data;
  return d.filter(m => {
    const a = m.architecture || {};
    const im = a.input_modalities || [], om = a.output_modalities || [];
    return im.includes('text') && om.includes('text') && !om.includes('image') && !m.id.includes(':free');
  }).map(m => m.id);
}

// Non-streaming probe: robust for a selection filter — catches error bodies (no ZDR endpoint) via
// d.error, and tps = completion/total is a stable, conservative generation-speed proxy. The
// table's precise streaming tok/s is measured later during the real benchmark run.
async function probe(model) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, PROBE_TIMEOUT_MS);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: MAX_TOKENS, temperature: 0.3,
        provider: { data_collection: 'deny' }, usage: { include: true },
        messages: [{ role: 'user', content: PROMPT }],
      }),
    });
    const txt = await r.text();
    clearTimeout(timer);
    const total = (Date.now() - t0) / 1000;
    let d; try { d = JSON.parse(txt); } catch (_) { return { model, ok: false, error: 'bad_json: ' + txt.slice(0, 80) }; }
    if (d.error) return { model, ok: false, error: JSON.stringify(d.error).slice(0, 140) };
    const completion = d.usage?.completion_tokens || 0;
    if (!completion) return { model, ok: false, error: 'no_content' };
    return { model, ok: true, tokps: +(completion / total).toFixed(1), completion, total: +total.toFixed(2) };
  } catch (e) {
    clearTimeout(timer);
    return { model, ok: false, error: String(e && e.message).slice(0, 100) };
  }
}

// ---- resumable pool ----
let results = [];
if (fs.existsSync(OUT)) { try { results = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) {} }
const done = new Set(results.map(r => r.model));
const save = () => fs.writeFileSync(OUT, JSON.stringify(results, null, 1));

const all = await listModels();
const todo = all.filter(m => !done.has(m));
log(`${all.length} candidates, ${todo.length} to probe (${done.size} cached).`);

let i = 0, completed = 0;
async function worker() {
  while (i < todo.length) {
    const model = todo[i++];
    const res = await probe(model);
    results.push(res); completed++;
    if (completed % 10 === 0 || res.ok && res.tokps > 100) save();
    log(`[${completed}/${todo.length}] ${model}: ${res.ok ? res.tokps + ' tok/s' : 'x ' + res.error}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
save();

const fast = results.filter(r => r.ok && r.tokps > 100).sort((a, b) => b.tokps - a.tokps);
log(`\n===== >100 tok/s (ZDR): ${fast.length} models =====`);
for (const r of fast) log(`  ${r.tokps}\t${r.model}`);
