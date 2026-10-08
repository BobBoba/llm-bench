// * Замер «omp vs codex» на одних моделях (sol, luna): 5 ступеней tts × N повторов, один выстрел на ячейку.
// * Метрики: время до завершения агента, прохождение внешнего оракула, токены (вход/кэш/выход), эквивалентная цена
// * по общему прайсу, инструментальные вызовы. Порядок: повтор → задача → модель → харнесс (оба харнесса идут
// * подряд, чтобы дрейф нагрузки на подписку не перекашивал сравнение). Резюмируемый: ключ harness|model|task|rN.
// *   node run-hx-bench.mjs [--repeats 3] [--model sol,luna] [--task r1-edit,...] [--effort high]
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runHx, removeCopy } from "./lib/hx.mjs";
import { runOracle } from "./lib/oracle.mjs";
import { TASKS, HX_MODELS, HX_HARNESSES } from "./lib/models.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "results-hx.json");
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const repeats = Number(opt("repeats", "3"));
const models = opt("model", Object.keys(HX_MODELS).join(",")).split(",");
const taskFilter = opt("task", "").split(",").filter(Boolean);
const effort = opt("effort", "high");

const load = async () => { try { return JSON.parse(await readFile(OUT, "utf8")); } catch { return []; } };
const results = await load();
const keyOf = (h, m, t, r) => `${h}|${m}|${t}|r${r}`;
const done = new Set(results.map((x) => keyOf(x.harness, x.model, x.task, x.repeat)));

for (let rep = 1; rep <= repeats; rep++) {
  for (const task of TASKS) {
    if (taskFilter.length && !taskFilter.includes(task.id)) continue;
    const tpl = join(HERE, "tasks", task.id);
    const prompt = (await readFile(join(tpl, "TASK.md"), "utf8")).trim();
    for (const model of models) {
      for (const harness of HX_HARNESSES) {
        const k = keyOf(harness, model, task.id, rep);
        if (done.has(k)) { console.log(`skip ${k}`); continue; }
        console.log(`RUN  ${k} …`);
        let rec;
        try {
          const r = await runHx({ harness, modelKey: model, srcDir: tpl, prompt, effort, timeoutMs: task.timeoutMs, keep: true });
          const orc = await runOracle(task.id, r.dir);
          await removeCopy(r.dir);
          const m = r.metrics;
          rec = {
            harness, model, task: task.id, lang: task.lang, repeat: rep, effort,
            time_s: r.wallS, pass: !!orc.pass, timeout_hit: !!r.killed, finish: m.finishReason ?? null,
            tokens_in: m.tokensIn ?? 0, tokens_cached: m.tokensCached ?? 0, tokens_out: m.tokensOut ?? 0, tokens_reason: m.tokensReason ?? 0,
            tool_calls: m.toolCalls ?? null, est_usd: r.estUsd == null ? null : Math.round(r.estUsd * 1e5) / 1e5,
            files_changed: r.files.length, error: null,
          };
        } catch (e) {
          rec = { harness, model, task: task.id, lang: task.lang, repeat: rep, effort, error: String(e.message || e).slice(0, 200), pass: false };
        }
        results.push(rec);
        await writeFile(OUT, JSON.stringify(results, null, 2));
        console.log(`DONE ${k}  ${rec.time_s}s pass=${rec.pass} $${rec.est_usd} tools=${rec.tool_calls} ${rec.error ? "ERR " + rec.error : ""}`);
      }
    }
  }
}
console.log(`\nwrote ${results.length} records -> ${OUT}`);
