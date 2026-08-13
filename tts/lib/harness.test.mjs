import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildArgv, deepFind, normalizeResult } from "./harness.mjs";

test("buildArgv: omp non-interactive json includes --cwd", () => {
  const a = buildArgv("omp", { model: "openrouter/anthropic/claude-haiku-4.5", cwd: "/tmp/x", thinking: "high", prompt: "do it" });
  assert.ok(a.includes("--mode") && a[a.indexOf("--mode") + 1] === "json");
  assert.ok(a.includes("--no-session"));
  assert.ok(a.includes("-p") && a.at(-1) === "do it");
  assert.ok(a.includes("--cwd") && a[a.indexOf("--cwd") + 1] === "/tmp/x");
  assert.ok(!a.includes("--approve"));
});

test("buildArgv: pi has NO --cwd flag (verified in Task 1)", () => {
  const a = buildArgv("pi", { model: "openrouter/anthropic/m", cwd: "/tmp/x", prompt: "go" });
  assert.ok(!a.includes("--cwd"));
});

test("buildArgv: pi adds --approve and continue uses session-dir", () => {
  const a = buildArgv("pi", { model: "openrouter/anthropic/m", cwd: "/tmp/x", sessionDir: "/tmp/s", continueSession: true, prompt: "go" });
  assert.ok(a.includes("--approve"));
  assert.ok(a.includes("--session-dir"));
  assert.ok(a[a.indexOf("--session-dir") + 1] === "/tmp/s");
  assert.ok(a.includes("--continue"));
  assert.ok(!a.includes("--no-session"));
});

// * Root-caused [[20.07.2026]] (after an earlier misdiagnosis of pi as generically "flaky"):
// * bare `--model openrouter/anthropic/claude-*` hangs pi indefinitely because pi has its OWN
// * native "anthropic" provider and the full triple string routes ambiguously between it and
// * the openrouter provider. Fix: split on the FIRST "/" into --provider + --model for pi only.
test("buildArgv: pi splits provider/model on first slash (native-provider hang fix)", () => {
  const a = buildArgv("pi", { model: "openrouter/anthropic/claude-haiku-4.5", cwd: "/tmp/x", prompt: "go" });
  assert.ok(a.includes("--provider") && a[a.indexOf("--provider") + 1] === "openrouter");
  assert.ok(a.includes("--model") && a[a.indexOf("--model") + 1] === "anthropic/claude-haiku-4.5");
  assert.ok(!a.includes("openrouter/anthropic/claude-haiku-4.5"));
});

test("buildArgv: pi splits provider/model for local llama-server slugs too", () => {
  const a = buildArgv("pi", { model: "llama-server/ornith-1.0-35b", cwd: "/tmp/x", prompt: "go" });
  assert.ok(a.includes("--provider") && a[a.indexOf("--provider") + 1] === "llama-server");
  assert.ok(a.includes("--model") && a[a.indexOf("--model") + 1] === "ornith-1.0-35b");
});

test("buildArgv: omp keeps the full provider/model string as one --model value, no --provider", () => {
  const a = buildArgv("omp", { model: "openrouter/anthropic/claude-haiku-4.5", cwd: "/tmp/x", prompt: "go" });
  assert.ok(a.includes("--model") && a[a.indexOf("--model") + 1] === "openrouter/anthropic/claude-haiku-4.5");
  assert.ok(!a.includes("--provider"));
});

// * Root-caused [[20.07.2026]] (third and correct diagnosis, after "generic flakiness" and
// * "provider-routing" were both ruled out by direct verification): pi does startup NETWORK
// * operations by default (fetching/updating its configured `packages` -- settings.json lists
// * git:github.com/obra/superpowers, npm packages), which intermittently hangs with zero
// * stdout. pi ships --offline exactly for this ("Disable startup network operations", same
// * as PI_OFFLINE=1). omp has no equivalent flag (checked `omp --help` -- no offline/update/
// * network-disable option exists), so this fix is necessarily asymmetric.
test("buildArgv: pi gets --offline (startup-network-hang fix), omp does not (no equivalent flag exists)", () => {
  const pi = buildArgv("pi", { model: "openrouter/anthropic/claude-haiku-4.5", cwd: "/tmp/x", prompt: "go" });
  assert.ok(pi.includes("--offline"));
  const omp = buildArgv("omp", { model: "openrouter/anthropic/claude-haiku-4.5", cwd: "/tmp/x", prompt: "go" });
  assert.ok(!omp.includes("--offline"));
});

test("deepFind finds nested key case-insensitively", () => {
  assert.equal(deepFind({ a: { Total_Cost: 0.42 } }, ["total_cost"]), 0.42);
});

