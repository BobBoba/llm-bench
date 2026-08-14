// Раннер кампании ТЯЖЁЛЫХ задач (hard0804): 3 языка × (edit, edit-long, algo, conc) = 12 задач,
// одношот со стримингом. Цель кампании — «рабочая лошадь» для повседневного кода: время до
// решения и стоимость по каждому языку, плюс расхождение local vs cloud на длинном контексте
// (контролируемая пара edit / edit-long, см. tasks-hard-long.js).
//
// Использование: node run-hard.mjs model1 [model2 ...]
//   LLM_CLIENT=openrouter — облако (иначе локальный LM Studio / Unsloth Studio);
//   OUT=results-hard-<группа>.json — файл результатов (crash-safe, резюмируемый);
//   SINGLE_RUNS=N — повторов на задачу (по умолчанию 1: 12 задач на модель уже дают выборку).
//
// Оракулы (те же, что при валидации эталонов [[04.08.2026]]):
//   rust  — временный crate, `cargo build` + `cargo test --test hidden`, СУММА всех строк
//           `test result:` (юнит-тесты в lib.rs дали бы вторую строку — считаем только hidden);
//   ts    — два независимых гейта: `tsc --strict` (типы) и `bun test` (скрытые тесты);
//   julia — скрипт со скрытыми проверками печатает `BENCH_RESULT passed=N total=M`.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const CLIENT_MAP = { openrouter: '../clients/openrouter-client.mjs', claudecode: '../clients/claudecode-client.mjs' };
const { chat } = await import(CLIENT_MAP[process.env.LLM_CLIENT] || '../clients/llama-server-client.mjs');

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { ALL } = require('../tasks/tasks-hard-long.js');

const HOME = process.env.HOME;
const CARGO_ENV = process.env.BENCH_CARGO_ENV ?? `CARGO_HOME=${HOME}/.cargo RUSTUP_HOME=${HOME}/.rustup`;
// * Бинарники: env-переопределение → типовые пользовательские места → PATH. execSync ходит
//   через /bin/sh, чей PATH обычно НЕ содержит nvm/bun/juliaup (проверено: голый default
//   'tsc' валит весь TS-гейт как tsc_fail) — прямой поиск закрывает и интерактивный запуск,
//   и nohup/cron. Для нестандартных мест — TSC_BIN / BUN_BIN / JULIA_BIN / PWSH_BIN.
function firstExisting(cands, fallback) {
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch (_) {} }
  return fallback;
}
function nvmBin(name) {
  const base = `${HOME}/.nvm/versions/node`;
  try { return fs.readdirSync(base).map(v => `${base}/${v}/bin/${name}`).filter(p => fs.existsSync(p)).pop(); }
  catch (_) { return null; }
}
const TSC = process.env.TSC_BIN || firstExisting([nvmBin('tsc'), `${HOME}/.local/bin/tsc`, '/usr/bin/tsc'], 'tsc');
const BUN = process.env.BUN_BIN || firstExisting([`${HOME}/.bun/bin/bun`, '/usr/bin/bun'], 'bun');
const JULIA = process.env.JULIA_BIN || firstExisting([`${HOME}/.juliaup/bin/julia`, '/usr/bin/julia'], 'julia');

