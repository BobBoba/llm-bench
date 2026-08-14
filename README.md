# llm-bench

An oracle-graded LLM benchmark suite. The flagship battery is **hard-bench**: 22 tasks across 6 languages (Rust, TypeScript, Julia, C#, Bash, PowerShell), single-shot, scored by hidden test suites — not by another LLM. The repo also contains the standard code batteries, a knowledge battery, tool-use and long-context probes, and the reporting scripts that feed the public results sheet.

**Live results:** [Google Sheet (read-only)](https://docs.google.com/spreadsheets/d/1mhSrYrJU0mIte3nBQ7RHiRTiFXNfZ72QrfRa_WiPhRM) — tab **«Hard 6-lang 04.08»**: 30+ models (cloud via OpenRouter + local quants via llama.cpp-based servers), per-language solve rates, time-to-solution, cost, and the long-context slowdown factor.

## Why another benchmark

Most public coding benchmarks are saturated: half the frontier models score ~100% on typical single-shot suites, so they stop discriminating. This set was built after exactly that happened to our internal battery — models with `>80%` on ordinary tasks land anywhere between 0/22 and 20/22 here. A model scoring 83% on an easy suite scored **0/22** on this one.

## Task design

Each language gets up to 4 task types:

| Type | What it tests | Languages |
|---|---|---|
| `edit` | A **working** module with one planted, unnamed defect. Find and fix it *and* add a feature — without breaking the public API. Regression tests catch overcorrection, targeted tests catch the defect, feature tests catch the addition. | all 6 |
| `edit-long` | The **same** edit task, but the target file is buried in a deterministic, plausible generated repository of ~63k tokens (the model must locate it first). Since the defect and the tests are identical to `edit`, the pair isolates the cost of long context: solve-time ratio `edit-long / edit`. | Rust, TS, Julia, C# |
| `algo` | Algorithmic depth with adversarial hidden tests (rolling median with duplicate/eviction traps, adaptive integration with a narrow-peak trap, full semver precedence, range compression edge cases). | all 6 |
| `conc` | Correctness under real concurrency: bounded channels with backpressure (Condvar / `Monitor.Wait`), parallel executors with strict concurrency limits verified via `flock` counters and timing bounds, deadline-guarded tests that fail rather than hang. | all 6 |

The C# set deliberately **mirrors the Rust set** (same cache semantics, same defect, same channel contract): the Rust↔C# pair isolates *language* effect from *task* effect. In practice this caught a local model scoring 4/4 on C# and 1/4 on Rust on semantically identical tasks.

Task specifications are written in Russian. Handling non-English instructions is part of the difficulty profile — frontier models are expected to cope.

## Scoring

A task is **solved** only if the language gate passes *and* 100% of hidden tests pass:

| Language | Gate + oracle |
|---|---|
| Rust | `cargo build` + hidden integration tests (all `test result:` lines summed) |
| TypeScript | **two independent gates**: `tsc --strict` *and* `bun test` — passing tests with unsound types is not a pass |
| Julia | `julia -t N`, hidden checks print `BENCH_RESULT passed=N total=M` |
| C# | `dotnet run` (net10.0, no NuGet deps), same `BENCH_RESULT` protocol |
| Bash | hidden checks in subshells with isolated temp dirs |
| PowerShell | `pwsh 7.4` hidden checks |

Design rules that turned out to matter:

- **Every task ships a reference solution, and `node runners/run-hard.mjs --selftest` runs all references through the production oracles.** A buggy hidden test fails every model at once and reads as their weakness — self-test catches harness/task drift before a campaign does.
- **Code extraction takes the *largest* fenced block, tolerates answers formatted as the input repo dump (`===== FILE: … =====` header, no fence), and strips trailing `Export-ModuleMember`** (legal in a `.psm1`, fatal when dot-sourcing a `.ps1`). A harness that only accepts tidy markdown measures formatting habits, not coding ability.
- **Raw responses of failed units are dumped to disk.** Three kinds of silent failure were caught only this way: API errors returned as HTTP-200 "empty successes" in streaming mode, engine errors delivered *as response content*, and dump-format answers broken by the extractor.
- **Failed *calls* (routing errors, timeouts) are not failed *tasks*** — they are recorded as errors and excluded from denominators.

## Findings so far

- **Long context costs cloud models money, and local models time.** Median `edit-long / edit` time ratio: cloud ≈ 0.3–3.5 (some models are *faster* on long input — they deliberate less), local quants ≈ **13×** — ~63k tokens of prefill is 200+ seconds of wall-clock on a consumer GPU. Quality barely moves; latency is the casualty.
- **PowerShell is the most destructive language in the set** — several frontier models solve 1–2 of 3; one flatly refused a benign task.
- **Attention architecture beats parameter count for local deployment**: models of the same size class differ 4× in usable context on a 24 GB card purely due to KV-cache design (GQA ratio, sliding-window layers).

## Running

Requirements: Node 20+, plus per-language toolchains you intend to grade (`cargo`, `tsc` + `bun`, `julia`, `dotnet` 10, `pwsh` 7.4). Override binary paths via `TSC_BIN`, `BUN_BIN`, `JULIA_BIN`, `PWSH_BIN`.

```bash
# validate all reference solutions against the oracles first
node runners/run-hard.mjs --selftest

# cloud models via OpenRouter (key in OPENROUTER_API_KEY or /tmp/.orkey)
LLM_CLIENT=openrouter OUT=results-my-run.json node runners/run-hard.mjs openai/gpt-5.6-luna deepseek/deepseek-v3.2

# local models via any OpenAI-compatible server (LM Studio, llama-server, etc.)
LMSTUDIO_BASE=http://localhost:1234/v1 OUT=results-local.json node runners/run-hard.mjs my-local-model
```

Runs are crash-safe (results are flushed after every unit) and resumable (`model|lang|task|run` keys are skipped when present). Useful knobs: `MAX_TOKENS` (default 40000), `LLM_DEADLINE_MS` (default 20 min per call), `BENCH_NO_STREAM=1` for servers whose streaming path is broken, `SINGLE_RUNS=N` to grow the sample.

## Repository layout

### hard-bench (flagship)

| File | Purpose |
|---|---|
| `tasks/tasks-hard-{rust,ts,julia,csharp,bash,pwsh}.js` | Task sets: spec, starter (for `edit`), visible tests, hidden tests, reference solution |
| `tasks/tasks-hard-long.js` | Assembles the full 22-task set and builds `edit-long` prompts |
| `tasks/context-filler.js` | Deterministic generator of plausible repository filler for `edit-long` (~63k tokens, target file at 2/3 depth) |
| `runners/run-hard.mjs` | Runner: prompt assembly, oracles, extraction, self-test, crash-safe resumable driver |

### Standard batteries and probes

| File | Purpose |
|---|---|
| `tasks/tasks-rust.js` + `runners/run-rust.mjs` | Original Rust battery (3 tasks: expression parser, LRU, wordcount), single-shot ×2 + agentic tool-loop, cargo oracle + clippy |
| `tasks/tasks-ts.js` + `runners/run-ts.mjs` | TypeScript battery, dual gate (`tsc --strict` + tests), single-shot + agentic |
| `tasks/tasks-knowledge.js` + `runners/run-knowledge.mjs` + `runners/judge-knowledge*.mjs` | Knowledge battery (5 axes: facts, reasoning, style, safety, long-form), graded 0–10 by a frontier judge — the one battery that is LLM-judged |
| `runners/run-tooluse*.mjs` | Tool-calling reliability probes (simple, calculator chain, hard multi-step, long-context) |
| `runners/run-longctx.mjs`, `runners/run-multineedle.mjs` | NIAH and multi-needle retrieval at up to 262k context |
| `runners/probe-speed.mjs`, `runners/run-temp-sweep.mjs`, `runners/or-verify.mjs`, `runners/fact-probe-detail.mjs` | Throughput probe, temperature sweep, OpenRouter routing/pricing verification, per-fact drilldown |
| `campaigns/*.sh` | Historical campaign orchestration (parallel groups, model lists, environment) — kept as provenance for every row in the results sheet |
| `templates/` | Corrected Jinja chat templates for models whose upstream templates break tool-calling |

### Reporting

| File | Purpose |
|---|---|
| `reporting/gsheets_hard_tab.py` | Aggregates hard-bench results into the public sheet tab (per-language medians, `long ×`, legend, header tooltips) |
| `reporting/gsheets_add_models.py`, `reporting/gsheets_update_model_row.py`, `reporting/gsheets_add_ttc_column.py` | Standard-battery rows and time-to-correct columns |
| `reporting/gsheets_common.py` | Shared sheet helpers, incl. gradient-rule sync that never touches manually-created formatting |

### Clients

| File | Purpose |
|---|---|
| `clients/openrouter-client.mjs` | OpenRouter client (streaming TTFT/tok/s measurement, real `usage.cost`, privacy routing `data_collection: deny`) |
| `clients/llama-server-client.mjs` | Client for any OpenAI-compatible local server (optional bearer auth, tool-call accumulation from stream deltas) |
| `clients/claudecode-client.mjs` | Runs prompts through a Claude Code subscription (`claude -p`) so subscription-only models can join the same tables |
| `clients/morph-client.mjs` | Morph fast-apply specialist client |

Results live in `results/*.json`, one record per unit: pass counts, gate status, latency, TTFT, tok/s, token usage, cost. Raw dumps of failed answers land under `results/hard-dumps/` (not committed). **Every new model benchmarked shows up in git history as a results commit** — the log doubles as a benchmarking journal.

## License

MIT
