# Time-to-Solution Benchmark (omp vs pi) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Измерить wall-clock время и стоимость доставки рабочего решения для 8 моделей через два агентских харнесса (omp, pi) на лестнице из 5 задач, и сравнить сами харнессы.

**Architecture:** Node/TS-драйвер спавнит `omp`/`pi` в `--mode json`, замеряет t0→t1 до первого «готово» (single) и до внешнего green с дошагиванием (guided), гоняет детерминированные оракулы (`cargo`/`bun`), пишет `results-tts.json`. Python-скрипт выгружает сводки в новую вкладку книги «LLM Benchmark». Паттерн повторяет существующий `run-*.mjs` → `gsheets_*.py`.

**Tech Stack:** Node ≥20 (ESM `.mjs`, `node:test`), Rust/`cargo`, Bun, Python venv `.venv-gsheets` (`gspread`, `google-api-python-client`), omp v17.0.5 (`~/.bun/bin/omp`), pi v0.80.3 (`~/.nvm/versions/node/v24.10.0/bin/pi`).

## Global Constraints

- `/code/work/llm-bench` — **НЕ git-репозиторий**. Никаких `git commit`/`git add`. Каждая задача заканчивается verification-checkpoint'ом, не коммитом. Не предлагать коммит (правило пользователя).
- Секреты: OpenRouter-ключ и Google SA-ключ — только из `secret-tool`, никогда в plaintext на диск или в вывод. SA `claude-mcp@mcp-claude-484309.iam.gserviceaccount.com` имеет НОЛЬ Drive-квоты → создать новый файл-таблицу нельзя, только новая вкладка в SHEET_ID `1mhSrYrJU0mIte3nBQ7RHiRTiFXNfZ72QrfRa_WiPhRM`.
- Даты в vault-заметках — формат `[[DD.MM.YYYY]]`.
- Паритет харнессов: единственная переменная между парными ячейками — сам харнесс. `--thinking` фиксирован per-model (см. MODELS), инструменты и скретч одинаковы, `CLAUDE_*`-env вычищается при спавне.
- Один RTX 3090: ornith и qwen НЕ грузятся одновременно → локальные прогоны сериализованы (фазы B, C).
- llama-server slug'и: llama.cpp игнорирует поле `model` запроса и отдаёт загруженную модель; id в конфиге маршрутизирует, но физически отвечает то, что сейчас в 3090.

**Каталоги (создать в Task 0):**
```
tts/
  lib/            scratch.mjs  harness.mjs  oracle.mjs  models.mjs  (+ *.test.mjs)
  tasks/          r1-edit/ r2-bugfix/ r3-feature/ t4-cli/ t5-webapi/
  oracles/        r1-edit.sh r2-bugfix.sh r3-feature.sh t4-cli.sh t5-webapi.sh  refs/  hidden/
  fixtures/       omp-sample.json  pi-sample.json  (из Task 1)
  run-tts.mjs
  results-tts.json  (генерится)
gsheets_tts.py
```

---

## Task 0: Каркас каталогов

**Files:**
- Create: `tts/lib/`, `tts/tasks/`, `tts/oracles/refs/`, `tts/oracles/hidden/`, `tts/fixtures/`

- [ ] **Step 1: Создать дерево каталогов**

Run:
```bash
mkdir -p /code/work/llm-bench/tts/{lib,tasks,oracles/refs,oracles/hidden,fixtures}
```

- [ ] **Step 2: Checkpoint**

Run: `ls -d /code/work/llm-bench/tts/{lib,tasks,oracles/refs,oracles/hidden,fixtures}`
Expected: все 5 путей существуют.

---

## Task 1: Preflight — контракт JSON, continue-сессия, pi auto-approve, slug'и

Цель: снять неизвестные внешних инструментов ДО написания парсера. Пишет фикстуры и короткий `contract.md`.

**Files:**
- Create: `tts/preflight.mjs`, `tts/fixtures/omp-sample.json`, `tts/fixtures/pi-sample.json`, `tts/CONTRACT.md`

**Interfaces:**
- Produces: `tts/fixtures/{omp,pi}-sample.json` — реальный stdout `--mode json` одного дешёвого прогона; поля usage/cost/finish, наблюдаемые в них, фиксируются в `CONTRACT.md` (пути ключей, механизм continue, поведение pi `-p` при edit-approval).

- [ ] **Step 1: Пробник дешёвой модели через оба харнесса (захват JSON)**

Run (haiku — самая дешёвая; печатает JSON в файлы):
```bash
cd /code/work/llm-bench/tts
OMP=~/.bun/bin/omp
PI=~/.nvm/versions/node/v24.10.0/bin/pi
D=$(mktemp -d)
"$OMP" --model openrouter/anthropic/claude-haiku-4.5 --cwd "$D" --mode json --no-session -p "Reply with exactly: OK" > fixtures/omp-sample.json 2>fixtures/omp-sample.err || true
"$PI"  --model openrouter/anthropic/claude-haiku-4.5 --cwd "$D" --mode json --no-session --approve -p "Reply with exactly: OK" > fixtures/pi-sample.json 2>fixtures/pi-sample.err || true
echo "--- omp bytes ---"; wc -c fixtures/omp-sample.json; echo "--- pi bytes ---"; wc -c fixtures/pi-sample.json
```
Expected: оба файла непустые, содержат JSON. Если пусто — смотреть `.err` (частая причина: не тот slug, нет OpenRouter-ключа в окружении, интерактивный approval).

- [ ] **Step 2: Записать наблюдаемый контракт в CONTRACT.md**

