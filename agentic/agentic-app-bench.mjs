// Agentic multi-step app-building benchmark.
// A model gets filesystem + shell tools and must BUILD a small stdlib-Python app
// across many steps (write files, run its own tests, iterate) until done. Then a
// HIDDEN pytest suite grades the result. Measures outcome / cost / time / steps.
//
// Shell (`run`) executes inside a podman container (--network=none, scratch-only
// mount, image `bench-py` = python:3.12 + pytest) — the model cannot touch the host.
//
// Usage: node agentic-app-bench.mjs <task> <model> <client:openrouter|local> [costCapUSD]
//   e.g. node agentic-app-bench.mjs calc deepseek/deepseek-v3.2 openrouter 5
//        node agentic-app-bench.mjs calc qwen3-coder-next local
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [task, model, clientKind = 'openrouter', costCapStr] = process.argv.slice(2);
if (!task || !model) { console.error('usage: node agentic-app-bench.mjs <task> <model> <openrouter|local> [costCapUSD]'); process.exit(1); }
const COST_CAP = Number(costCapStr || 6);
const MAX_STEPS = Number(process.env.MAX_STEPS || 30);
const WALL_CAP_MS = Number(process.env.WALL_CAP_MIN || 30) * 60_000;
const RUN_TIMEOUT_S = Number(process.env.RUN_TIMEOUT_S || 90);

const CLIENT = clientKind === 'local' ? '../clients/llama-server-client.mjs' : './openrouter-client.mjs';
const { chat } = await import(path.join('..', CLIENT).replace(/\\/g, '/'));

const TASK_DIR = path.join(__dirname, 'tasks', task);
const SPEC = fs.readFileSync(path.join(TASK_DIR, 'spec.md'), 'utf8');
const RESULTS = path.join(__dirname, 'results');
fs.mkdirSync(RESULTS, { recursive: true });

const safe = model.replace(/[^\w.-]/g, '_');
const SCRATCH = fs.mkdtempSync(path.join('/home/vlad/.abscratch', `agentbench-${task}-${safe}-`));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// ---- sandboxed shell: run inside podman, no network, scratch mounted at /work ----
function podRun(cmd, timeoutS = RUN_TIMEOUT_S) {
  try {
    const out = execFileSync('podman', ['run', '--rm', '--pull=never', '--network=none', '--memory=8g',
      '-v', `${SCRATCH}:/work`, '-w', '/work', 'localhost/bench-py', 'bash', '-lc', cmd],
      { encoding: 'utf8', timeout: timeoutS * 1000, maxBuffer: 4e6, stdio: ['ignore', 'pipe', 'pipe'] });
    return { exit: 0, out: out.slice(0, 6000) };
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).slice(0, 6000);
    return { exit: e.status ?? -1, out: out || String(e.message).slice(0, 400), killed: e.killed || false };
  }
}

// ---- filesystem tools operate on the host scratch dir (bounded to it) ----
function inScratch(p) {
  const full = path.resolve(SCRATCH, p);
  if (!full.startsWith(SCRATCH)) throw new Error('path escapes scratch');
  return full;
}
const TOOLS = [
  { type: 'function', function: { name: 'write_file', description: 'Create/overwrite a file (path relative to project root).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List all files in the project.',
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'run', description: 'Run a shell command in the project (python3.12+pytest available, NO network). Use to run your tests.',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } },
  { type: 'function', function: { name: 'done', description: 'Call when the app is complete and your tests pass.',
    parameters: { type: 'object', properties: {} } } },
];

function execTool(name, args) {
  try {
    if (name === 'write_file') { const f = inScratch(args.path); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, args.content ?? ''); return `wrote ${args.path} (${(args.content || '').length} bytes)`; }
    if (name === 'read_file') { return fs.readFileSync(inScratch(args.path), 'utf8').slice(0, 6000); }
    if (name === 'list_files') { const r = execFileSync('bash', ['-lc', `cd '${SCRATCH}' && find . -type f -not -path './.*' | sort`], { encoding: 'utf8' }); return r || '(empty)'; }
    if (name === 'run') { const r = podRun(args.cmd); return `exit=${r.exit}${r.killed ? ' (TIMEOUT)' : ''}\n${r.out}`; }
    if (name === 'done') { return 'acknowledged'; }
    return 'unknown tool';
  } catch (e) { return 'ERROR: ' + String(e.message).slice(0, 300); }
}

