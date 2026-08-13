// TypeScript code-gen benchmark for LOCAL LM Studio models (sibling of run-rust.mjs).
// Same single-shot(×2)+agentic(×1) protocol and the same crash-safe/resumable driver;
// only the oracle differs: `tsc --strict` is the type-soundness gate and `bun test`
// runs the hidden suite. The agentic loop additionally records TOOL-FIDELITY metrics
// (valid-tool-call ratio, steps-to-green, recovery) — the signals that actually predict
// whether a model is usable as an everyday agentic coding driver.
//
// Usage:  node run-ts.mjs [model1 model2 ...]
//   env OUT=results-foo-ts.json  choose output file (resumable)
//   env LLM_CLIENT=openrouter    route to cloud instead of local LM Studio

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
// Client switchable via LLM_CLIENT: openrouter -> cloud, claudecode -> `claude -p` (subscription),
// default -> local LM Studio.
const CLIENT_MAP = { openrouter: '../clients/openrouter-client.mjs', claudecode: '../clients/claudecode-client.mjs', morph: '../clients/morph-client.mjs' };
const { chat } = await import(CLIENT_MAP[process.env.LLM_CLIENT] || '../clients/lmstudio-client.mjs');

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { TASKS } = require('../tasks/tasks-ts.js');

const HOME = process.env.HOME;
// BENCH_BUN / BENCH_TSC let a caller point at PATH-resolved binaries (e.g. `bun`/`tsc` on Windows,
// where the Linux ~/.bun and ~/.nvm layouts do not exist).
const BUN = process.env.BENCH_BUN || `${HOME}/.bun/bin/bun`;

