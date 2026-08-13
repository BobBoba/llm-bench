// RUST code-gen benchmark for LOCAL LM Studio models.
// Faithful port of /code/src/zdr-rust-codegen-bench/bench.js: same tasks, same hidden
// test suites, same cargo oracle, same single-shot(×2)+agentic(×1) protocol.
// Only the model client differs (LM Studio instead of OpenRouter).
//
// Usage: node run-rust.mjs [model1 model2 ...]   (default: both ornith models)
// Writes results/results-ornith-rust.json

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
// Client switchable via LLM_CLIENT: openrouter -> cloud, claudecode -> `claude -p` (subscription),
// default = local LM Studio.
const CLIENT_MAP = { openrouter: './openrouter-client.mjs', claudecode: './claudecode-client.mjs', morph: './morph-client.mjs' };
const { chat } = await import(CLIENT_MAP[process.env.LLM_CLIENT] || './lmstudio-client.mjs');

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { TASKS } = require('./tasks-rust.js');

const HOME = process.env.HOME;
// BENCH_CARGO_ENV lets a caller override the env prefix (set to '' on Windows, where the
// default rustup CARGO_HOME/RUSTUP_HOME already apply and msys-style paths would confuse cargo.exe).
const CARGO_ENV = process.env.BENCH_CARGO_ENV ?? `CARGO_HOME=${HOME}/.cargo RUSTUP_HOME=${HOME}/.rustup`;

const MODELS = (process.argv.slice(2).length ? process.argv.slice(2) : ['ornith-1.0-9b', 'ornith-1.0-35b'])
  .map(id => ({ id, short: id }));

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// ---- oracle helpers (identical semantics to the original harness) ----
function extractCode(text) {
  if (!text) return '';
  const fence = text.match(/```(?:rust|rs)?\s*\n([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  return text.trim();
}
// SECURITY: every `cmd` passed here is a hardcoded literal (cargo build/test/clippy +
// fixed CARGO_ENV from $HOME). No model/user input is interpolated into the command
// string — model-generated code only ever lands in src/lib.rs (a file), never the shell.
// The model's code IS executed by `cargo test`, but only in an ephemeral temp crate,
// --offline, under a `timeout` guard. opengrep flag acknowledged & justified.
// BENCH_SHELL forces a specific shell for execSync (e.g. git-bash on Windows, so the sh-style
// `VAR=x cmd 2>&1` and coreutils `timeout` used below work). Unset => node's platform default (/bin/sh on Linux).
const BENCH_SHELL = process.env.BENCH_SHELL || undefined;
function run(cmd, cwd, timeoutMs) {
  try { return { code: 0, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, shell: BENCH_SHELL }) }; }
  catch (e) { return { code: e.status == null ? 124 : e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}
const task = key => TASKS.find(t => t.key === key);

function evalCrate(taskKey, libSrc, withClippy) {
  const t = task(taskKey);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zb_${taskKey}_`));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), t.cargoToml);
    fs.writeFileSync(path.join(dir, 'src', 'lib.rs'), libSrc || '// empty\n');
    fs.writeFileSync(path.join(dir, 'tests', 'hidden.rs'), t.hidden);
    const b = run(`${CARGO_ENV} cargo build --offline --lib 2>&1`, dir, 90000);
    const compiles = b.code === 0;
    let passed = 0, total = t.hiddenCount, note = '';
    const tr = run(`${CARGO_ENV} timeout --kill-after=5 75 cargo test --offline --test hidden 2>&1`, dir, 90000);
    const m = tr.out.match(/test result:\s*\w+\.\s*(\d+)\s+passed;\s*(\d+)\s+failed/);
    if (m) { passed = +m[1]; total = +m[1] + +m[2]; }
    else if (tr.code === 124) { note = 'timeout'; }
    else if (!compiles) { note = 'lib_compile_fail'; }
    else { note = 'test_compile_fail'; }
    let clippy = null;
    if (withClippy && compiles) {
      const c = run(`${CARGO_ENV} cargo clippy --offline --lib 2>&1`, dir, 90000);
      const cm = c.out.match(/generated (\d+) warning/);
      clippy = cm ? +cm[1] : (c.out.match(/^warning:/gm) || []).length;
    }
    return { compiles, passed, total, clippy, note };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
}

