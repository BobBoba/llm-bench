import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

// * Запускает oracles/<taskId>.sh <scratchDir>. exit 0 = pass. Возвращает {pass, log}.
// * log содержит совмещённые stdout+stderr скрипта - это диагностика,
// * которую Task 6 покажет агенту при guided-steering после провала оракула.
export async function runOracle(taskId, scratchDir, { timeoutMs = 180000 } = {}) {
  const script = join(HERE, "..", "oracles", `${taskId}.sh`);
  try {
    const { stdout, stderr } = await exec("bash", [script, scratchDir], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { pass: true, log: (stdout || "") + (stderr || "") };
  } catch (e) {
    // ? execFile бросает исключение при ненулевом exit code - это ожидаемый
    // ? "не прошёл оракул" случай, а не аварийная ошибка модуля.
    let log = (e.stdout || "") + (e.stderr || "");
    // * При таймауте execFile шлёт SIGTERM и помечает ошибку e.killed === true.
    // * Без этой пометки лог таймаута неотличим от обычного ненулевого exit -
    // * Task 6 покажет агенту причину явно, а не голый провал без объяснения.
    if (e.killed) {
      log += `\n[oracle timed out after ${timeoutMs}ms]`;
    }
    return { pass: false, log };
  }
}