// tsc resolver: prefer a real nvm-installed tsc (fast, no network), else `bunx tsc`
// (bun caches TypeScript locally after the first fetch). Resolved once at startup.
function resolveTsc() {
  const base = `${HOME}/.nvm/versions/node`;
  try {
    const vers = fs.readdirSync(base).sort().reverse();
    for (const v of vers) {
      const p = path.join(base, v, 'bin', 'tsc');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return `${BUN}x tsc`;
}
const TSC = process.env.BENCH_TSC || resolveTsc();

const MODELS = (process.argv.slice(2).length ? process.argv.slice(2) : ['ornith-1.0-35b'])
  .map(id => ({ id, short: id }));

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// ---- oracle helpers ----
// Normalize Unicode "confusables" that LLMs occasionally emit inside code (typographic
// dashes/quotes, real MINUS SIGN, non-breaking space). NONE are valid TS syntax, so this
// can only rescue code whose LOGIC was correct but whose typography was off — it can never
// turn wrong code into right code. Applied uniformly to every model, so it is fair; it lets
// the benchmark measure algorithmic ability rather than tokenizer noise. (Our tasks/tests
// are pure ASCII, so this never alters an intentionally-Unicode string literal.)
function normalizeConfusables(s) {
  return s
    .replace(/[‐‑‒–—―−]/g, '-')   // ‐ ‑ ‒ – — ― − -> hyphen-minus
    .replace(/[‘’‛′]/g, "'")                     // ‘ ’ ‛ ′ -> '
    .replace(/[“”‟″]/g, '"')                     // “ ” ‟ ″ -> "
    .replace(/ /g, ' ');                                        // NBSP -> space
}
function extractCode(text) {
  if (!text) return '';
  const fence = text.match(/```(?:ts|typescript)?\s*\n([\s\S]*?)```/);
  return normalizeConfusables((fence ? fence[1] : text).trim());
}

// Some local models (notably Qwen3-Coder) emit tool calls in their NATIVE textual format
// rather than the OpenAI `tool_calls` field — and LM Studio can route that text into
// reasoning_content, leaving `tool_calls` empty. To measure the MODEL's true agentic
// ability (not LM Studio's tool-parser), we recover those calls from the text. Two formats:
//   1) Qwen-Coder XML:  <function=NAME><parameter=P>VALUE</parameter>...</function>
//   2) Hermes/Qwen JSON: <tool_call>{"name":"NAME","arguments":{...}}</tool_call>
// Synthesized calls get the exact shape of OpenAI tool_calls so the loop stays format-agnostic.
function parseNativeToolCalls(text, step) {
  if (!text) return [];
  const out = [];
  // format 1 — Qwen-Coder XML function/parameter blocks
  const fnRe = /<function=([\w.\-]+)>([\s\S]*?)<\/function>/g;
  let m;
  while ((m = fnRe.exec(text)) !== null) {
    const name = m[1]; const argsObj = {};
    const pRe = /<parameter=([\w.\-]+)>\s*([\s\S]*?)\s*<\/parameter>/g;
    let pm;
    while ((pm = pRe.exec(m[2])) !== null) argsObj[pm[1]] = pm[2];
    out.push({ id: `call_${step}_${out.length}`, type: 'function', function: { name, arguments: JSON.stringify(argsObj) } });
  }
  if (out.length) return out;
  // format 2 — JSON payload inside <tool_call> ... </tool_call>
  const jsonRe = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  while ((m = jsonRe.exec(text)) !== null) {
    try {
      const j = JSON.parse(m[1]);
      if (j && j.name) out.push({ id: `call_${step}_${out.length}`, type: 'function', function: { name: j.name, arguments: JSON.stringify(j.arguments || {}) } });
    } catch (_) {}
  }
  return out;
}
// SECURITY: every `cmd` here is a hardcoded literal (tsc / bun test with fixed flags).
// No model/user input is interpolated into the shell string — the model's code lands
// ONLY in lib.ts (a file), executed by `bun test` inside an ephemeral temp dir under a
// `timeout` guard. opengrep exec flag acknowledged & justified (mirror of run-rust.mjs).
// BENCH_SHELL forces a specific shell (git-bash on Windows) so the sh-style `cmd 2>&1`
// and PATH resolution behave consistently. Unset => node's platform default.
const BENCH_SHELL = process.env.BENCH_SHELL || undefined;
function run(cmd, cwd, timeoutMs) {
  try { return { code: 0, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, shell: BENCH_SHELL }) }; }
  catch (e) { return { code: e.status == null ? 124 : e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}
const task = key => TASKS.find(t => t.key === key);

// Set up a temp project (lib.ts + tsconfig + a chosen test file) and return its dir.
function makeProject(t, libSrc, testFileName, testSrc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tsb_${t.key}_`));
  fs.writeFileSync(path.join(dir, 'lib.ts'), libSrc || '// empty\n');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), t.tsconfig);
  fs.writeFileSync(path.join(dir, testFileName), testSrc);
  return dir;
}
// tsc --strict gate: typechecks iff exit 0 AND no "error TS####" in output.
function typecheck(dir) {
  const r = run(`${TSC} -p tsconfig.json 2>&1`, dir, 60000);
  const errs = (r.out.match(/error TS\d+/g) || []).length;
  return { typechecks: r.code === 0 && errs === 0, tsErrors: errs, note: r.code === 124 ? 'tsc_timeout' : '' };
}
// Run one test file with `bun test`, parse "N pass" / "N fail".
function bunTest(dir, testFile, timeoutMs = 60000) {
  const r = run(`${BUN} test ${testFile} 2>&1`, dir, timeoutMs);
  const pm = r.out.match(/(\d+)\s+pass/); const fm = r.out.match(/(\d+)\s+fail/);
  const passed = pm ? +pm[1] : 0; const failed = fm ? +fm[1] : 0;
  const timeout = r.code === 124;
  return { passed, failed, total: passed + failed, timeout, allGreen: passed > 0 && failed === 0, out: r.out };
}

// Full grade for a candidate lib.ts against the HIDDEN suite.
function evalModule(taskKey, libSrc) {
  const t = task(taskKey);
  const dir = makeProject(t, libSrc, 'hidden.test.ts', t.hidden);
  try {
    const tc = typecheck(dir);
    const bt = bunTest(dir, 'hidden.test.ts');
    const total = bt.total || t.hiddenCount;
    let note = tc.note || (bt.timeout ? 'test_timeout' : '');
    if (!bt.total && !bt.timeout) note = note || 'no_tests_ran'; // import/parse failure
    return {
      typechecks: tc.typechecks, tsErrors: tc.tsErrors,
      passed: bt.passed, total, pct: total ? +(bt.passed / total).toFixed(3) : 0, note,
    };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
}

// ---- single-shot (streaming for TTFT/tok-s) ----
async function runSingle(model, taskKey, runIdx) {
  const t = task(taskKey);
  const res = await chat({
    model: model.id, max_tokens: 40000, stream: true,
    messages: [
      { role: 'system', content: 'You are an expert TypeScript engineer. Output only correct, idiomatic, strictly-typed TypeScript.' },
      { role: 'user', content: t.spec },
    ],
  });
  if (!res.ok) return { model: model.short, task: taskKey, mode: 'single', run: runIdx, ok: false, error: res.error, timeout: !!res.timeout };
  const code = extractCode(res.content || '');
  const ev = evalModule(taskKey, code);
  return {
    model: model.short, task: taskKey, mode: 'single', run: runIdx, ok: true,
    typechecks: ev.typechecks, tsErrors: ev.tsErrors,
    passed: ev.passed, total: ev.total, pct: ev.pct, note: ev.note, finish: res.finish,
    tokIn: res.usage.prompt, tokOut: res.usage.completion, reasonTok: res.usage.reasoning,
    latency: res.total, ttft: res.ttft, tokps: res.tokps, codeLen: code.length, cost: res.cost || 0,
  };
}

// ---- agentic (tool-loop, non-streaming) with tool-fidelity instrumentation ----
const TOOLS = [
  { type: 'function', function: { name: 'write_lib', description: 'Write the full contents of lib.ts.',
    parameters: { type: 'object', properties: { content: { type: 'string', description: 'Full TypeScript source for lib.ts' } }, required: ['content'] } } },
  { type: 'function', function: { name: 'run_tests', description: 'Type-check and run the example test suite; returns tsc + bun test output.',
    parameters: { type: 'object', properties: {} } } },
];

async function runAgentic(model, taskKey, runIdx, maxSteps = 5) {
  const t = task(taskKey);
  const dir = makeProject(t, '// implement here\n', 'visible.test.ts', t.visible);
  const messages = [
    { role: 'system', content: 'You are an expert TypeScript engineer working in a project. Implement lib.ts to satisfy the spec and make the example tests pass. Use write_lib to save your code, then run_tests to check. Iterate until the tests pass. Standard library only, no external packages, and keep it strictly typed.' },
    { role: 'user', content: t.spec + '\n\nThe project already contains example tests in visible.test.ts. Write lib.ts, then run the tests, and fix any failures.' },
  ];

  // Fidelity metrics: did the model actually drive the tools well?
  //   toolTurns   — assistant turns that requested >=1 tool call
  //   validCalls / totalCalls — schema-valid tool calls vs all emitted
  //   sawRed      — a run_tests came back NOT green at least once
  //   stepsToGreen— step index at which visible tests first went green (null if never)
  //   wasteSteps  — steps taken after green was first reached
  let steps = 0, visibleGreen = false, err = null, reasonTok = 0, totalTime = 0;
  let toolTurns = 0, validCalls = 0, totalCalls = 0, sawRed = false, stepsToGreen = null, wasteSteps = 0;
  try {
    for (let step = 0; step < maxSteps; step++) {
      const res = await chat({ model: model.id, max_tokens: 40000, tools: TOOLS, tool_choice: 'required', messages });
      if (!res.ok) { err = res.error; break; }
      reasonTok += res.usage.reasoning; totalTime += res.total; steps++;
      if (visibleGreen) wasteSteps++;              // any step after first green is wasted work
      let calls = res.tool_calls || [];
      // Recover native-format tool calls (Qwen-Coder XML etc.) that LM Studio failed to
      // parse into tool_calls — so a model isn't penalized for its runtime's parser gap.
      if (!calls.length) {
        const native = parseNativeToolCalls(`${res.content || ''}\n${res.reasoning || ''}`, step);
        if (native.length) calls = native;
      }
      messages.push({ role: 'assistant', content: res.content || '', tool_calls: calls.length ? calls : undefined });
      if (calls.length) toolTurns++;
      if (!calls.length) {
        // No tool call: model tried to answer in prose. Salvage code from the message
        // (counts as a fidelity miss — it did NOT use the provided tools).
        const code = extractCode(res.content || '');
        if (code && /export\s+(function|class|const|type)/.test(code)) fs.writeFileSync(path.join(dir, 'lib.ts'), code);
        break;
      }
      for (const c of calls) {
        totalCalls++;
        let result = '';
        if (c.function?.name === 'write_lib') {
          let content = null;
          try { content = JSON.parse(c.function.arguments).content; } catch (_) { content = null; }
          if (typeof content === 'string') {
            validCalls++;
            content = extractCode(content);
            fs.writeFileSync(path.join(dir, 'lib.ts'), content || '// empty\n');
            result = 'lib.ts written (' + content.length + ' bytes).';
          } else {
            result = 'ERROR: write_lib requires a string "content" argument.'; // malformed call
          }
        } else if (c.function?.name === 'run_tests') {
          validCalls++;
          const tc = typecheck(dir);
          const bt = bunTest(dir, 'visible.test.ts');
          if (!bt.allGreen) sawRed = true;
          if (bt.allGreen && !visibleGreen) { visibleGreen = true; stepsToGreen = steps; }
          result = `tsc: ${tc.typechecks ? 'OK' : tc.tsErrors + ' type error(s)'}\nbun test: ${bt.passed} pass / ${bt.failed} fail\n` + bt.out.slice(-1800);
        } else {
          result = 'unknown tool'; // hallucinated a nonexistent tool = fidelity miss
        }
        messages.push({ role: 'tool', tool_call_id: c.id, content: result });
      }
      if (visibleGreen) break;
    }
    const curLib = fs.readFileSync(path.join(dir, 'lib.ts'), 'utf8');
    const ev = evalModule(taskKey, curLib);
    // recovered = it hit a red test result and still finished green (real fix-the-build loop)
    const recovered = sawRed && ev.pct >= 0.999;
    return {
      model: model.short, task: taskKey, mode: 'agentic', run: runIdx, ok: true,
      typechecks: ev.typechecks, passed: ev.passed, total: ev.total, pct: ev.pct, note: ev.note,
      steps, visibleGreen, reasonTok, latency: +totalTime.toFixed(1), err,
      toolTurns, validCalls, totalCalls,
      toolValidPct: totalCalls ? +(validCalls / totalCalls).toFixed(2) : 0,
      stepsToGreen, wasteSteps, recovered,
    };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
}

// ---- driver: one model fully before the next; crash-safe + resumable ----
const TASK_KEYS = ['expr', 'lru', 'asyncpool'];
const outPath = process.env.OUT
  ? (path.isAbsolute(process.env.OUT) ? process.env.OUT : path.join(__dirname, '..', 'results', process.env.OUT))
  : path.join(__dirname, '..', 'results', 'results-ts-aw.json');

let records = [];
if (fs.existsSync(outPath)) { try { records = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (_) { records = []; } }
const doneSingle = new Set(records.filter(r => r.mode === 'single' && r.ok).map(r => `${r.model}|${r.task}|${r.run}`));
const doneAgentic = new Set(records.filter(r => r.mode === 'agentic' && r.ok).map(r => `${r.model}|${r.task}`));
const save = () => fs.writeFileSync(outPath, JSON.stringify(records, null, 1));

log(`TSC=${TSC}`);
for (const model of MODELS) {
  log(`\n===== MODEL ${model.id} =====`);
  let timedOut = false;
  for (const tk of TASK_KEYS) {
    for (let r = 1; r <= 2; r++) {
      if (doneSingle.has(`${model.id}|${tk}|${r}`)) { log(`single ${tk} run${r}: (skip, done)`); continue; }
      if (timedOut) { records.push({ model: model.short, task: tk, mode: 'single', run: r, ok: false, error: 'skipped_after_timeout' }); save(); continue; }
      const rec = await runSingle(model, tk, r);
      log(`single ${tk} run${r}: ${rec.ok ? `${rec.passed}/${rec.total} (${Math.round(rec.pct*100)}%) tsc=${rec.typechecks} ${rec.latency}s ttft=${rec.ttft} tok/s=${rec.tokps} reason=${rec.reasonTok} finish=${rec.finish}` : 'ERR ' + rec.error}`);
      records.push(rec); save();
      if (rec.timeout) { timedOut = true; log(`  -> ${model.id} TIMED OUT — skipping its remaining tasks`); }
    }
  }
  for (const tk of TASK_KEYS) {
    if (doneAgentic.has(`${model.id}|${tk}`)) { log(`agentic ${tk}: (skip, done)`); continue; }
    if (timedOut) { records.push({ model: model.short, task: tk, mode: 'agentic', run: 1, ok: false, error: 'skipped_after_timeout' }); save(); continue; }
    const rec = await runAgentic(model, tk, 1);
    log(`agentic ${tk}: ${rec.ok ? `${rec.passed}/${rec.total} (${Math.round(rec.pct*100)}%) tsc=${rec.typechecks} steps=${rec.steps} green=${rec.visibleGreen} toolValid=${rec.toolValidPct} recovered=${rec.recovered} ${rec.latency}s` : 'ERR ' + rec.error}`);
    records.push(rec); save();
  }
}
log(`\nDONE ${outPath} (${records.length} records)`);