const SELFTEST = process.argv.includes('--selftest');
const MODELS = process.argv.slice(2).filter(a => a !== '--selftest').map(id => ({ id, short: id }));
if (!MODELS.length && !SELFTEST) { console.error('usage: node run-hard.mjs [--selftest] <model> [model ...]'); process.exit(2); }

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// SECURITY: как и в run-rust.mjs — команды здесь только литеральные (cargo/tsc/bun/julia с
// фиксированными путями); код модели попадает исключительно в файлы временного каталога и
// исполняется тест-раннером под `timeout`, в командную строку он не интерполируется.
const BENCH_SHELL = process.env.BENCH_SHELL || undefined;
function run(cmd, cwd, timeoutMs) {
  try { return { code: 0, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, shell: BENCH_SHELL }) }; }
  catch (e) { return { code: e.status == null ? 124 : e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}

// ---- извлечение кода из ответа ----
// Берём САМЫЙ ДЛИННЫЙ блок нужного языка: на edit-long модели часто сначала показывают
// найденный дефект коротким фрагментом и только потом полный файл — первый блок был бы ложным.
const FENCE_RE = {
  rust: /```(?:rust|rs)?\s*\n([\s\S]*?)```/g,
  ts: /```(?:ts|typescript|tsx)?\s*\n([\s\S]*?)```/g,
  julia: /```(?:julia|jl)?\s*\n([\s\S]*?)```/g,
  csharp: /```(?:csharp|cs|c#)?\s*\n([\s\S]*?)```/g,
  bash: /```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/g,
  pwsh: /```(?:powershell|pwsh|ps1?)?\s*\n([\s\S]*?)```/g,
};
// ! Модель может ответить В ФОРМАТЕ САМОГО ДАМПА — первой строкой `===== ФАЙЛ: lib.jl =====`
//   и без markdown-ограждения (наблюдалось у Qwen3-Coder-Next на julia/edit-long: короткий
//   edit решён на 100%, длинный падал «с первой строки» у ОБОИХ квантов). Спецификация
//   ограждения не требует, поэтому такой ответ легитимен и заголовок дампа просто снимается.
function stripDumpHeader(s) {
  return s.replace(/^\s*={3,}\s*ФАЙЛ:[^\n]*\n/, '').trim();
}
function extractCode(text, lang) {
  if (!text) return '';
  const blocks = [...text.matchAll(FENCE_RE[lang])].map(m => m[1].trim());
  if (!blocks.length) return stripDumpHeader(text);
  return stripDumpHeader(blocks.reduce((a, b) => (b.length > a.length ? b : a), ''));
}

// ---- оракулы ----
function evalRust(t, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hard_rs_`));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), t.cargoToml);
    fs.writeFileSync(path.join(dir, 'src', 'lib.rs'), code || '// empty\n');
    fs.writeFileSync(path.join(dir, 'tests', 'hidden.rs'), t.hidden);
    const b = run(`${CARGO_ENV} cargo build --offline --lib 2>&1`, dir, 120000);
    const gate = b.code === 0;
    let passed = 0, total = (t.hidden.match(/#\[test\]/g) || []).length, note = '';
    const tr = run(`${CARGO_ENV} timeout --kill-after=5 90 cargo test --offline --test hidden 2>&1`, dir, 120000);
    // * Суммируем ВСЕ строки `test result:` — урок валидации: юнит-тесты внутри lib.rs модели
    //   добавляют вторую строку, и разбор только первой занижал результат.
    const ms = [...tr.out.matchAll(/test result:\s*\w+\.\s*(\d+)\s+passed;\s*(\d+)\s+failed/g)];
    if (ms.length) { passed = ms.reduce((s, m) => s + +m[1], 0); total = ms.reduce((s, m) => s + +m[1] + +m[2], 0); }
    else if (tr.code === 124) note = 'timeout';
    else note = gate ? 'test_compile_fail' : 'lib_compile_fail';
    return { gate, passed, total, note };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
}

function evalTs(t, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hard_ts_`));
  try {
    fs.writeFileSync(path.join(dir, 'lib.ts'), code || '// empty\n');
    fs.writeFileSync(path.join(dir, 'hidden.test.ts'), t.hidden);
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), t.tsconfig);
    const tc = run(`${TSC} -p tsconfig.json 2>&1`, dir, 90000);
    const gate = tc.code === 0;
    let passed = 0, total = (t.hidden.match(/^test\(/gm) || []).length, note = gate ? '' : 'tsc_fail';
    const tr = run(`timeout --kill-after=5 120 ${BUN} test hidden.test.ts 2>&1`, dir, 150000);
    const p = tr.out.match(/(\d+)\s+pass/), f = tr.out.match(/(\d+)\s+fail/);
    if (p || f) { passed = p ? +p[1] : 0; total = (p ? +p[1] : 0) + (f ? +f[1] : 0); }
    else if (tr.code === 124) note = (note ? note + '+' : '') + 'timeout';
    else note = (note ? note + '+' : '') + 'bun_crash';
    return { gate, passed, total, note };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
}

function evalJulia(t, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hard_jl_`));
  try {
    fs.writeFileSync(path.join(dir, 'lib.jl'), code || '# empty\n');
    fs.writeFileSync(path.join(dir, 'hidden.jl'), t.hidden);
    const threads = t.threads || 1;
    const tr = run(`timeout --kill-after=5 150 ${JULIA} --startup-file=no -t ${threads} hidden.jl 2>&1`, dir, 180000);
    let passed = 0, total = (t.hidden.match(/\(\)\s*->/g) || []).length, note = '';
    const m = tr.out.match(/BENCH_RESULT passed=(\d+) total=(\d+)/);
    // gate для Julia = «lib.jl хотя бы загрузился»: include() падает до BENCH_RESULT.
    const gate = !!m;
    if (m) { passed = +m[1]; total = +m[2]; }
    else if (tr.code === 124) note = 'timeout';
    else note = 'load_fail: ' + tr.out.slice(-200).replace(/\s+/g, ' ');
    return { gate, passed, total, note };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
}

