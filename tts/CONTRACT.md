# CONTRACT.md -- omp / pi `--mode json` discovery

Authoritative record of what the two harnesses actually emit, produced by real network probes against OpenRouter on [[20.07.2026]]. This is what any parser code in this benchmark must be written against -- do not assume shapes from the harnesses' own docs without re-checking here first.

Binaries used:
- omp: `~/.bun/bin/omp` (v17.0.5)
- pi: `~/.nvm/versions/node/v24.10.0/bin/pi` (v0.80.3, the upstream pi-coding-agent that omp forked from). `pi` is ALSO a zsh shell function in interactive shells -- scripts must call the resolved binary path, never bare `pi`.

Fixtures captured: `fixtures/omp-sample.json`, `fixtures/pi-sample.json` (real stdout of a one-shot "Reply with exactly: OK" probe on `anthropic/claude-haiku-4.5` via OpenRouter, `--mode json --no-session`).

## 1. Output format (both harnesses)

Both emit newline-delimited JSON (JSONL) on stdout, one JSON object per line, each with a top-level `"type"` field. Observed event types, in order, for a simple no-tool-call turn:

```
session -> (thinking_level_changed, omp only) -> agent_start -> turn_start ->
message_start (x N) -> message_end (x N) -> message_update (many, streaming deltas) ->
turn_end -> agent_end
```

When the model uses a tool (write/edit/bash/etc.), a SECOND `turn_start`/`turn_end` pair appears, wrapping additional `tool_execution_start` / (omp: `tool_execution_update`) / `tool_execution_end` events and `toolCall`/`toolcall_start`/`toolcall_delta`/`toolcall_end` events inside `message_update`. Verified by an actual "create file z.txt with text hi" probe run against BOTH harnesses independently: pi via `preflight.mjs step2b` (section 4 below) and omp via `preflight.mjs step2c` -- each probe is re-runnable on its own (`node preflight.mjs step2c`, etc.) without paying for the full step3 slug sweep. Both harnesses produced exactly 2 `turn_start`/`turn_end` pairs (1 tool round-trip + 1 final answer) and both actually created the file on disk with the correct content.

**"turns/steps" metric**: count `turn_start` (or `turn_end`) events. There is no separate `"steps"` or `"turnCount"` field -- the step count must be derived by counting these events.

## 2. Cost / token JSON key paths

Both harnesses attach a `usage` object to every `assistant`-role message (inside `message_start`/`message_update`/`message_end`/`turn_end`/`agent_end`). The path to the FINAL/aggregate usage for a run is:

```
agent_end.messages[messages.length - 1].usage
```

(equivalently: the `message` field of the last `turn_end` event -- same object, duplicated).

**IMPORTANT -- usage is PER TURN, not cumulative across the whole session.** Each `assistant` message's `usage` reflects only that one API call. For a multi-turn (multi-tool-call) run, total session cost/tokens must be computed by **summing `usage.cost.total` (and token fields) across every `turn_end` (or `agent_end.messages[i]` where `role === "assistant"`)** -- do not just read the last one and assume it is the grand total.

### omp key paths (`fixtures/omp-sample.json`)

```
<msg>.usage.input                 -- input tokens
<msg>.usage.output                -- output tokens
<msg>.usage.cacheRead             -- cached input tokens read
<msg>.usage.cacheWrite            -- cached input tokens written (system prompt caching)
<msg>.usage.reasoningTokens       -- reasoning/thinking tokens   ** key name: "reasoningTokens" **
<msg>.usage.totalTokens           -- provider-reported total; read verbatim, do NOT recompute (see note below)
<msg>.usage.cost.input            -- USD
<msg>.usage.cost.output           -- USD
<msg>.usage.cost.cacheRead        -- USD
<msg>.usage.cost.cacheWrite       -- USD
<msg>.usage.cost.total            -- USD, the number to sum for total run cost
<msg>.stopReason                  -- finish reason, e.g. "stop" (this benchmark only observed "stop"; no probe forced length/tool-limit cutoffs)
<msg>.duration                    -- ms, wall time for that one API call
<msg>.ttft                        -- ms, time-to-first-token for that one API call
```

