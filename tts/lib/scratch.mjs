import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// * Копирует шаблон задачи в изолированный tmp-каталог. Возвращает путь скретча.
export async function makeScratch(templateDir) {
  const dir = await mkdtemp(join(tmpdir(), "tts-"));
  await cp(templateDir, dir, { recursive: true });
  return dir;
}

export async function cleanupScratch(dir) {
  await rm(dir, { recursive: true, force: true });
}

// ! CLAUDE_* протекают из родительской сессии Claude Code в спавнимые omp/pi
// ! и отравляют их контекст — вычищаем перед запуском (известная гоча).
export function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("CLAUDE_")) delete env[k];
  return env;
}