// ---- oracle: run hidden pytest suite against the produced app ----
function gradeHidden() {
  const hidden = path.join(TASK_DIR, 'hidden_test.py');
  fs.copyFileSync(hidden, path.join(SCRATCH, 'hidden_test.py'));
  const r = podRun('python -m pytest -q hidden_test.py 2>&1 | tail -25', 120);
  // pytest summary line like "3 passed" / "1 failed, 2 passed"
  const passed = (r.out.match(/(\d+) passed/) || [0, 0])[1] | 0;
  const failed = (r.out.match(/(\d+) failed/) || [0, 0])[1] | 0;
  const errors = (r.out.match(/(\d+) error/) || [0, 0])[1] | 0;
  const total = passed + failed + errors;
  return { passed: +passed, failed: +failed + +errors, total, tail: r.out.slice(-600) };
}

const SYS = `You are an expert software engineer building a small Python application (standard library only, plus pytest for testing). You work in a project directory via tools: write_file, read_file, list_files, run (shell with python3.12+pytest, no network), done.
Build the app to satisfy the spec. Write your OWN tests and run them with \`python -m pytest\`. Iterate until your tests pass, then call done. Keep going without asking questions.`;

async function main() {
  const t0 = Date.now();
  const messages = [{ role: 'system', content: SYS }, { role: 'user', content: `SPEC:\n${SPEC}` }];
  let steps = 0, cost = 0, tokIn = 0, tokOut = 0, finished = 'cap', aborted = null;
  for (steps = 1; steps <= MAX_STEPS; steps++) {
    if (Date.now() - t0 > WALL_CAP_MS) { aborted = 'wall'; break; }
    if (cost > COST_CAP) { aborted = 'cost'; break; }
    let res;
    try { res = await chat({ model, messages, tools: TOOLS, tool_choice: 'auto', max_tokens: 16000, temperature: 0.3 }); }
    catch (e) { aborted = 'chat_err:' + String(e.message).slice(0, 80); break; }
    if (!res.ok) { aborted = 'chat_fail:' + String(res.error || res.timeout).slice(0, 80); break; }
    cost += res.cost || 0; tokIn += res.usage?.prompt || 0; tokOut += res.usage?.completion || 0;
    const calls = res.tool_calls || [];
    messages.push({ role: 'assistant', content: res.content || '', tool_calls: calls.length ? calls : undefined });
    if (!calls.length) { finished = 'stop_no_tool'; break; }
    let sawDone = false;
    for (const c of calls) {
      let args = {}; try { args = JSON.parse(c.function.arguments || '{}'); } catch (_) {}
      const out = execTool(c.function.name, args);
      if (c.function.name === 'done') sawDone = true;
      messages.push({ role: 'tool', tool_call_id: c.id, content: String(out).slice(0, 6000) });
    }
    log(`[${task}/${model}] step ${steps}: ${calls.map(c => c.function.name).join(',')} | cost=$${cost.toFixed(3)}`);
    if (sawDone) { finished = 'done'; break; }
  }
  const grade = gradeHidden();
  const wall_s = +((Date.now() - t0) / 1000).toFixed(1);
  const rec = { task, model, client: clientKind, outcome_pct: grade.total ? +(grade.passed / grade.total * 100).toFixed(0) : 0,
    passed: grade.passed, total: grade.total, steps, wall_s, cost_usd: +cost.toFixed(4),
    tokens_in: tokIn, tokens_out: tokOut, finished, aborted, scratch: SCRATCH, hidden_tail: grade.tail };
  const outFile = path.join(RESULTS, `${task}__${safe}.json`);
  fs.writeFileSync(outFile, JSON.stringify(rec, null, 1));
  log(`\nDONE ${task}/${model}: outcome ${rec.outcome_pct}% (${grade.passed}/${grade.total}) steps=${steps} wall=${wall_s}s cost=$${rec.cost_usd} finished=${finished}${aborted ? ' aborted=' + aborted : ''}`);
  console.log(JSON.stringify(rec));
}
main();