test("normalizeResult parses omp fixture: cost/tokens summed from turn_end usage", async () => {
  const s = await readFile(new URL("../fixtures/omp-sample.json", import.meta.url), "utf8");
  const r = normalizeResult(s);
  assert.equal(r.parsed, true);
  assert.ok(r.cost > 0, `expected cost > 0, got ${r.cost}`);
  assert.ok(r.tokensOut > 0, `expected tokensOut > 0, got ${r.tokensOut}`);
  assert.equal(r.turns, 1);
  assert.equal(r.finishReason, "stop");
  // omp fixture: usage.input=10, output=49, reasoningTokens=44, cost.total=0.0497425 (single turn_end)
  assert.equal(r.tokensIn, 10);
  assert.equal(r.tokensOut, 49);
  assert.equal(r.tokensReason, 44);
  assert.ok(Math.abs(r.cost - 0.0497425) < 1e-9);
});

test("normalizeResult parses pi fixture: reasoning key differs (usage.reasoning, not reasoningTokens)", async () => {
  const s = await readFile(new URL("../fixtures/pi-sample.json", import.meta.url), "utf8");
  const r = normalizeResult(s);
  assert.equal(r.parsed, true);
  assert.ok(r.cost > 0, `expected cost > 0, got ${r.cost}`);
  assert.ok(r.tokensOut > 0, `expected tokensOut > 0, got ${r.tokensOut}`);
  assert.equal(r.turns, 1);
  assert.equal(r.finishReason, "stop");
  assert.equal(r.tokensIn, 10);
  assert.equal(r.tokensOut, 279);
  assert.equal(r.tokensReason, 179);
  assert.ok(Math.abs(r.cost - 0.01181565) < 1e-9);
});

test("normalizeResult: unparsable stdout returns parsed:false with zeroed metrics", () => {
  const r = normalizeResult("not json at all\nnope either");
  assert.equal(r.parsed, false);
  assert.equal(r.cost, 0);
  assert.equal(r.tokensIn, 0);
  assert.equal(r.tokensOut, 0);
  assert.equal(r.tokensReason, 0);
  assert.equal(r.finishReason, null);
});

// * Гарантия против регрессии "прочитать только последний turn_end вместо суммы по всем":
// * оба реальных фикстура (omp/pi-sample.json) однотурновые, поэтому сумма и "последний"
// * дают один и тот же результат -- ничто в них не отличило бы будущее упрощение
// * normalizeResult до "взять только последний turn_end". Синтетический двухтурновый
// * NDJSON ниже специально делает суммы != последнему турну на каждом числовом поле,
// * плюс разносит ключ reasoning-токенов по турнам (omp-стиль в турне 1, pi-стиль в турне 2),
// * чтобы coalesce (usage.reasoningTokens ?? usage.reasoning) был проверен МЕЖДУ турнами,
// * а не только между фикстурами разных харнессов. Форма событий (type, message.usage.cost.total
// * nesting) списана 1:1 с реальных фикстур.
test("normalizeResult: synthetic 2-turn NDJSON sums across turn_end (not last-turn-only), counts tool_execution_end", () => {
  const events = [
    { type: "session" },
    { type: "agent_start" },
    { type: "turn_start" },
    {
      type: "turn_end",
      message: {
        role: "assistant",
        model: "anthropic/claude-haiku-4.5",
        usage: {
          input: 100,
          output: 200,
          reasoningTokens: 25, // * omp-стиль ключа
          totalTokens: 300,
          cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.02 },
        },
        stopReason: "tool_use",
      },
      toolResults: [],
    },
    { type: "tool_execution_start" },
    { type: "tool_execution_end" },
    { type: "turn_start" },
    {
      type: "turn_end",
      message: {
        role: "assistant",
        model: "anthropic/claude-haiku-4.5",
        usage: {
          input: 50,
          output: 150,
          reasoning: 15, // * pi-стиль ключа -- на другом турне той же сессии
          totalTokens: 200,
          cost: { input: 0.0005, output: 0.0015, cacheRead: 0, cacheWrite: 0, total: 0.03 },
        },
        stopReason: "stop",
      },
      toolResults: [],
    },
    {
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "do the thing" }] },
        { role: "assistant", content: [{ type: "text", text: "..." }], stopReason: "tool_use" },
        { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
      ],
    },
  ];
  const ndjson = events.map((e) => JSON.stringify(e)).join("\n");

  const r = normalizeResult(ndjson);
  assert.equal(r.parsed, true);
  assert.equal(r.turns, 2);
  assert.equal(r.toolCalls, 1);
  // * Суммы по двум турнам, round numbers чтобы регрессия "только последний турн" была
  // * заметна сразу (последний турн в одиночку дал бы 50/150/15/0.03 -- всё меньше суммы).
  assert.equal(r.tokensIn, 150);
  assert.equal(r.tokensOut, 350);
  assert.equal(r.tokensReason, 40);
  assert.ok(Math.abs(r.cost - 0.05) < 1e-9);
  assert.equal(r.finishReason, "stop");
});