Открыть `fixtures/omp-sample.json` и `fixtures/pi-sample.json`, найти пути к: стоимости (`cost`/`total_cost`/…), токенам (in/out/reasoning), finish_reason, числу шагов/turns. Записать в `tts/CONTRACT.md` буквальные пути для каждого харнесса. Здесь же зафиксировать:
  - continue-механизм: проверить `"$OMP" --session-dir "$D/s" --mode json -p "hi"` затем `"$OMP" --session-dir "$D/s" --continue --mode json -p "and again"` — работает ли `-c/--continue` с `--session-dir` в обоих. Записать рабочую форму.
  - pi edit-approval в `-p`: `"$PI" --cwd "$D" --approve --mode json -p "create file z.txt with text hi"` — проверить, что файл создан без интерактивного зависания. Если зависает — записать нужный флаг/переменную.

- [ ] **Step 3: Подтвердить OpenRouter slug'и**

Run (каждый должен вернуть JSON с непустым usage; `deepseek-v3.2` — главный кандидат на расхождение):
```bash
cd /code/work/llm-bench/tts; OMP=~/.bun/bin/omp; D=$(mktemp -d)
for M in deepseek/deepseek-v3.2 deepseek/deepseek-v4-pro anthropic/claude-sonnet-4.5 anthropic/claude-sonnet-5 anthropic/claude-opus-4.8 anthropic/claude-haiku-4.5; do
  echo "=== $M ==="; "$OMP" --model "openrouter/$M" --cwd "$D" --mode json --no-session -p "Reply: OK" 2>&1 | tail -c 200; echo
done
```
Expected: каждый — валидный ответ. Любой падающий slug исправить в `CONTRACT.md` (актуальный slug) — он станет источником для `models.mjs` (Task 5-pre).

- [ ] **Step 4: Checkpoint**

`CONTRACT.md` содержит: пути cost/tokens/finish для omp и pi, рабочую continue-форму, подтверждение pi auto-approve, финальный список из 6 рабочих OpenRouter-slug'ов. Фикстуры непустые.

---

## Task 2: Изоляция скретча (`scratch.mjs`)

**Files:**
- Create: `tts/lib/scratch.mjs`, `tts/lib/scratch.test.mjs`

**Interfaces:**
- Produces: `makeScratch(templateDir) -> Promise<string>`, `cleanupScratch(dir) -> Promise<void>`, `cleanEnv() -> object`.

- [ ] **Step 1: Написать падающий тест**

`tts/lib/scratch.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeScratch, cleanupScratch, cleanEnv } from "./scratch.mjs";

test("makeScratch copies template files", async () => {
  const tpl = await mkdtemp(join(tmpdir(), "tpl-"));
  await writeFile(join(tpl, "marker.txt"), "hi");
  const s = await makeScratch(tpl);
  await access(join(s, "marker.txt")); // throws if missing
  await cleanupScratch(s);
  await assert.rejects(() => access(join(s, "marker.txt")));
});

test("cleanEnv strips CLAUDE_* vars", () => {
  process.env.CLAUDE_TESTVAR = "leak";
  const env = cleanEnv();
  assert.equal(env.CLAUDE_TESTVAR, undefined);
  assert.equal(typeof env.PATH, "string");
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd /code/work/llm-bench/tts && node --test lib/scratch.test.mjs`
Expected: FAIL — `Cannot find module './scratch.mjs'`.

- [ ] **Step 3: Реализация**

`tts/lib/scratch.mjs`:
```js
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
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `cd /code/work/llm-bench/tts && node --test lib/scratch.test.mjs`
Expected: PASS (2 теста).

- [ ] **Step 5: Checkpoint** — оба теста зелёные.

---

## Task 3: Обёртка харнесса (`harness.mjs`)

**Files:**
- Create: `tts/lib/harness.mjs`, `tts/lib/harness.test.mjs`

**Interfaces:**
- Consumes: `cleanEnv` из `scratch.mjs`; фикстуры из Task 1.
- Produces: `buildArgv(harness, opts) -> string[]`, `binFor(harness) -> string`, `deepFind(obj, keys) -> any`, `normalizeResult(stdout) -> {parsed, cost, tokensIn, tokensOut, tokensReason, finishReason, toolCalls, turns}`, `runAgent(harness, opts, {timeoutMs}) -> Promise<{code, stdout, stderr, wallMs, metrics}>`.
- `opts`: `{model, cwd, thinking, sessionDir, continueSession, prompt}`.

- [ ] **Step 1: Написать падающий тест (argv + нормализатор на фикстурах)**

`tts/lib/harness.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildArgv, deepFind, normalizeResult } from "./harness.mjs";

test("buildArgv: omp non-interactive json", () => {
  const a = buildArgv("omp", { model: "openrouter/anthropic/claude-haiku-4.5", cwd: "/tmp/x", thinking: "high", prompt: "do it" });
  assert.ok(a.includes("--mode") && a[a.indexOf("--mode")+1] === "json");
  assert.ok(a.includes("--no-session"));
  assert.ok(a.includes("-p") && a.at(-1) === "do it");
});

test("buildArgv: pi adds --approve and continue uses session-dir", () => {
  const a = buildArgv("pi", { model: "m", cwd: "/tmp/x", sessionDir: "/tmp/s", continueSession: true, prompt: "go" });
  assert.ok(a.includes("--approve"));
  assert.ok(a.includes("--session-dir"));
  assert.ok(!a.includes("--no-session"));
});

test("deepFind finds nested key case-insensitively", () => {
  assert.equal(deepFind({ a: { Total_Cost: 0.42 } }, ["total_cost"]), 0.42);
});

