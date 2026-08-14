// General-knowledge / humanities benchmark for LOCAL LM Studio models.
// Faithful port of /code/src/zdr-knowledge-bench: same 5 axes, same prompts, same
// fact-probe battery + answer key. Collects raw answers; scoring is done by the
// Opus 4.8 judge (same as the original run) reading results-ornith-knowledge.json.
//
// Usage: node run-knowledge.mjs [model1 model2 ...]   (default: both ornith models)

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
// Client switchable via LLM_CLIENT: openrouter -> cloud, claudecode -> `claude -p` (subscription),
// default -> local LM Studio.
const CLIENT_MAP = { openrouter: '../clients/openrouter-client.mjs', claudecode: '../clients/claudecode-client.mjs', morph: '../clients/morph-client.mjs' };
const { chat } = await import(CLIENT_MAP[process.env.LLM_CLIENT] || '../clients/llama-server-client.mjs');

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { TASKS } = require('../tasks/tasks-knowledge.js');

const MODELS = (process.argv.slice(2).length ? process.argv.slice(2) : ['ornith-1.0-9b', 'ornith-1.0-35b']);
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// Crash-safe + resumable: writes after every record, skips done (model+axis).
const outPath = process.env.OUT
  ? (path.isAbsolute(process.env.OUT) ? process.env.OUT : path.join(__dirname, '..', 'results', process.env.OUT))
  : path.join(__dirname, '..', 'results', 'results-ornith-knowledge.json');
let records = [];
if (fs.existsSync(outPath)) { try { records = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (_) { records = []; } }
const done = new Set(records.filter(r => r.ok).map(r => `${r.model}|${r.axis}`));
const save = () => fs.writeFileSync(outPath, JSON.stringify(records, null, 1));

for (const model of MODELS) {
  log(`\n===== MODEL ${model} =====`);
  for (const t of TASKS) {
    if (done.has(`${model}|${t.key}`)) { log(`${t.key}: (skip, done)`); continue; }
    const res = await chat({
      model, max_tokens: 16000, stream: true,
      messages: [{ role: 'user', content: t.prompt }],
    });
    if (!res.ok) { log(`${t.key}: ERR ${res.error}`); records.push({ model, axis: t.key, ok: false, error: res.error }); save(); continue; }
    const empty = !res.content || res.content.trim().length === 0;
    log(`${t.key}: ${empty ? '[EMPTY/' + res.finish + ']' : res.content.length + ' chars'} ${res.total}s ttft=${res.ttft} tok/s=${res.tokps} reason=${res.usage.reasoning}`);
    records.push({
      model, axis: t.key, ok: true, empty, finish: res.finish,
      answer: res.content || '', reasoning: res.reasoning || '',
      tokIn: res.usage.prompt, tokOut: res.usage.completion, reasonTok: res.usage.reasoning,
      latency: res.total, ttft: res.ttft, tokps: res.tokps, cost: res.cost || 0,
    });
    save();
  }
}
log(`\nDONE ${outPath} (${records.length} records)`);