### pi key paths (`fixtures/pi-sample.json`)

Structurally identical, with ONE naming difference:

```
<msg>.usage.input
<msg>.usage.output
<msg>.usage.cacheRead
<msg>.usage.cacheWrite
<msg>.usage.reasoning                -- ** key name: "reasoning", NOT "reasoningTokens" (differs from omp!) **
<msg>.usage.totalTokens
<msg>.usage.cost.input
<msg>.usage.cost.output
<msg>.usage.cost.cacheRead
<msg>.usage.cost.cacheWrite
<msg>.usage.cost.total
<msg>.stopReason
```

**`totalTokens` formula, verified by arithmetic on both fixtures**: `totalTokens == input + output + cacheRead + cacheWrite`. Reasoning tokens are NOT additive on top of that sum -- they are already counted inside `output` on both harnesses. Confirmed on the original probe values: omp (input=10, output=42, cacheRead=0, cacheWrite=39591, reasoningTokens=34) gives 10+42+0+39591=39643, which equals the reported `totalTokens` (39643) exactly; adding `reasoningTokens` on top would overshoot to 39677. Same check on pi (input=10, output=330, cacheRead=0, cacheWrite=18444, reasoning=230): 10+330+0+18444=18784, matching the reported `totalTokens` (18784) exactly. **A parser must read `totalTokens` verbatim and must never add `reasoningTokens`/`reasoning` to it** -- that field is informational (how much of `output` was reasoning), not a separate token bucket to sum in.

pi did NOT emit `duration`/`ttft` fields in the observed sample (present in omp, absent in pi). Do not assume pi always has timing fields.

pi's `agent_end` event additionally carries `"willRetry": false` -- useful as a retry-detection signal that omp's `agent_end` does not expose (not observed in omp fixtures).

**Parser implication**: a single `getReasoningTokens(usage)` helper must check both `usage.reasoningTokens` (omp) and `usage.reasoning` (pi) -- do not hardcode one key name across both harnesses.

## 3. Session continue mechanism

**Working form is identical for both harnesses:**

```
<bin> --model openrouter/<slug> [--cwd DIR (omp only, see below)] --session-dir <SDIR> --mode json [flags] -p "<first prompt>"
<bin> --session-dir <SDIR> --continue --mode json [flags] -p "<follow-up prompt>"
```

Verified end-to-end: told each harness a secret word on turn 1, asked "what was the secret word?" on turn 2 using only `--session-dir <SDIR> --continue`, no `--model` needed on turn 2 (both harnesses restore the model from the saved session) -- both correctly recalled the word (omp: "PINEAPPLE", pi: "MANGOSTEEN").

- `--session-dir <SDIR>` designates a directory for session storage; `-c`/`--continue` resumes the most recent session found there. `<SDIR>` must exist (created with `mkdir -p` in tests) but does not need to pre-contain anything.
- Each harness writes exactly ONE `.jsonl` session file per `<SDIR>` and **appends to the same file** across `--continue` calls (confirmed: file count stayed at 1 after both turns for both harnesses).
- omp additionally supports `-r/--resume=<id-or-path>` for picking a specific session; not needed for this benchmark's linear continue flow.

**pi does NOT support `--cwd`.** Unlike omp, pi has no `--cwd` flag at all (confirmed via `--help` and via a failing probe: `Error: Unknown option: --cwd`). pi always operates in the process's own working directory. To point pi at a scratch directory, the CALLING PROCESS must `cd`/spawn with that directory as its cwd (e.g. Node's `spawnSync(..., {cwd: D})`), not pass a flag. **This is the single most important gotcha for the parser/runner code**: any wrapper that shells out to both harnesses with a shared "run in dir X" abstraction must special-case pi to `cwd:` the child process instead of appending `--cwd`.

## 4. pi tool-call auto-approval in `-p` (non-interactive) mode

`--approve`/`-a` in pi's `--help` is documented as "Trust project-local files for this run" (i.e. trust local `.pi`/config files), NOT an explicit "auto-approve tool calls" switch like omp's `--auto-approve`/`--approval-mode`. Despite that documented meaning, **`-p` (print/non-interactive) mode with `--approve` did NOT hang on tool-call approval** in either probe run:

- Plain chat probe (no tools): completed normally, exit 0.
- File-write probe (`create file z.txt with the text hi`, no `--model` so pi used its own default model `inclusionai/ring-2.6-1t`): completed normally, exit 0, `z.txt` was actually created on disk with contents `hi`, tool round-trip visible as `toolName: "write"` in a `toolResult` message, and a second `turn_start`/`turn_end` pair.
- No interactive approval prompt was observed on stdout/stderr in any `-p --approve` run; no hang, no timeout needed beyond the 90s test harness ceiling.

**Conclusion: pi's non-interactive `-p` mode auto-approves tool calls by default (no interactive TTY = no prompt to block on); `--approve` was used throughout for safety/consistency with the brief but was not observed to be the switch that prevents hanging** -- the absence of a TTY appears to be what prevents hanging. No additional flag or env var was needed. If a future pi version changes this behavior, the regression signal to watch for is: process exits nonzero or hangs past a timeout with no `tool_execution_end` event following a `tool_execution_start`.

pi's stderr is NOT clean even in `--mode json` -- it contains raw terminal control/escape sequences (cursor positioning, bracketed-paste toggles, e.g. `\x1b[?2026h...\x1b[?2026l`) on every run, including successful ones. **Do not treat non-empty pi stderr as an error signal** -- check the exit code and stdout JSON instead. omp's stderr was empty on every successful run observed.

## 5. Confirmed OpenRouter slugs

All 6 candidate slugs from the brief resolved successfully via omp (`--model openrouter/<slug>`), each returning a valid `agent_end` with non-empty `usage` and `stopReason: "stop"`, and each echoing back the exact requested slug in `usage`'s parent message's `model` field (i.e., no silent fallback to a different model):

| Slug (as passed, `openrouter/` prefix implied) | Verified cost (this probe) | Notes |
|---|---|---|
| `deepseek/deepseek-v3.2` | $0.00895 | **No change needed** -- resolved fine as-is, contrary to the brief's expectation that this one was the main risk of drift |
| `deepseek/deepseek-v4-pro` | $0.00645 | OK |
| `anthropic/claude-sonnet-4.5` | $0.15101 | OK |
| `anthropic/claude-sonnet-5` | $0.12717 | OK |
| `anthropic/claude-opus-4.8` | $0.31752 | OK |
| `anthropic/claude-haiku-4.5` | $0.05004 | OK -- cost is inflated for this trivial probe by a large `cacheWrite` (this session's own system prompt/skills being cached for the first time in a fresh profile), not representative of steady-state per-task cost |

**Final list of 6 working slugs (use verbatim, `openrouter/` prefix required in `--model`):**
```
deepseek/deepseek-v3.2
deepseek/deepseek-v4-pro
anthropic/claude-sonnet-4.5
anthropic/claude-sonnet-5
anthropic/claude-opus-4.8
anthropic/claude-haiku-4.5
```

No slug substitution was required. This is the source list for `models.mjs` (Task 5-pre).

## 6. Other observations / gotchas for later tasks

- **Cost is heavily inflated by first-use cache-write** in these probes (e.g. haiku showed $0.050 for a 2-word reply because ~39.6k tokens were spent writing the system-prompt/skills cache for a fresh profile in a fresh scratch `--cwd`). Real per-task cost in the actual benchmark tasks will look different once caching is warm within a task, but every isolated probe (fresh `--cwd`, `--no-session`) pays this cache-write cost again -- the benchmark runner should account for this if it wants "marginal cost of a task" rather than "cost including a cold cache".
- pi's default model (when `--model` is omitted) is `inclusionai/ring-2.6-1t`, not something Anthropic -- always pass `--model openrouter/<slug>` explicitly, never rely on the default.
- Both harnesses' JSONL is safely parseable line-by-line with `JSON.parse` per line; no multi-line JSON values were observed straddling newlines.
- `agent_start`/`turn_start` carry no payload (`{"type":"agent_start"}` only) -- do not expect fields there.