test("normalizeResult parses omp fixture", async () => {
  const s = await readFile(new URL("../fixtures/omp-sample.json", import.meta.url), "utf8");
  const r = normalizeResult(s);
  assert.equal(r.parsed, true);
  assert.ok(r.cost >= 0);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd /code/work/llm-bench/tts && node --test lib/harness.test.mjs`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализация**

`tts/lib/harness.mjs`:
```js
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { cleanEnv } from "./scratch.mjs";

const OMP_BIN = `${process.env.HOME}/.bun/bin/omp`;
const PI_BIN  = `${process.env.HOME}/.nvm/versions/node/v24.10.0/bin/pi`;

export function binFor(harness) { return harness === "omp" ? OMP_BIN : PI_BIN; }

// * Единый argv для неинтерактивного JSON-прогона. omp и pi делят флаги (pi — upstream omp).
// ? continue-форма подтверждается в Task 1 (CONTRACT.md); при расхождении править здесь.
export function buildArgv(harness, { model, cwd, thinking = "high", sessionDir, continueSession, prompt }) {
  const a = ["--model", model, "--cwd", cwd, "--mode", "json"];
  if (thinking) a.push("--thinking", thinking);
  if (sessionDir) { a.push("--session-dir", sessionDir); if (continueSession) a.push("--continue"); }
  else a.push("--no-session");
  if (harness === "pi") a.push("--approve"); // omp авто-одобряет через config yolo
  a.push("-p", prompt);
  return a;
}

// * Рекурсивный поиск первого не-объектного значения по любому из имён ключей (регистронезависимо).
// * Делает нормализатор устойчивым к различиям формы JSON между omp и pi.
export function deepFind(obj, keys) {
  const want = keys.map((k) => k.toLowerCase());
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (cur && typeof cur === "object") {
      for (const [k, v] of Object.entries(cur)) {
        if (want.includes(k.toLowerCase()) && (v === null || typeof v !== "object")) return v;
        if (v && typeof v === "object") stack.push(v);
      }
    }
  }
  return undefined;
}

const num = (v) => { const n = typeof v === "string" ? parseFloat(v) : v; return Number.isFinite(n) ? n : undefined; };

// * Нормализует stdout агента в плоскую запись метрик. Терпим к одиночному JSON и NDJSON.
export function normalizeResult(stdout) {
  let obj = null;
  const t = (stdout || "").trim();
  try { obj = JSON.parse(t); }
  catch { for (const line of t.split("\n").reverse()) { try { obj = JSON.parse(line); break; } catch {} } }
  if (!obj) return { parsed: false, cost: 0, tokensIn: 0, tokensOut: 0, tokensReason: 0, finishReason: null, toolCalls: null, turns: null, raw: t.slice(-400) };
  return {
    parsed: true,
    cost: num(deepFind(obj, ["cost", "total_cost", "totalCost", "costUsd"])) ?? 0,
    tokensIn: num(deepFind(obj, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"])) ?? 0,
    tokensOut: num(deepFind(obj, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"])) ?? 0,
    tokensReason: num(deepFind(obj, ["reasoning_tokens", "reasoningTokens"])) ?? 0,
    finishReason: deepFind(obj, ["finish_reason", "finishReason", "stopReason"]) ?? null,
    toolCalls: num(deepFind(obj, ["tool_calls", "toolCalls"])) ?? null,
    turns: num(deepFind(obj, ["turns", "num_turns", "steps"])) ?? null,
  };
}

// * Один ход агента. Убивает по timeoutMs. Возвращает wall-clock и нормализованные метрики.
export function runAgent(harness, opts, { timeoutMs }) {
  return new Promise((resolve) => {
    const argv = buildArgv(harness, opts);
    const t0 = performance.now();
    const child = spawn(binFor(harness), argv, { cwd: opts.cwd, env: cleanEnv() });
    let stdout = "", stderr = "", killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, wallMs: performance.now() - t0, killed, metrics: normalizeResult(stdout) });
    });
  });
}
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `cd /code/work/llm-bench/tts && node --test lib/harness.test.mjs`
Expected: PASS (4 теста). Если `normalizeResult` не находит cost в фикстуре — сверить пути с `CONTRACT.md` и расширить массивы ключей в `deepFind`-вызовах.

- [ ] **Step 5: Checkpoint** — все тесты зелёные, нормализатор извлекает cost из реальной фикстуры.

---

## Task 4: Оракулы (`oracle.mjs` + скрипты задач)

**Files:**
- Create: `tts/lib/oracle.mjs`, `tts/lib/oracle.test.mjs`, `tts/oracles/{r1-edit,r2-bugfix,r3-feature,t4-cli,t5-webapi}.sh`
- Create (в Task 5 вместе с шаблонами): `tts/oracles/refs/`, `tts/oracles/hidden/`

**Interfaces:**
- Produces: `runOracle(taskId, scratchDir) -> Promise<{pass, log}>`. Каждый `oracles/<taskId>.sh <scratchDir>` завершается кодом 0 = pass.

- [ ] **Step 1: Написать падающий тест (оракул на заведомо-зелёном и заведомо-красном)**

`tts/lib/oracle.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOracle } from "./oracle.mjs";

// Мини-оракул echo-типа: скрипт echo-check.sh существует в oracles/ и pass при наличии PASS-файла
test("runOracle passes when marker present, fails otherwise", async () => {
  const good = await mkdtemp(join(tmpdir(), "ok-"));
  await writeFile(join(good, "PASS"), "");
  const bad = await mkdtemp(join(tmpdir(), "no-"));
  const p = await runOracle("echo-check", good);
  const f = await runOracle("echo-check", bad);
  assert.equal(p.pass, true);
  assert.equal(f.pass, false);
});
```
И скрипт `tts/oracles/echo-check.sh`:
```bash
#!/usr/bin/env bash
# тестовый оракул: pass если в скретче есть файл PASS
[ -f "$1/PASS" ]
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /code/work/llm-bench/tts && chmod +x oracles/echo-check.sh && node --test lib/oracle.test.mjs`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализация `oracle.mjs`**

```js
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

// * Запускает oracles/<taskId>.sh <scratchDir>. exit 0 = pass. Возвращает {pass, log}.
export async function runOracle(taskId, scratchDir, { timeoutMs = 180000 } = {}) {
  const script = join(HERE, "..", "oracles", `${taskId}.sh`);
  try {
    const { stdout, stderr } = await exec("bash", [script, scratchDir], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return { pass: true, log: (stdout || "") + (stderr || "") };
  } catch (e) {
    return { pass: false, log: (e.stdout || "") + (e.stderr || "") };
  }
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `cd /code/work/llm-bench/tts && node --test lib/oracle.test.mjs`
Expected: PASS.

- [ ] **Step 5: Написать 5 оракулов задач**

`tts/oracles/r1-edit.sh`:
```bash
#!/usr/bin/env bash
set -e; D="$1"; cd "$D"
grep -q 'Hi, ' src/lib.rs
! grep -q 'Hello, ' src/lib.rs
cargo test --quiet
```
`tts/oracles/r2-bugfix.sh` (тест не должен быть изменён — сверка с эталоном):
```bash
#!/usr/bin/env bash
set -e; D="$1"; REF="$(dirname "$0")/refs/r2-median.rs"
diff -q "$REF" "$D/tests/median.rs"    # fail, если тест правили
cd "$D"; cargo test --quiet
```
`tts/oracles/r3-feature.sh` (подкладываем скрытый тест, затем гоняем):
```bash
#!/usr/bin/env bash
set -e; D="$1"; HID="$(dirname "$0")/hidden/r3-palindrome.rs"
mkdir -p "$D/tests"; cp "$HID" "$D/tests/palindrome_hidden.rs"
cd "$D"; cargo test --quiet
```
`tts/oracles/t4-cli.sh`:
```bash
#!/usr/bin/env bash
set -e; D="$1"; cd "$D"
bunx tsc --noEmit --strict
printf 'alpha beta\ngamma\n' > sample.txt
OUT=$(bun run index.ts sample.txt)
echo "$OUT" | grep -qE '(^|[^0-9])2([^0-9]|$)'   # 2 строки
echo "$OUT" | grep -qE '(^|[^0-9])3([^0-9]|$)'   # 3 слова
LN=$(bun run index.ts --lines sample.txt); echo "$LN" | grep -qE '(^|[^0-9])2([^0-9]|$)'
```
`tts/oracles/t5-webapi.sh`:
```bash
#!/usr/bin/env bash
set -e; D="$1"; cd "$D"
bunx tsc --noEmit --strict
PORT=8977
bun run index.ts --port "$PORT" & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -sf "http://localhost:$PORT/todos" >/dev/null && break || sleep 0.3; done
ID=$(curl -sf -X POST "http://localhost:$PORT/todos" -H 'content-type: application/json' -d '{"title":"buy milk"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -sf "http://localhost:$PORT/todos" | grep -q "buy milk"
curl -sf -X DELETE "http://localhost:$PORT/todos/$ID" -o /dev/null -w '%{http_code}' | grep -qE '20(0|4)'
test "$(curl -sf "http://localhost:$PORT/todos")" = "[]"
```
Сделать исполняемыми:
```bash
chmod +x /code/work/llm-bench/tts/oracles/*.sh
```
> refs/hidden-файлы (`refs/r2-median.rs`, `hidden/r3-palindrome.rs`) создаются в Task 5 вместе с шаблонами. Их код приведён там.

- [ ] **Step 6: Checkpoint** — `oracle.test.mjs` зелёный; 5 скриптов исполняемы (проверятся против референс-решений в Task 5).

---

## Task 5: Шаблоны задач + референс-решения (валидация оракулов)

**Files:**
- Create шаблоны: `tts/tasks/{r1-edit,r2-bugfix,r3-feature}/` (Rust-крейты), `tts/tasks/{t4-cli,t5-webapi}/` (bun-проекты), в каждом `TASK.md` (промпт).
- Create refs/hidden: `tts/oracles/refs/r2-median.rs`, `tts/oracles/hidden/r3-palindrome.rs`.

**Interfaces:**
- Produces: `tasks/<id>/TASK.md` — текст задачи для агента (с инструкцией самопроверки).

- [ ] **Step 1: r1-edit крейт**

`tts/tasks/r1-edit/Cargo.toml`:
```toml
[package]
name = "greet"
version = "0.1.0"
edition = "2021"
```
`tts/tasks/r1-edit/src/lib.rs`:
```rust
pub fn greet(name: &str) -> String {
    format!("Hello, {name}!")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn greets() {
        assert_eq!(greet("World"), "Hello, World!");
    }
}
```
`tts/tasks/r1-edit/TASK.md`:
```
Измени приветствие в src/lib.rs: префикс "Hello, " должен стать "Hi, " (и в функции, и в тесте), чтобы `cargo test` проходил. Не завершай, пока не убедишься сам: запусти `cargo test` и увидь зелёный результат.
```

- [ ] **Step 2: r2-bugfix крейт (баг + красный тест) + ref**

`tts/tasks/r2-bugfix/Cargo.toml`:
```toml
[package]
name = "bugfix"
version = "0.1.0"
edition = "2021"
```
`tts/tasks/r2-bugfix/src/lib.rs`:
```rust
// Считает медиану. Для чётной длины должен усреднять два центральных элемента.
pub fn median(xs: &mut Vec<i64>) -> f64 {
    xs.sort();
    let n = xs.len();
    if n % 2 == 1 {
        xs[n / 2] as f64
    } else {
        // BUG: оба индекса одинаковы — усредняется один и тот же элемент.
        (xs[n / 2] as f64 + xs[n / 2] as f64) / 2.0
    }
}
```
`tts/tasks/r2-bugfix/tests/median.rs`:
```rust
use bugfix::median;
#[test]
fn even_len() { assert_eq!(median(&mut vec![1, 2, 3, 4]), 2.5); }
#[test]
fn odd_len()  { assert_eq!(median(&mut vec![5, 1, 3]), 3.0); }
```
`tts/oracles/refs/r2-median.rs` — точная копия `tests/median.rs` выше (для diff-сверки).
`tts/tasks/r2-bugfix/TASK.md`:
```
`cargo test` красный: тест even_len падает. Почини баг в src/lib.rs так, чтобы оба теста прошли. НЕ меняй файл tests/median.rs. Проверь сам: запусти `cargo test` до зелёного.
```

- [ ] **Step 3: r3-feature крейт + скрытый тест**

`tts/tasks/r3-feature/Cargo.toml`:
```toml
[package]
name = "palindrome"
version = "0.1.0"
edition = "2021"
```
`tts/tasks/r3-feature/src/lib.rs`:
```rust
// Реализуй здесь публичную функцию is_palindrome (см. TASK.md).
```
`tts/oracles/hidden/r3-palindrome.rs`:
```rust
use palindrome::is_palindrome;
#[test]
fn plain() { assert!(is_palindrome("level")); }
#[test]
fn mixed_case_spaces() { assert!(is_palindrome("A man a plan a canal Panama")); }
#[test]
fn unicode() { assert!(is_palindrome("а роза упала на лапу азора".replace(' ', "").as_str()) == true || is_palindrome("шалаш")); }
#[test]
fn negative() { assert!(!is_palindrome("rust")); }
```
`tts/tasks/r3-feature/TASK.md`:
```
Добавь в src/lib.rs публичную функцию `pub fn is_palindrome(s: &str) -> bool`, которая проверяет палиндром без учёта регистра и пробелов, корректно работая с unicode. Добавь свои модульные тесты. Проверь сам: `cargo test` должен быть зелёным.
```

- [ ] **Step 4: t4-cli bun-проект**

`tts/tasks/t4-cli/package.json`:
```json
{ "name": "lc", "module": "index.ts", "type": "module", "devDependencies": { "typescript": "^5" } }
```
`tts/tasks/t4-cli/tsconfig.json`:
```json
{ "compilerOptions": { "strict": true, "target": "ESNext", "module": "ESNext", "moduleResolution": "bundler", "types": ["bun-types"], "noEmit": true } }
```
`tts/tasks/t4-cli/index.ts`:
```ts
// Реализуй CLI `lc` здесь (см. TASK.md).
```
`tts/tasks/t4-cli/TASK.md`:
```
Собери CLI-утилиту в index.ts (запуск `bun run index.ts <file>`): по умолчанию печатает число строк, слов и байт файла-аргумента (три числа). Флаг `--lines` печатает только число строк, `--words` — только число слов. Проверь сам через `bunx tsc --noEmit` и `bun run index.ts` на тестовом файле.
```

- [ ] **Step 5: t5-webapi bun-проект**

`tts/tasks/t5-webapi/package.json`:
```json
{ "name": "todoapi", "module": "index.ts", "type": "module", "devDependencies": { "typescript": "^5" } }
```
`tts/tasks/t5-webapi/tsconfig.json` — идентичен t4-cli.
`tts/tasks/t5-webapi/index.ts`:
```ts
// Реализуй HTTP JSON API здесь (см. TASK.md).
```
`tts/tasks/t5-webapi/TASK.md`:
```
Собери in-memory Todo JSON API на Bun.serve в index.ts. Порт берётся из флага `--port` (по умолчанию 3000). Эндпоинты:
  POST   /todos      тело {"title": string} -> 200, JSON {"id": string, "title": string}
  GET    /todos      -> 200, JSON-массив всех todo
  DELETE /todos/:id  -> 204 (или 200), удаляет
Хранение в памяти. Проверь сам: `bunx tsc --noEmit` чисто, сервер поднимается, эндпоинты отвечают.
```

- [ ] **Step 6: Валидировать оракулы на референс-решениях**

Прогнать каждый оракул на скретче с ПРАВИЛЬНЫМ решением (написать эталон вручную в tmp-копии) и на нетронутом шаблоне. Пример для r2:
```bash
cd /code/work/llm-bench/tts; D=$(mktemp -d); cp -r tasks/r2-bugfix/* "$D/"
bash oracles/r2-bugfix.sh "$D"; echo "unsolved rc=$? (ожидаем !=0)"
# починить руками:
sed -i 's#xs\[n / 2\] as f64 + xs\[n / 2\]#xs[n / 2 - 1] as f64 + xs[n / 2]#' "$D/src/lib.rs"
bash oracles/r2-bugfix.sh "$D"; echo "solved rc=$? (ожидаем 0)"
```
Аналогично проверить r1/r3/t4/t5 (для t4/t5 написать минимальный эталон, убедиться pass). Expected: нетронутый шаблон → fail, эталон → pass, для КАЖДОЙ задачи.

- [ ] **Step 7: Checkpoint** — все 5 оракулов различают «решено/не решено».

---

## Task 5b: Реестр моделей (`models.mjs`)

**Files:**
- Create: `tts/lib/models.mjs`

**Interfaces:**
- Produces: `MODELS` — массив `{key, model, harnessModelId?, thinking, provider, local}`; `TASKS` — `[{id, lang, timeoutMs}]`.

- [ ] **Step 1: Реализация (slug'и — из CONTRACT.md Task 1)**

`tts/lib/models.mjs`:
```js
// * provider-префикс для omp/pi: openrouter/... или llama-server/...
// ! slug'и сверены в Task 1 (CONTRACT.md); local=true → фаза B/C, требует загрузки в 3090.
export const MODELS = [
  { key: "ds-3.2",     model: "openrouter/deepseek/deepseek-v3.2",         thinking: "high", local: false },
  { key: "ds-v4-pro",  model: "openrouter/deepseek/deepseek-v4-pro",       thinking: "high", local: false },
  { key: "sonnet-4.5", model: "openrouter/anthropic/claude-sonnet-4.5",    thinking: "high", local: false },
  { key: "sonnet-5",   model: "openrouter/anthropic/claude-sonnet-5",      thinking: "high", local: false },
  { key: "opus-4.8",   model: "openrouter/anthropic/claude-opus-4.8",      thinking: "high", local: false },
  { key: "haiku",      model: "openrouter/anthropic/claude-haiku-4.5",     thinking: "high", local: false },
  { key: "ornith-35b", model: "llama-server/ornith-1.0-35b",               thinking: "high", local: true, phase: "B" },
  { key: "qwen-coder-next", model: "llama-server/qwen3-coder-next",        thinking: "off",  local: true, phase: "C" },
];

export const TASKS = [
  { id: "r1-edit",   lang: "rust", timeoutMs: 15 * 60000 },
  { id: "r2-bugfix", lang: "rust", timeoutMs: 15 * 60000 },
  { id: "r3-feature",lang: "rust", timeoutMs: 15 * 60000 },
  { id: "t4-cli",    lang: "ts",   timeoutMs: 20 * 60000 },
  { id: "t5-webapi", lang: "ts",   timeoutMs: 20 * 60000 },
];

export const HARNESSES = ["omp", "pi"];
export const STEER_CAP = 3; // раундов дошагивания
```

- [ ] **Step 2: Checkpoint** — `node -e "import('./lib/models.mjs').then(m=>console.log(m.MODELS.length, m.TASKS.length))"` → `8 5`.

---

## Task 6: Драйвер матрицы (`run-tts.mjs`) + guided-дошагивание

**Files:**
- Create: `tts/run-tts.mjs`

**Interfaces:**
- Consumes: `makeScratch/cleanupScratch` (scratch.mjs), `runAgent` (harness.mjs), `runOracle` (oracle.mjs), `MODELS/TASKS/HARNESSES/STEER_CAP` (models.mjs).
- Produces: `results-tts.json` — массив записей (см. спека, «Метрики на запись»). Идемпотентен по ключу `harness|model|task` (существующие не переигрывает без `--force`).

- [ ] **Step 1: Реализация драйвера**

`tts/run-tts.mjs`:
```js
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
    if (orc.pass) { rec.pass_guided = true; rec.tts_guided_s = rec.tts_single_s; return finish(rec, scratch, cellT0); }

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
    return finish(rec, scratch, cellT0);
  } catch (e) {
    rec.error = String(e?.message || e);
    return finish(rec, scratch, cellT0);
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
async function finish(rec, scratch, cellT0) { await cleanupScratch(scratch); return rec; }

// * Главный цикл: перебор ячеек с фильтрами по фазе/модели; локальные модели идут только в своей фазе.
const results = await loadResults();
const done = new Set(results.map((r) => keyOf(r.harness, r.model, r.task)));
for (const model of MODELS) {
  if (onlyModel && model.key !== onlyModel) continue;
  const phase = model.local ? model.phase : "A";
  if (onlyPhase && phase !== onlyPhase) continue;
  for (const task of TASKS) for (const harness of HARNESSES) {
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
console.log(`\nwrote ${results.length} records -> ${OUT}`);
```

- [ ] **Step 2: Smoke — одна дешёвая ячейка**

Run (haiku × r1 × omp; требует OpenRouter-ключ в окружении omp):
```bash
cd /code/work/llm-bench/tts && node run-tts.mjs --model haiku --phase A 2>&1 | tail -20
```
Expected: логи `RUN … / DONE …`, `results-tts.json` содержит запись haiku по 5 задачам × 2 харнесса; у r1 `pass_single` или `pass_guided`=true, `tts_single_s`>0.

- [ ] **Step 3: Checkpoint** — файл валиден (`node -e "JSON.parse(require('fs').readFileSync('results-tts.json'))"`); хотя бы одна ячейка прошла оракул.

---

## Task 7: Конфиги харнессов + llama-server на gaming-pc

**Files:**
- Modify: `~/.omp/agent/models.yml` (+ провайдер llama-server уже есть; добавить модель `qwen3-coder-next`)
- Modify: `~/.pi/agent/models.json` (+ провайдеры openrouter и llama-server, + модели ornith/qwen — формат JSON)
- Create: `tts/serve-ornith.ps1`, `tts/serve-qwen.ps1` (для gaming-pc)

- [ ] **Step 1: Добавить qwen в omp models.yml**

В блок `llama-server.models` (`~/.omp/agent/models.yml`) добавить:
```yaml
      - id: qwen3-coder-next
        name: Qwen3-Coder-Next 80B-A3B (llama-server, offload)
        contextWindow: 262144
        input:
          - text
        reasoning: false
```

- [ ] **Step 2: Настроить pi models.json (паритет)**

Прочитать `~/.pi/agent/models.json`, убедиться, что есть провайдеры `openrouter` (с ключом из env `OPENROUTER_API_KEY`/secret) и `llama-server` (`baseUrl http://gaming-pc.lan:8080/v1`, `auth none`), и модели `ornith-1.0-35b` + `qwen3-coder-next`. Если нет — добавить по образцу omp (см. `models.yml`), в JSON-синтаксисе pi. Сохранить бэкап `models.json.bak-tts-20260720` перед правкой.

- [ ] **Step 3: Проверить оба харнесса видят локальную модель (когда поднята)**

После запуска llama-server (Step 4) — `omp --model llama-server/ornith-1.0-35b --mode json --no-session -p "ok"` и то же для `pi`. Expected: оба отвечают.

- [ ] **Step 4: Скрипты запуска llama-server (gaming-pc, Windows)**

`tts/serve-ornith.ps1`:
```powershell
# Поднять llama-server с ornith на :8080 (direct). ASCII-only (WPS 5.1 cp1252 гоча).
D:\llama\llama-server.exe -m D:\models\ornith-1.0-35b-Q4_K_M.gguf `
  --n-gpu-layers 99 --flash-attn on --ctx-size 32768 --host 0.0.0.0 --port 8080 --jinja
```
`tts/serve-qwen.ps1` (champion-конфиг из прошлой сессии):
```powershell
D:\llama\llama-server.exe -m D:\models\Qwen3-Coder-Next-Q4_K_M.gguf `
  --n-gpu-layers 99 --n-cpu-moe 26 --flash-attn on `
  --cache-type-k q8_0 --cache-type-v q8_0 `
  --ctx-size 32768 --threads 6 --batch-size 2048 --ubatch-size 512 --host 0.0.0.0 --port 8080 --jinja
```
Загрузка на gaming-pc и запуск — через scheduled task (паттерн прошлой сессии; LogonType Interactive для доступа к GPU). Проверить путь к `llama-server.exe` и точные имена gguf на `D:\models` перед запуском.

- [ ] **Step 5: Checkpoint** — `curl -s http://gaming-pc.lan:8080/v1/models` отвечает при поднятом сервере; оба харнесса маршрутизируют локальную модель.

---

## Task 8: Прогон полной матрицы (фазы A → B → C)

**Files:** — (только генерация `results-tts.json`)

- [ ] **Step 1: Фаза A — OpenRouter (60 ячеек)**

Run (llama-server может быть выключен):
```bash
cd /code/work/llm-bench/tts && nohup node run-tts.mjs --phase A > results/tts-phaseA.log 2>&1 &
```
Следить: `tail -f results/tts-phaseA.log`. Expected: 6 моделей × 5 задач × 2 харнесса = 60 записей.

- [ ] **Step 2: Фаза B — ornith**

Поднять `serve-ornith.ps1` на gaming-pc, дождаться `/v1/models`, затем:
```bash
cd /code/work/llm-bench/tts && node run-tts.mjs --phase B 2>&1 | tee results/tts-phaseB.log
```
Expected: +10 записей (ornith × 5 × 2).

- [ ] **Step 3: Фаза C — qwen**

Остановить ornith, поднять `serve-qwen.ps1`, дождаться `/v1/models`, затем:
```bash
cd /code/work/llm-bench/tts && node run-tts.mjs --phase C 2>&1 | tee results/tts-phaseC.log
```
Expected: +10 записей. Итого `results-tts.json` = 80.

- [ ] **Step 4: Пост-сверка стоимости с дашбордом OpenRouter**

Суммировать `cost_guided_usd` по OpenRouter-ячейкам:
```bash
cd /code/work/llm-bench/tts && node -e "const r=require('./results-tts.json');const or=r.filter(x=>!['ornith-35b','qwen-coder-next'].includes(x.model));console.log('OR cells:',or.length,'sum \$',or.reduce((s,x)=>s+(x.cost_guided_usd||0),0).toFixed(4))"
```
Сверить сумму с дашбордом OpenRouter за окно прогона; расхождение (известна гоча занижения) зафиксировать в отчёте.

- [ ] **Step 5: Checkpoint** — `results-tts.json` содержит 80 записей, `parsed`-метрики ненулевые для успешных ячеек.

---

## Task 9: Выгрузка в Google Sheets (`gsheets_tts.py`)

**Files:**
- Create: `/code/work/llm-bench/gsheets_tts.py`

**Interfaces:**
- Consumes: `gsheets_common.credentials()`; `tts/results-tts.json`.
- Produces: новые вкладки в книге «LLM Benchmark»: `TTS raw 20.07`, `TTS omp-vs-pi 20.07`.

- [ ] **Step 1: Реализация**

`/code/work/llm-bench/gsheets_tts.py`:
```python
"""Выгрузка time-to-solution бенчмарка (omp vs pi) в книгу «LLM Benchmark».
SA не может создать новый файл (нулевая Drive-квота) -> только новые вкладки.
Запуск: /code/work/llm-bench/.venv-gsheets/bin/python gsheets_tts.py
"""
import json, os, statistics as st
import gspread, gsheets_common

SID = "1mhSrYrJU0mIte3nBQ7RHiRTiFXNfZ72QrfRa_WiPhRM"
RES = os.path.join(os.path.dirname(__file__), "tts", "results-tts.json")
rows = json.load(open(RES))

gc = gspread.authorize(gsheets_common.credentials())
sh = gc.open_by_key(SID)

def fresh(title, r, c):
    try: sh.del_worksheet(sh.worksheet(title))
    except gspread.WorksheetNotFound: pass
    return sh.add_worksheet(title=title, rows=r, cols=c)

# --- (a) сырая матрица ---
raw = fresh("TTS raw 20.07", len(rows) + 5, 20)
hdr = ["harness","model","task","lang","TTS_single_s","TTS_guided_s","pass_single","pass_guided",
       "steer_rounds","$_single","$_guided","tok_in","tok_out","tok_reason","tool_calls","turns",
       "finish","timeout","error"]
data = [hdr] + [[r.get(k) for k in
        ["harness","model","task","lang","tts_single_s","tts_guided_s","pass_single","pass_guided",
         "steering_rounds","cost_single_usd","cost_guided_usd","tokens_in","tokens_out","tokens_reason",
         "tool_calls","turns","finish_reason","timeout_hit","error"]] for r in rows]
raw.update(values=data, range_name="A1")
raw.format("A1:S1", {"textFormat": {"bold": True}})

# --- (b) сводка omp vs pi по (model x task) ---
def find(h, m, t):
    return next((r for r in rows if r["harness"]==h and r["model"]==m and r["task"]==t), None)
models = [r["model"] for r in rows]; models = list(dict.fromkeys(models))
tasks  = [r["task"]  for r in rows]; tasks  = list(dict.fromkeys(tasks))
cmp = fresh("TTS omp-vs-pi 20.07", len(models)*len(tasks) + 5, 12)
chdr = ["model","task","omp_TTS_guided","pi_TTS_guided","dTTS(pi-omp)","omp_pass","pi_pass",
        "omp_$","pi_$","omp_rounds","pi_rounds"]
cdata = [chdr]
for m in models:
    for t in tasks:
        o = find("omp", m, t); p = find("pi", m, t)
        if not o or not p: continue
        og, pg = o.get("tts_guided_s"), p.get("tts_guided_s")
        d = round(pg - og, 1) if (og is not None and pg is not None) else None
        cdata.append([m, t, og, pg, d, o["pass_guided"], p["pass_guided"],
                      o["cost_guided_usd"], p["cost_guided_usd"], o["steering_rounds"], p["steering_rounds"]])
cmp.update(values=cdata, range_name="A1")
cmp.format("A1:K1", {"textFormat": {"bold": True}})

print("OK ->", sh.url)
```

- [ ] **Step 2: Запуск**

Run: `cd /code/work/llm-bench && .venv-gsheets/bin/python gsheets_tts.py`
Expected: `OK -> https://docs.google.com/…`; в книге появились вкладки `TTS raw 20.07` и `TTS omp-vs-pi 20.07`.

- [ ] **Step 3: Checkpoint** — обе вкладки заполнены, число строк raw = числу записей в `results-tts.json`.

---

## Task 10: Отчёт в vault + дневная заметка

**Files:**
- Create: `/sync/Homie/Obsidian/Primary/claudedocs/time-to-solution-omp-vs-pi-bench.md`
- Modify: `/sync/Homie/Obsidian/Primary/personal/daily-notes/2026/07/20.07.2026.md`

- [ ] **Step 1: Написать отчёт**

Разделы: TL;DR (кто быстрее доставляет решение и кто дешевле по OpenRouter); методология (single vs guided, оракулы, паритет харнессов); таблица TTS по задачам; **omp vs pi** — дельты времени/стоимости/шагов/pass-rate с выводом, какой харнесс эффективнее и почему; локальные vs OpenRouter (скорость $0 vs cost-to-solution); пост-сверка cost с дашбордом OpenRouter; гочи (JSON-контракт, continue-механизм, pi approval, 3090-сериализация); ссылка на Sheets. Backtick-ить весь код, даты `[[20.07.2026]]`, без hard-wrap.

- [ ] **Step 2: Строка в дневной заметке**

Добавить в `20.07.2026.md` буллет: краткое описание бенчмарка time-to-solution со ссылкой `[[claudedocs/time-to-solution-omp-vs-pi-bench]]`, тег `#by/claude`.

- [ ] **Step 3: Checkpoint** — отчёт открывается, ссылки/бэклинки валидны, дневная заметка обновлена.

---

## Self-Review (заполнено автором плана)

**Spec coverage:** матрица 8×2×5 (Task 5b/6/8) ✔; single+guided (Task 6) ✔; оракулы Rust×3+TS×2 (Task 4/5) ✔; стоимость `usage.cost` single+guided + пост-сверка (Task 3/6/8) ✔; паритет харнессов (Task 3/7, Global Constraints) ✔; 3090-сериализация фазами (Task 7/8) ✔; Sheets новая вкладка + omp-vs-pi сводка (Task 9) ✔; vault + daily note (Task 10) ✔; неизвестные внешних инструментов сняты до кода (Task 1) ✔.

**Placeholder scan:** промпты задач (`TASK.md`) и код модулей приведены целиком; единственные помеченные точки адаптации (`? CONTRACT.md`) опираются на реальный вывод Task 1, а не на «TODO». Референс/скрытые тесты приведены полным кодом.

**Type consistency:** `runAgent` возвращает `{code,stdout,stderr,wallMs,killed,metrics}` — используется так в `run-tts.mjs`; `normalizeResult` поля (`cost,tokensIn,tokensOut,tokensReason,finishReason,toolCalls,turns`) совпадают с обращениями в `accumulate`; `runOracle -> {pass,log}` совпадает с использованием; ключи записи совпадают между `run-tts.mjs` и `gsheets_tts.py`.