function evalCsharp(t, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hard_cs_`));
  try {
    fs.writeFileSync(path.join(dir, 'proj.csproj'), t.csproj);
    fs.writeFileSync(path.join(dir, 'Lib.cs'), code || '// empty\n');
    fs.writeFileSync(path.join(dir, 'Program.cs'), t.hidden);
    // Один вызов: dotnet run сам собирает; ошибки сборки отличаем по "error CS" в выводе.
    const tr = run(`timeout --kill-after=10 150 dotnet run 2>&1`, dir, 180000);
    let passed = 0, total = (t.hidden.match(/checks\.Add\(/g) || []).length, note = '';
    const m = tr.out.match(/BENCH_RESULT passed=(\d+) total=(\d+)/);
    const gate = !!m;
    if (m) { passed = +m[1]; total = +m[2]; }
    else if (tr.code === 124) note = 'timeout';
    else if (/error CS\d+/.test(tr.out)) note = 'compile_fail';
    else note = 'run_fail: ' + tr.out.slice(-200).replace(/\s+/g, ' ');
    return { gate, passed, total, note };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
}

function evalBash(t, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hard_sh_`));
  try {
    fs.writeFileSync(path.join(dir, 'lib.sh'), code || '# empty\n');
    fs.writeFileSync(path.join(dir, 'hidden.sh'), t.hidden);
    const tr = run(`timeout --kill-after=5 120 bash hidden.sh 2>&1`, dir, 150000);
    let passed = 0, total = (t.hidden.match(/^check /gm) || []).length, note = '';
    const m = tr.out.match(/BENCH_RESULT passed=(\d+) total=(\d+)/);
    const gate = !!m;
    if (m) { passed = +m[1]; total = +m[2]; }
    else if (tr.code === 124) note = 'timeout';
    else note = 'run_fail: ' + tr.out.slice(-200).replace(/\s+/g, ' ');
    return { gate, passed, total, note };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
}

