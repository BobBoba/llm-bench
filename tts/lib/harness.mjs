import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { cleanEnv } from "./scratch.mjs";

const OMP_BIN = `${process.env.HOME}/.bun/bin/omp`;
const PI_BIN = `${process.env.HOME}/.nvm/versions/node/v24.10.0/bin/pi`;

export function binFor(harness) {
  return harness === "omp" ? OMP_BIN : PI_BIN;
}

// * Единый argv для неинтерактивного JSON-прогона.
// ! pi НЕ поддерживает --cwd (CONTRACT.md, п.3: "pi does NOT support --cwd" — падает с
// !   "Error: Unknown option: --cwd"). Рабочий каталог для pi задаётся только через spawn({cwd}),
// !   которое уже проставлено в runAgent ниже. omp, наоборот, флаг принимает и мы его передаём явно.
export function buildArgv(harness, { model, cwd, thinking = "high", sessionDir, continueSession, prompt }) {
  const a = [];
  // ! pi's bare `--model openrouter/anthropic/claude-*` hangs indefinitely: pi ships its OWN
  // !   native "anthropic" provider, and a full "openrouter/anthropic/..." model string routes
  // !   ambiguously between that native provider and the openrouter provider, wedging pi before
  // !   it ever emits a "session" event. Root-caused [[20.07.2026]] after an earlier misdiagnosis
  // !   (blamed generic pi flakiness). Proven fix: split on the FIRST "/" into provider + model
  // !   and pass them as separate flags -- "--provider openrouter --model anthropic/claude-haiku-4.5"
  // !   resolves in ~3s. Only pi needs this; omp has no such native-provider name clash and keeps
  // !   taking the full "provider/model" string as one `--model` value.
  if (harness === "pi") {
    const slash = model.indexOf("/");
    const provider = model.slice(0, slash);
    const rest = model.slice(slash + 1);
    a.push("--provider", provider, "--model", rest);
  } else {
    a.push("--model", model);
  }
  if (harness === "omp") a.push("--cwd", cwd);
  a.push("--mode", "json");
  if (thinking) a.push("--thinking", thinking);
  if (sessionDir) {
    a.push("--session-dir", sessionDir);
    if (continueSession) a.push("--continue");
  } else {
    a.push("--no-session");
  }
  // * Оба харнесса в -p (неинтерактивном) режиме не виснут на подтверждении tool-call'ов без TTY
  // * (CONTRACT.md, п.4). --approve для pi оставлен ради единообразия с omp, хотя формально
  // * документирован как "доверять локальным файлам проекта", а не auto-approve.
  if (harness === "pi") a.push("--approve");
  // ! Настоящая причина периодических "hang с нулевым stdout" у pi (найдена [[20.07.2026]],
  // !   после двух предыдущих ошибочных гипотез -- generic flakiness и provider-routing):
  // !   pi по умолчанию делает СЕТЕВЫЕ startup-операции (обновление/фетч своих настроенных
  // !   "packages" из settings.json -- npm:context-mode, git:github.com/obra/superpowers),
  // !   и это иногда виснет без единого байта на stdout. У pi есть штатный флаг именно для
  // !   этого: --offline ("Disable startup network operations", эквивалент PI_OFFLINE=1).
  // !   omp такого поведения не показывает и эквивалентного флага в `omp --help` НЕТ --
  // !   поэтому здесь фикс асимметричен по необходимости, а не для удобства.
  if (harness === "pi") a.push("--offline");
  // ! Личный глобальный конфиг оператора (~/.pi/agent/settings.json "packages":
  // !   npm:context-mode + git:superpowers; ~/.omp/agent/config.yml — тот же набор skill:*
  // !   записей) иначе подмешивается в КАЖДЫЙ прогон обоих харнессов. Обнаружено при smoke
  // !   Task 6 [[20.07.2026]]: pi без этих флагов реально подключается к OpenRouter (не hang),
  // !   но auto-invoke'ит skill "superpowers:using-superpowers" (его собственное описание
  // !   требует "invocation before ANY response") на КАЖДОМ ходу, тратя весь turn на
  // !   рассуждения о skill-системе вместо r1-edit задачи -- ячейка съела все 15 минут
  // !   бюджета и не прошла оракул (см. results-tts.json до фикса: pi|haiku|r1-edit,
  // !   tts_single_s=900.1, timeout_hit=true). omp с тем же личным конфигом в тесте прошёл
  // !   чисто (13.4s), но флаги добавлены СИММЕТРИЧНО на оба харнесса -- иначе сравнение
  // !   omp vs pi было бы нечестным (одна модель отвечает "чисто", другая тащит чужой
  // !   skill/extension каталог оператора). --no-extensions/--no-skills поддержаны обоими
  // !   харнессами один-в-один по имени флага; --no-context-files/--no-prompt-templates --
  // !   только у pi, --no-rules -- только у omp (см. `<bin> --help`).
  a.push("--no-extensions", "--no-skills");
  a.push(harness === "pi" ? "--no-context-files" : "--no-rules");
  if (harness === "pi") a.push("--no-prompt-templates");
  a.push("-p", prompt);
  return a;
}

// * Рекурсивный поиск первого не-объектного значения по любому из имён ключей (регистронезависимо).
// * Оставлен как fallback-утилита для скалярных полей, не покрытых явной суммой по turn_end
// * (см. normalizeResult) — сама сумма cost/tokens больше НЕ идёт через deepFind, а читает
// * точные пути из CONTRACT.md, потому что generic key-search для cost вернул бы вложенный
// * объект usage.cost целиком, а не его поле .total.
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

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : undefined;
};

