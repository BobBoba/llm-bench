#!/usr/bin/env node
// * hx — одна задача, несколько харнессов и моделей, сравнение исхода.
// *
// *   hx [--harness omp,codex] [--model sol,luna] [--dir .] [--effort high] [--timeout 20]
// *      [--parallel] [--keep] [--out <каталог отчёта>] [--prompt-file f] "задача"
// *
// * Каждый прогон идёт в СВОЕЙ копии каталога (исходный не меняется). В отчёте: время, токены (вход/кэш/выход),
// * эквивалентная цена по общему прайсу, число вызовов инструментов, список изменённых файлов, итоговое сообщение
// * агента; патчи каждого прогона лежат рядом (`<харнесс>-<модель>.patch`), их можно применить `git apply`.
// * По умолчанию прогоны идут ПОСЛЕДОВАТЕЛЬНО (честное время); --parallel — одновременно (быстрее, время шумнее).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { runHx } from "./lib/hx.mjs";
import { HX_MODELS, HX_HARNESSES } from "./lib/models.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const VALUE_FLAGS = new Set(["harness", "model", "dir", "effort", "timeout", "out", "prompt-file"]);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) { if (VALUE_FLAGS.has(argv[i].slice(2))) i++; } else positional.push(argv[i]);
}

if (has("help") || has("h")) {
  console.log(`hx [--harness ${HX_HARNESSES.join(",")}] [--model ${Object.keys(HX_MODELS).join(",")}] [--dir .] [--effort high] [--timeout 20] [--parallel] [--keep] [--out DIR] [--prompt-file F] "задача"`);
  process.exit(0);
}

const harnesses = opt("harness", HX_HARNESSES.join(",")).split(",").filter(Boolean);
const models = opt("model", Object.keys(HX_MODELS).join(",")).split(",").filter(Boolean);
for (const h of harnesses) if (!HX_HARNESSES.includes(h)) { console.error(`неизвестный харнесс: ${h}`); process.exit(2); }
for (const m of models) if (!HX_MODELS[m]) { console.error(`неизвестная модель: ${m}`); process.exit(2); }

const pf = opt("prompt-file");
const prompt = (pf ? await readFile(pf, "utf8") : positional.join(" ")).trim();
if (!prompt) { console.error("нет задачи: передайте текст аргументом или --prompt-file"); process.exit(2); }

const srcDir = resolve(opt("dir", "."));
const effort = opt("effort", "high");
const timeoutMs = Number(opt("timeout", "20")) * 60000;
const keep = has("keep");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = resolve(opt("out", join(process.env.TMPDIR || homedir(), `hx-report-${stamp}`)));
await mkdir(outDir, { recursive: true });

const combos = harnesses.flatMap((h) => models.map((m) => ({ harness: h, modelKey: m })));
console.error(`hx: ${combos.length} прогонов (${combos.map((c) => `${c.harness}/${c.modelKey}`).join(", ")}), каталог ${srcDir}, effort=${effort}`);

const one = async (c) => {
  const t = `${c.harness}/${c.modelKey}`;
  console.error(`  → ${t} …`);
  try {
    const r = await runHx({ ...c, srcDir, prompt, effort, timeoutMs, keep });
    console.error(`  ✓ ${t}  ${r.wallS}s  $${(r.estUsd ?? 0).toFixed(4)}  файлов: ${r.files.length}`);
    return r;
  } catch (e) {
    console.error(`  ✗ ${t}  ${e.message}`);
    return { ...c, model: c.modelKey, error: String(e.message), wallS: null, metrics: {}, files: [], patch: "", message: "" };
  }
};

const results = [];
if (has("parallel")) results.push(...(await Promise.all(combos.map(one))));
else for (const c of combos) results.push(await one(c));

for (const r of results) {
  const name = `${r.harness}-${r.model}`;
  if (r.patch) await writeFile(join(outDir, `${name}.patch`), r.patch);
  await writeFile(join(outDir, `${name}.md`), `${r.message || "(нет итогового сообщения)"}\n`);
}
await writeFile(join(outDir, "summary.json"), JSON.stringify(results.map(({ patch, ...rest }) => rest), null, 2));

const k = (n) => (n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
console.log(`\nЗадача: ${prompt.slice(0, 160)}${prompt.length > 160 ? "…" : ""}\n`);
console.log("харнесс  модель  время,с  вход(некэш)  кэш     выход   инстр.  цена,$    файлов  статус");
for (const r of results) {
  const m = r.metrics || {};
  const status = r.error ? `ошибка: ${r.error.slice(0, 40)}` : r.killed ? (r.stalled ? "зависание" : "таймаут") : (m.finishReason || (r.exitCode === 0 ? "ok" : `код ${r.exitCode}`));
  console.log([
    r.harness.padEnd(8), r.model.padEnd(6), String(r.wallS ?? "—").padStart(7), k(m.tokensIn).padStart(11), k(m.tokensCached).padStart(7),
    k(m.tokensOut).padStart(7), String(m.toolCalls ?? "—").padStart(7), (r.estUsd == null ? "—" : r.estUsd.toFixed(4)).padStart(9),
    String(r.files.length).padStart(7), " " + status,
  ].join("  "));
}
console.log("\nИзменённые файлы:");
for (const r of results) console.log(`  ${r.harness}/${r.model}: ${r.files.join(", ") || "—"}`);
console.log(`\nОтчёт, патчи и итоговые сообщения: ${outDir}`);
if (keep) for (const r of results) if (r.dir) console.log(`  копия ${r.harness}/${r.model}: ${r.dir}`);
