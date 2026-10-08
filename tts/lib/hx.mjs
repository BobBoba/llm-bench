// * Один прогон «харнесс × модель» на копии каталога: общий кирпич для CLI `hx` (ask.mjs) и матрицы замеров.
// * Правки агента попадают ТОЛЬКО в скретч-копию; исходный каталог не трогается. Итог — метрики + git-diff копии.
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { runAgent } from "./harness.mjs";
import { HX_MODELS, estCost } from "./models.mjs";

const SKIP = new Set(["node_modules", "target", ".venv", ".venv-gsheets", "dist", "__pycache__", ".next", "bin", "obj"]);

const git = (cwd, args) =>
  execFileSync("git", ["-c", "user.name=hx", "-c", "user.email=hx@localhost", ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

// * Служебные артефакты (байткод, сессия харнесса) в сравнение исходов не входят.
const NOISE = [":!.hx-session", ":!**/__pycache__/**", ":!*.pyc"];

// * Копия каталога без тяжёлых артефактов сборки; если это не git-репозиторий — инициализируем и коммитим базу,
// * чтобы `git diff` честно показывал, что изменил агент.
export async function makeCopy(srcDir) {
  const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "hx-"));
  await cp(srcDir, dir, { recursive: true, filter: (p) => !SKIP.has(basename(p)) });
  let isRepo = true;
  try { git(dir, ["rev-parse", "--git-dir"]); } catch { isRepo = false; }
  if (!isRepo) git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  try { git(dir, ["commit", "-q", "--allow-empty", "-m", "hx-base"]); } catch { /* нечего коммитить */ }
  return dir;
}

export async function removeCopy(dir) { await rm(dir, { recursive: true, force: true }); }

// * opts: { harness, modelKey, srcDir, prompt, effort, timeoutMs, keep }
export async function runHx({ harness, modelKey, srcDir, prompt, effort = "high", timeoutMs = 20 * 60000, keep = false }) {
  const m = HX_MODELS[modelKey];
  if (!m) throw new Error(`неизвестная модель: ${modelKey} (есть: ${Object.keys(HX_MODELS).join(", ")})`);
  const dir = await makeCopy(srcDir);
  const r = await runAgent(harness, { model: m[harness], cwd: dir, thinking: effort, sessionDir: join(dir, ".hx-session"), prompt }, { timeoutMs });
  git(dir, ["add", "-A", "--", ".", ...NOISE]);
  const stat = git(dir, ["diff", "--cached", "--stat", "HEAD", "--", ".", ...NOISE]).trim();
  const patch = git(dir, ["diff", "--cached", "HEAD", "--", ".", ...NOISE]);
  const files = git(dir, ["diff", "--cached", "--name-only", "HEAD", "--", ".", ...NOISE]).trim().split("\n").filter(Boolean);
  const out = {
    harness, model: modelKey, effort, wallS: Math.round(r.wallMs / 100) / 10,
    exitCode: r.code, killed: r.killed, stalled: r.stalled, metrics: r.metrics,
    estUsd: estCost(r.metrics, modelKey), files, stat, patch, message: r.metrics.lastMessage ?? "",
    stderrTail: r.code ? (r.stderr || "").slice(-300) : "", dir: keep ? dir : null,
  };
  if (!keep) await removeCopy(dir);
  return out;
}