const PWSH = process.env.PWSH_BIN || firstExisting([`${HOME}/.dotnet/tools/pwsh`, '/usr/bin/pwsh'], 'pwsh');
function evalPwsh(t, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hard_ps_`));
  try {
    // ! Модели по привычке заканчивают файл строкой `Export-ModuleMember ...` — она законна
    //   в .psm1-модуле, но при дот-сорсинге .ps1 бросает исключение. Дот-сорсинг — деталь
    //   нашей обвязки, а не часть задачи, поэтому строку снимаем (найдено пилотом hard0804b:
    //   обе задачи gpt-oss-120b падали load_fail именно на ней).
    const cleaned = (code || '').replace(/^\s*Export-ModuleMember\b.*$/gm, '');
    fs.writeFileSync(path.join(dir, 'Lib.ps1'), cleaned || '# empty\n');
    fs.writeFileSync(path.join(dir, 'hidden.ps1'), t.hidden);
    const tr = run(`timeout --kill-after=10 150 ${PWSH} -NoProfile -File hidden.ps1 2>&1`, dir, 180000);
    let passed = 0, total = (t.hidden.match(/^Add-Check /gm) || []).length, note = '';
    const m = tr.out.match(/BENCH_RESULT passed=(\d+) total=(\d+)/);
    const gate = !!m;
    if (m) { passed = +m[1]; total = +m[2]; }
    else if (tr.code === 124) note = 'timeout';
    else note = 'load_fail: ' + tr.out.slice(-200).replace(/\s+/g, ' ');
    return { gate, passed, total, note };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
}

const ORACLE = { rust: evalRust, ts: evalTs, julia: evalJulia, csharp: evalCsharp, bash: evalBash, pwsh: evalPwsh };

// ---- самопроверка оракулов: эталоны обязаны решать свои задачи на 100% ----
// Запускать перед каждой кампанией: `node run-hard.mjs --selftest`. Ловит расхождение между
// валидацией задач и фактическими оракулами раннера (разные тайм-ауты, разбор вывода и т.п.).
if (SELFTEST) {
  let bad = 0;
  for (const t of ALL) {
    const ev = ORACLE[t.lang](t, t.reference);
    const okAll = ev.gate && ev.total > 0 && ev.passed === ev.total;
    if (!okAll) bad++;
    log(`${t.lang.padEnd(6)} ${t.key.padEnd(10)} ${ev.passed}/${ev.total} gate=${ev.gate} ${okAll ? 'OK' : 'FAIL ' + ev.note}`);
  }
  log(bad ? `SELFTEST FAIL: ${bad} задач` : 'SELFTEST OK');
  process.exit(bad ? 1 : 0);
}
const SYSTEM = {
  rust: 'You are an expert Rust engineer. Output only correct, idiomatic Rust.',
  ts: 'You are an expert TypeScript engineer. Code must pass tsc --strict. Output only correct TypeScript.',
  julia: 'You are an expert Julia programmer. Output only correct, idiomatic Julia.',
  csharp: 'You are an expert C# engineer targeting .NET 10. Output only correct, idiomatic C#.',
  bash: 'You are an expert shell engineer. Output only correct, robust bash that works under set -u.',
  pwsh: 'You are an expert PowerShell engineer targeting PowerShell 7.4. Output only correct, idiomatic PowerShell.',
};

async function runUnit(model, t, runIdx) {
  // BENCH_NO_STREAM=1 — для моделей, чей серверный путь не умеет стриминг (диффузионная
  // diffusiongemma: в стриме Studio отдаёт «[engine error: visual server closed the stream]»
  // КАК КОНТЕНТ, а не-стрим работает штатно [[13.08.2026]]). Цена: ttft не измеряется.
  const res = await chat({
    model: model.id, max_tokens: Number(process.env.MAX_TOKENS || 40000),
    stream: !process.env.BENCH_NO_STREAM,
    messages: [
      { role: 'system', content: SYSTEM[t.lang] },
      { role: 'user', content: t.prompt },
    ],
  });
  const base = { model: model.short, lang: t.lang, task: t.key, mode: 'single', run: runIdx,
    promptChars: t.prompt.length, ...(t.repoFiles ? { repoFiles: t.repoFiles } : {}) };
  if (!res.ok) return { ...base, ok: false, error: res.error, timeout: !!res.timeout };
  const code = extractCode(res.content || '', t.lang);
  const ev = ORACLE[t.lang](t, code);
  const pct = ev.total ? +(ev.passed / ev.total).toFixed(3) : 0;
  const solved = ev.gate && ev.total > 0 && ev.passed === ev.total;
  // Провал без сырого ответа не диагностируется постфактум (случай с заголовком дампа искали
  // повторной пробой на живом стенде) — сохраняем ответ провалившихся юнитов на диск.
  if (!solved) {
    try {
      const dumpDir = path.join(__dirname, '..', 'results', 'hard-dumps');
      fs.mkdirSync(dumpDir, { recursive: true });
      const safe = `${model.short}_${t.lang}_${t.key}_r${runIdx}`.replace(/[^\w.-]+/g, '_');
      fs.writeFileSync(path.join(dumpDir, safe + '.txt'), res.content || '');
    } catch (_) {}
  }
  return {
    ...base, ok: true,
    gate: ev.gate, passed: ev.passed, total: ev.total, pct,
    solved,
    note: ev.note, finish: res.finish,
    tokIn: res.usage.prompt, tokOut: res.usage.completion, reasonTok: res.usage.reasoning,
    latency: res.total, ttft: res.ttft, tokps: res.tokps, codeLen: code.length, cost: res.cost || 0,
  };
}

// ---- драйвер: crash-safe + резюмируемость (ключ model|lang|task|run) ----
const outPath = process.env.OUT
  ? (path.isAbsolute(process.env.OUT) ? process.env.OUT : path.join(__dirname, '..', 'results', process.env.OUT))
  : path.join(__dirname, '..', 'results', 'results-hard.json');

let records = [];
if (fs.existsSync(outPath)) { try { records = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (_) { records = []; } }
const done = new Set(records.filter(r => r.ok).map(r => `${r.model}|${r.lang}|${r.task}|${r.run}`));
const SINGLE_RUNS = Number(process.env.SINGLE_RUNS || 1);
const save = () => fs.writeFileSync(outPath, JSON.stringify(records, null, 1));

for (const model of MODELS) {
  log(`\n===== MODEL ${model.id} =====`);
  // Тайм-аут на edit-long почти наверняка повторится на двух других edit-long той же модели
  // (то же окно, тот же prefill) — не жжём на этом 3 × 20 минут, сам пропуск — результат.
  let longTimedOut = false;
  // Три ОШИБКИ ВЫЗОВА подряд (не провала задачи!) — модель не обслуживается (не грузится в
  // Studio, нет эндпоинта): остаток пропускаем, иначе неспособная загрузиться модель сожгла бы
  // до 22 × 20 минут дедлайнов. Введено перед ночным прогоном экспериментальных архитектур
  // [[12.08.2026]] (diffusion-gemma может не подняться в llama-server вовсе).
  let consecErrs = 0;
  for (const t of ALL) {
    for (let r = 1; r <= SINGLE_RUNS; r++) {
      const key = `${model.id}|${t.lang}|${t.key}|${r}`;
      if (done.has(key)) { log(`${t.lang}/${t.key} run${r}: (skip, done)`); continue; }
      if (t.key === 'edit-long' && longTimedOut) {
        records.push({ model: model.short, lang: t.lang, task: t.key, mode: 'single', run: r, ok: false, error: 'skipped_after_long_timeout' });
        save(); log(`${t.lang}/${t.key} run${r}: (skip after long timeout)`); continue;
      }
      if (consecErrs >= 3) {
        records.push({ model: model.short, lang: t.lang, task: t.key, mode: 'single', run: r, ok: false, error: 'skipped_model_unavailable' });
        save(); log(`${t.lang}/${t.key} run${r}: (skip, модель не обслуживается — 3 ошибки вызова подряд)`); continue;
      }
      const rec = await runUnit(model, t, r);
      consecErrs = rec.ok ? 0 : consecErrs + 1;
      log(`${t.lang}/${t.key} run${r}: ${rec.ok
        ? `${rec.passed}/${rec.total} (${Math.round(rec.pct * 100)}%) gate=${rec.gate} solved=${rec.solved} ${rec.latency}s tok/s=${rec.tokps} $${(rec.cost || 0).toFixed(4)} ${rec.note || ''}`
        : 'ERR ' + rec.error}`);
      records.push(rec); save();
      if (!rec.ok && rec.timeout && t.key === 'edit-long') { longTimedOut = true; log(`  -> edit-long timed out, пропускаю остальные edit-long этой модели`); }
    }
  }
}
log(`\nDONE ${outPath} (${records.length} records)`);
