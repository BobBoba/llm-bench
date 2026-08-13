// * Драйвер матрицы time-to-solution: (harness x model x task) -> одна агентская сессия на ячейку.
// * Меряет single-shot время-до-первого-"готово" И guided-дошагивание (та же сессия, кормим
// * оракульский лог обратно) до внешнего green или до STEER_CAP раундов / бюджета ячейки.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { makeScratch, cleanupScratch } from "./lib/scratch.mjs";
import { runAgent } from "./lib/harness.mjs";
import { runOracle } from "./lib/oracle.mjs";
import { MODELS, TASKS, HARNESSES, STEER_CAP } from "./lib/models.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "results-tts.json");

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const has = (name) => argv.includes(`--${name}`);
const onlyPhase = opt("phase");             // A | B | C
const onlyModel = opt("model");             // key фильтр
const onlyTask = opt("task");               // id фильтр (напр. r1-edit) -- для smoke и точечных перезапусков
const force = has("force");

async function loadResults() { try { return JSON.parse(await readFile(OUT, "utf8")); } catch { return []; } }
const keyOf = (h, m, t) => `${h}|${m}|${t}`;

// * Одна ячейка: single-замер + guided-дошагивание в ТОЙ ЖЕ сессии до внешнего green.
async function runCell(harness, model, task) {
  const tpl = join(HERE, "tasks", task.id);
  const scratch = await makeScratch(tpl);
  const sessionDir = join(scratch, ".pi-session");
  const prompt = (await readFile(join(tpl, "TASK.md"), "utf8")).trim();
  const rec = {
    harness, model: model.key, task: task.id, lang: task.lang,
    tts_single_s: null, tts_guided_s: null, pass_single: false, pass_guided: false,
    steering_rounds: 0, cost_single_usd: 0, cost_guided_usd: 0,
    tokens_in: 0, tokens_out: 0, tokens_reason: 0, tool_calls: null, turns: null,
    finish_reason: null, error: null, timeout_hit: false,
  };
  const cellT0 = performance.now();
  try {
    // --- первый ход ---
    let r = await runAgent(harness, { model: model.model, cwd: scratch, thinking: model.thinking, sessionDir, prompt }, { timeoutMs: task.timeoutMs });
    accumulate(rec, r);
    rec.tts_single_s = round(r.wallMs / 1000);
    let orc = await runOracle(task.id, scratch);
    rec.pass_single = orc.pass;
    if (orc.pass) { rec.pass_guided = true; rec.tts_guided_s = rec.tts_single_s; return finish(rec, scratch); }

    // --- дошагивание ---
    for (let round = 1; round <= STEER_CAP; round++) {
      const budgetLeft = task.timeoutMs - (performance.now() - cellT0);
      if (budgetLeft <= 0) { rec.timeout_hit = true; break; }
      rec.steering_rounds = round;
      const steer = `Твоё решение ещё не проходит проверку. Вывод оракула:\n${orc.log.slice(-1500)}\nПродолжи и доведи до зелёного. Проверь сам перед завершением.`;
      r = await runAgent(harness, { model: model.model, cwd: scratch, thinking: model.thinking, sessionDir, continueSession: true, prompt: steer }, { timeoutMs: Math.min(task.timeoutMs, budgetLeft) });
      accumulate(rec, r);
      if (r.killed) { rec.timeout_hit = true; break; }
      orc = await runOracle(task.id, scratch);
      if (orc.pass) { rec.pass_guided = true; rec.tts_guided_s = round2(performance.now() - cellT0); break; }
    }
    return finish(rec, scratch);
  } catch (e) {
    rec.error = String(e?.message || e);
    return finish(rec, scratch);
  }
}

function accumulate(rec, r) {
  const m = r.metrics || {};
  rec.cost_single_usd = rec.steering_rounds === 0 ? round4(m.cost) : rec.cost_single_usd;
  rec.cost_guided_usd = round4((rec.cost_guided_usd || 0) + (m.cost || 0));
  rec.tokens_in += m.tokensIn || 0; rec.tokens_out += m.tokensOut || 0; rec.tokens_reason += m.tokensReason || 0;
  rec.finish_reason = m.finishReason ?? rec.finish_reason;
  if (m.toolCalls != null) rec.tool_calls = (rec.tool_calls || 0) + m.toolCalls;
  if (m.turns != null) rec.turns = (rec.turns || 0) + m.turns;
  if (r.killed) rec.timeout_hit = true;
}
const round = (n) => Math.round(n * 10) / 10;
const round2 = (ms) => Math.round(ms / 100) / 10;
const round4 = (n) => Math.round((n || 0) * 1e4) / 1e4;
async function finish(rec, scratch) { await cleanupScratch(scratch); return rec; }

// * Главный цикл: перебор ячеек с фильтрами по фазе/модели/задаче; локальные модели идут только в своей фазе.
const results = await loadResults();
const done = new Set(results.map((r) => keyOf(r.harness, r.model, r.task)));
for (const model of MODELS) {
  if (onlyModel && model.key !== onlyModel) continue;
  const phase = model.local ? model.phase : "A";
  if (onlyPhase && phase !== onlyPhase) continue;
  for (const task of TASKS) {
    if (onlyTask && task.id !== onlyTask) continue;
    for (const harness of HARNESSES) {
      const k = keyOf(harness, model.key, task.id);
      if (done.has(k) && !force) { console.log(`skip ${k}`); continue; }
      console.log(`RUN  ${k} …`);
      const rec = await runCell(harness, model, task);
      const idx = results.findIndex((r) => keyOf(r.harness, r.model, r.task) === k);
      if (idx >= 0) results[idx] = rec; else results.push(rec);
      await writeFile(OUT, JSON.stringify(results, null, 2));
      console.log(`DONE ${k}  single=${rec.tts_single_s}s pass_s=${rec.pass_single} guided=${rec.tts_guided_s}s pass_g=${rec.pass_guided} $${rec.cost_guided_usd} rounds=${rec.steering_rounds}`);
    }
  }
}
console.log(`\nwrote ${results.length} records -> ${OUT}`);