// * Нормализует NDJSON-вывод omp/pi (--mode json) в плоскую запись метрик.
// * Контракт подтверждён реальными пробниками против OpenRouter (CONTRACT.md):
// *  - usage навешан на КАЖДОЕ assistant-сообщение и относится ТОЛЬКО к одному API-вызову
// *    (не кумулятивен по сессии) -> итог по всему прогону = сумма usage по всем turn_end.
// *  - cost лежит в usage.cost.total (вложенный объект) -- explicit path, не generic key-search.
// *  - имя ключа reasoning-токенов различается между харнессами: omp -> usage.reasoningTokens,
// *    pi -> usage.reasoning. Совмещаем через coalesce (??), никогда не оба сразу.
// *  - totalTokens провайдер уже включает reasoning внутри output -- поэтому tokensReason
// *    НИКОГДА не прибавляется поверх tokensOut/totalTokens, только возвращается отдельным полем.
export function normalizeResult(stdout) {
  const text = (stdout || "").trim();
  const events = [];
  if (text) {
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        events.push(JSON.parse(s));
      } catch {
        // * Пропускаем строку, которая не является валидным JSON (например обрывок вывода) --
        // * терпимость к частично битому NDJSON важнее падения всего разбора.
      }
    }
  }

  if (events.length === 0) {
    return {
      parsed: false,
      cost: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensReason: 0,
      finishReason: null,
      toolCalls: null,
      turns: null,
      raw: text.slice(-400),
    };
  }

  const turnEnds = events.filter((e) => e && e.type === "turn_end");

  let cost = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensReason = 0;
  for (const te of turnEnds) {
    const usage = te.message && te.message.usage;
    if (!usage) continue;
    cost += num(usage.cost && usage.cost.total) ?? 0;
    tokensIn += num(usage.input) ?? 0;
    tokensOut += num(usage.output) ?? 0;
    tokensReason += num(usage.reasoningTokens ?? usage.reasoning) ?? 0;
  }

  // * finishReason -- stopReason последнего assistant-сообщения из последнего agent_end;
  // * fallback на message.stopReason последнего turn_end, если agent_end почему-то отсутствует
  // * (например процесс убит по таймауту до его отправки).
  let finishReason = null;
  const agentEnds = events.filter((e) => e && e.type === "agent_end");
  if (agentEnds.length) {
    const lastAgentEnd = agentEnds[agentEnds.length - 1];
    const msgs = lastAgentEnd.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant" && msgs[i].stopReason) {
        finishReason = msgs[i].stopReason;
        break;
      }
    }
  }
  if (!finishReason && turnEnds.length) {
    const last = turnEnds[turnEnds.length - 1];
    finishReason = (last.message && last.message.stopReason) ?? null;
  }

  // * toolCalls -- считаем завершённые вызовы инструментов (tool_execution_end), а не попытки
  // * (tool_execution_start), чтобы не переучитывать оборванные/повторные попытки.
  const toolCalls = events.filter((e) => e && e.type === "tool_execution_end").length;

  return {
    parsed: true,
    cost,
    tokensIn,
    tokensOut,
    tokensReason,
    finishReason,
    toolCalls,
    turns: turnEnds.length,
  };
}

// * Один прогон агента. Убивает по timeoutMs (SIGKILL) ИЛИ по stall-watchdog'у, смотря что
// * сработает раньше. Возвращает wall-clock и нормализованные метрики.
// * stallMs -- belt-and-suspenders против редкого "hang с нулевым выводом" (см. --offline выше):
// * если от процесса дольше stallMs не пришло ни байта на stdout/stderr, значит он застрял
// * ДО начала стриминга (никакая полезная работа не идёт) -- добивать его раньше, чем истечёт
// * весь бюджет ячейки, чтобы одна зависшая попытка не съедала все 15/20 минут напрасно.
// * Реальный прогресс (стриминг toolCall/message_update) сбрасывает таймер стойла на каждый
// * байт, поэтому долгий, но ЖИВОЙ прогон (например компиляция внутри tool-call) не убивается.
export function runAgent(harness, opts, { timeoutMs, stallMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const argv = buildArgv(harness, opts);
    const t0 = performance.now();
    const env = cleanEnv();
    // ! Дублируем --offline через переменную окружения на случай, если сам флаг парсится
    // ! pi позже, чем успевают начаться сетевые startup-операции (PI_OFFLINE=1 читается
    // ! раньше в его bootstrap-коде, чем argv) -- см. CONTRACT.md-обновление [[20.07.2026]].
    if (harness === "pi") env.PI_OFFLINE = "1";
    // ! ROOT CAUSE зависаний pi (верифицировано [[20.07.2026]] через прямой spawn-тест):
    // ! pi в режиме -p читает stdin до EOF. При дефолтном stdio ребёнка stdin — ОТКРЫТЫЙ pipe,
    // ! который никогда не закрывается -> pi виснет вечно с нулевым выводом. omp stdin не читает,
    // ! поэтому симптом был только у pi. stdin: "ignore" даёт немедленный EOF (эквивалент </dev/null,
    // ! при котором pi всегда отвечал за ~2c). Применяем к обоим харнессам (omp это безвредно).
    const child = spawn(binFor(harness), argv, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let stalled = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    let stallTimer;
    const resetStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        killed = true;
        stalled = true;
        child.kill("SIGKILL");
      }, stallMs);
    };
    resetStallTimer(); // * старт отсчёта stall'а с момента спавна -- нулевой вывод с самого начала тоже стойло

    child.stdout.on("data", (d) => {
      stdout += d;
      resetStallTimer();
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      resetStallTimer();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(stallTimer);
      resolve({
        code,
        stdout,
        stderr,
        wallMs: performance.now() - t0,
        killed,
        stalled,
        metrics: normalizeResult(stdout),
      });
    });
  });
}