// ---- single-shot (streaming for TTFT/tok-s) ----
async function runSingle(model, taskKey, runIdx) {
  const t = task(taskKey);
  const res = await chat({
    model: model.id, max_tokens: 40000, stream: true,
    messages: [
      { role: 'system', content: 'You are an expert Rust engineer. Output only correct, idiomatic Rust.' },
      { role: 'user', content: t.spec },
    ],
  });
  if (!res.ok) return { model: model.short, task: taskKey, mode: 'single', run: runIdx, ok: false, error: res.error, timeout: !!res.timeout };
  const code = extractCode(res.content || '');
  const ev = evalCrate(taskKey, code, true);
  return {
    model: model.short, task: taskKey, mode: 'single', run: runIdx, ok: true,
    compiles: ev.compiles, passed: ev.passed, total: ev.total, pct: ev.total ? +(ev.passed / ev.total).toFixed(3) : 0,
    clippy: ev.clippy, note: ev.note, finish: res.finish,
    tokIn: res.usage.prompt, tokOut: res.usage.completion, reasonTok: res.usage.reasoning,
    latency: res.total, ttft: res.ttft, tokps: res.tokps, codeLen: code.length, cost: res.cost || 0,
  };
}

// ---- agentic (tool-loop, non-streaming) ----
const TOOLS = [
  { type: 'function', function: { name: 'write_lib', description: 'Write the full contents of src/lib.rs.',
    parameters: { type: 'object', properties: { content: { type: 'string', description: 'Full Rust source for src/lib.rs' } }, required: ['content'] } } },
  { type: 'function', function: { name: 'run_tests', description: 'Compile and run the example test suite, returns compiler/test output.',
    parameters: { type: 'object', properties: {} } } },
];

async function runAgentic(model, taskKey, runIdx, maxSteps = 5) {
  const t = task(taskKey);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zba_${taskKey}_`));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), t.cargoToml);
  fs.writeFileSync(path.join(dir, 'src', 'lib.rs'), '// implement here\n');
  fs.writeFileSync(path.join(dir, 'tests', 'visible.rs'), t.visible);

  const messages = [
    { role: 'system', content: 'You are an expert Rust engineer working in a crate. Implement src/lib.rs to satisfy the spec and make the example tests pass. Use write_lib to save your code, then run_tests to check. Iterate until tests pass. Standard library only.' },
    { role: 'user', content: t.spec + '\n\nThe crate already contains example tests in tests/visible.rs. Write src/lib.rs, then run the tests, and fix any failures.' },
  ];

  // ! Accumulate cost + tokens across ALL steps — earlier this loop dropped res.cost, so agentic
  // rows showed $0 even though the runs happened (single-shot captured cost, agentic did not).
  let steps = 0, visibleGreen = false, err = null, reasonTok = 0, totalTime = 0;
  let cost = 0, tokIn = 0, tokOut = 0;
  try {
    for (let step = 0; step < maxSteps; step++) {
      const res = await chat({ model: model.id, max_tokens: 40000, tools: TOOLS, tool_choice: 'auto', messages });
      if (!res.ok) { err = res.error; break; }
      reasonTok += res.usage.reasoning; totalTime += res.total; steps++;
      cost += res.cost || 0; tokIn += res.usage.prompt || 0; tokOut += res.usage.completion || 0;
      const calls = res.tool_calls || [];
      messages.push({ role: 'assistant', content: res.content || '', tool_calls: calls.length ? calls : undefined });
      if (!calls.length) {
        const code = extractCode(res.content || '');
        if (code && /pub\s+(fn|struct|enum)/.test(code)) fs.writeFileSync(path.join(dir, 'src', 'lib.rs'), code);
        break;
      }
      for (const c of calls) {
        let result = '';
        if (c.function?.name === 'write_lib') {
          let content = ''; try { content = JSON.parse(c.function.arguments).content || ''; } catch (_) { content = ''; }
          content = extractCode(content);
          fs.writeFileSync(path.join(dir, 'src', 'lib.rs'), content || '// empty\n');
          result = 'src/lib.rs written (' + content.length + ' bytes).';
        } else if (c.function?.name === 'run_tests') {
          const tr = run(`${CARGO_ENV} timeout --kill-after=5 60 cargo test --offline --test visible 2>&1`, dir, 75000);
          visibleGreen = /test result:\s*ok\./.test(tr.out) && !/0 passed/.test(tr.out);
          result = tr.out.slice(-2500);
        } else { result = 'unknown tool'; }
        messages.push({ role: 'tool', tool_call_id: c.id, content: result });
      }
      if (visibleGreen) break;
    }
    const curLib = fs.readFileSync(path.join(dir, 'src', 'lib.rs'), 'utf8');
    const ev = evalCrate(taskKey, curLib, false);
    return {
      model: model.short, task: taskKey, mode: 'agentic', run: runIdx, ok: true,
      compiles: ev.compiles, passed: ev.passed, total: ev.total, pct: ev.total ? +(ev.passed / ev.total).toFixed(3) : 0,
      note: ev.note, steps, visibleGreen, reasonTok, tokIn, tokOut, latency: +totalTime.toFixed(1),
      cost: +cost.toFixed(6), err,
    };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
}

// ---- driver: one model fully before the next (avoids LM Studio model swaps) ----
// Robust for long unattended runs: writes after EVERY record (crash-safe) and is
// RESUMABLE — re-running skips units (model+mode+task+run) already present in OUT.
const TASK_KEYS = ['expr', 'lru', 'wordcount'];
const outPath = process.env.OUT
  ? (path.isAbsolute(process.env.OUT) ? process.env.OUT : path.join(__dirname, 'results', process.env.OUT))
  : path.join(__dirname, 'results', 'results-ornith-rust.json');

let records = [];
if (fs.existsSync(outPath)) { try { records = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (_) { records = []; } }
const doneSingle = new Set(records.filter(r => r.mode === 'single' && r.ok).map(r => `${r.model}|${r.task}|${r.run}`));
const doneAgentic = new Set(records.filter(r => r.mode === 'agentic' && r.ok).map(r => `${r.model}|${r.task}|${r.run ?? 1}`));

// * Число повторов настраивается, чтобы можно было ДОБРАТЬ выборку, не переделывая уже
// сделанное: ключи дедупликации включают номер прогона, поэтому повторный запуск с бо́льшим
// значением выполнит только недостающие индексы. Дефолты равны прежнему поведению (2 и 1),
// так что для всех существующих вызовов ничего не меняется.
// Понадобилось в кампании по квантам [[02.08.2026]]: на 9 записях доля пройденных тестов
// имеет разброс в десятки пунктов, и соседние кванты в нём неразличимы.
const SINGLE_RUNS = Number(process.env.SINGLE_RUNS || 2);
const AGENTIC_RUNS = Number(process.env.AGENTIC_RUNS || 1);
const save = () => fs.writeFileSync(outPath, JSON.stringify(records, null, 1));

// A model whose call exceeds the 20-min deadline is recorded as timed-out and its
// remaining tasks are SKIPPED — it is unbenchmarkable at the current LM Studio offload
// config, and grinding 9 timeouts × 20 min serves nobody. The skip is itself a finding.
for (const model of MODELS) {
  log(`\n===== MODEL ${model.id} =====`);
  let timedOut = false;
  for (const tk of TASK_KEYS) {
    for (let r = 1; r <= SINGLE_RUNS; r++) {
      if (doneSingle.has(`${model.id}|${tk}|${r}`)) { log(`single ${tk} run${r}: (skip, done)`); continue; }
      if (timedOut) { records.push({ model: model.short, task: tk, mode: 'single', run: r, ok: false, error: 'skipped_after_timeout' }); save(); continue; }
      const rec = await runSingle(model, tk, r);
      log(`single ${tk} run${r}: ${rec.ok ? `${rec.passed}/${rec.total} (${Math.round(rec.pct*100)}%) compiles=${rec.compiles} ${rec.latency}s ttft=${rec.ttft} tok/s=${rec.tokps} reason=${rec.reasonTok} finish=${rec.finish}` : 'ERR ' + rec.error}`);
      records.push(rec); save();
      if (rec.timeout) { timedOut = true; log(`  -> ${model.id} TIMED OUT — skipping its remaining tasks`); }
    }
  }
  for (const tk of TASK_KEYS) {
    for (let r = 1; r <= AGENTIC_RUNS; r++) {
      if (doneAgentic.has(`${model.id}|${tk}|${r}`)) { log(`agentic ${tk} run${r}: (skip, done)`); continue; }
      if (timedOut) { records.push({ model: model.short, task: tk, mode: 'agentic', run: r, ok: false, error: 'skipped_after_timeout' }); save(); continue; }
      const rec = await runAgentic(model, tk, r);
      log(`agentic ${tk} run${r}: ${rec.ok ? `${rec.passed}/${rec.total} (${Math.round(rec.pct*100)}%) steps=${rec.steps} green=${rec.visibleGreen} ${rec.latency}s` : 'ERR ' + rec.error}`);
      records.push(rec); save();
    }
  }
}
log(`\nDONE ${outPath} (${records.length} records)`);
