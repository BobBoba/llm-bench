// Claude Code (subscription) client — exposes the SAME chat() interface as llama-server-client.mjs
// and openrouter-client.mjs, so run-rust / run-ts / run-knowledge drive Anthropic models through
// the `claude -p` headless CLI (subscription auth) instead of a raw HTTP endpoint.
//
// * Why this exists: `claude-fable-5` requires 30-day data retention and is UNAVAILABLE under the
//   OpenRouter account's ZDR privacy policy (empirically: "No endpoints available matching your
//   guardrail restrictions and data policy"). The Claude Code CLI authenticates with the user's
//   subscription and runs Fable 5 directly, bypassing both OpenRouter routing and per-token API
//   billing (it spends the 5-hour-window quota instead).
//
// ! MEASUREMENT CAVEAT — read before comparing rows: this measures the model INSIDE the Claude
//   Code CLI runtime, not a raw API call. Even with the --system-prompt override below (which
//   strips the account's own CLAUDE.md + output-style + full agent identity), the runtime still
//   carries baseline scaffolding — ~22.4k tokens of cache-creation observed on a trivial reply
//   (down from ~41-46k when the identity/output-style prompt was still attached via
//   --append-system-prompt). That residual is CLI plumbing, not comparable to a bare-API system
//   prompt, so the model answers a DIFFERENT effective prompt than the OpenRouter/LM Studio rows.
//   Consequences:
//     - Use only for objective-oracle single-shot (RUST/TS, robust to prompt contamination) and
//       the judged knowledge battery.
//     - The agentic tool-loop is NOT representable here (Claude Code IS the agent) — chat() with
//       `tools` returns an explicit error rather than fabricating a comparable A%.
//     - tok/s and TTFT are inflated by harness prefill → treat as N/A, not peer metrics.
//     - `cost` is the API-EQUIVALENT (`total_cost_usd`); the subscription does not bill it
//       per-token, it draws window quota. Record it, but it is not a $/task peer to cloud rows.
//
// ! FIXED 30.08.2026 — do not revert to --append-system-prompt: with the default identity kept,
//   any task prompt naming a real-looking file path (e.g. "В файле src/lib.rs лежит...") made the
//   model behave like the live Claude Code agent — asking for write permission ("Разрешу
//   запись?"), or hallucinating success ("Файл создан успешно!") — with ZERO code in the reply,
//   plus stray "★ Insight" callouts from the account's Explanatory output style. `--allowedTools
//   ''` blocks the tool CALL but does nothing to stop this narration, because it's driven by the
//   system-prompt identity, not by tool availability. Confirmed via results/hard-dumps/ on a
//   Haiku 4.5 hard-bench run: 7/22 tasks (every rust/csharp/ts task naming a file path) came back
//   as pure narration and were misread as `lib_compile_fail`/`compile_fail`/`tsc_fail` — i.e. as
//   model incompetence — until the dumps were actually read. Switching to --system-prompt (full
//   replace) plus the explicit NO_TOOLS_CLAUSE below fixed it on first retest.

import { spawn } from 'child_process';

const DEADLINE_MS = 1200000; // 20 min reliable wall-clock cap per call (matches the other clients)
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fold the OpenAI-style messages array into (system, userPrompt) for `claude -p`.
//   * system turns  -> --system-prompt (FULL REPLACE, not --append-system-prompt — see hardening
//     note below: appending keeps Claude Code's own agent identity + the account's CLAUDE.md/
//     output-style, and that identity leaks through `--allowedTools ''` on any task whose prompt
//     names a real-looking file path, e.g. "В файле src/lib.rs лежит...". Confirmed 30.08.2026:
//     with --append-system-prompt, Haiku answered such tasks with "Разрешу запись?" / "Требуется
//     разрешение на создание файла" / "Файл создан успешно!" — zero code, pure permission-seeking
//     or hallucinated-success narration, plus stray "★ Insight" callouts from the account's
//     Explanatory output style. Switching to --system-prompt (drops the default identity entirely)
//     made the same prompt return a clean fenced code block on the first try.)
//   * user/assistant turns -> stdin prompt; role-labelled only when >1 conversational turn exists,
//     so a plain single-shot task is passed VERBATIM (no injected "[user]" header to perturb it).
function foldMessages(messages) {
  const sys = [];
  const conv = [];
  for (const m of messages || []) {
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content) ? m.content.map(c => c.text || '').join('\n') : '';
    if (m.role === 'system') sys.push(text);
    else conv.push({ role: m.role, text });
  }
  const userPrompt = conv.length === 1
    ? conv[0].text
    : conv.map(c => `[${c.role}]\n${c.text}`).join('\n\n');
  return { system: sys.join('\n\n'), userPrompt };
}

// One `claude -p` invocation. Prompt goes via stdin (RUST/NIAH prompts exceed argv limits).
// `--allowedTools ''` disables tool CALLS at the API level, but does NOT stop the model
// NARRATING about wanting to write/edit a file — that needs --system-prompt, see above.
async function runClaude({ model, system, userPrompt, signal }) {
  const t0 = Date.now();
  const args = ['-p', '--model', model, '--output-format', 'json', '--allowedTools', ''];
  if (system) args.push('--system-prompt', system);

  return new Promise((resolve) => {
    // maxBuffer must be generous — a 40k-token code answer is a few hundred KB of JSON.
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });

    const onAbort = () => { try { child.kill('SIGKILL'); } catch (_) {} };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', e => resolve({ ok: false, error: 'spawn: ' + e.message }));
    child.on('close', () => {
      if (signal) { try { signal.removeEventListener('abort', onAbort); } catch (_) {} }
      if (!out) return resolve({ ok: false, retry: true, error: 'empty_output' + (err ? ': ' + err.slice(0, 120) : '') });
      let d; try { d = JSON.parse(out); } catch (_) { return resolve({ ok: false, retry: true, error: 'bad_json: ' + out.slice(0, 120) }); }
      if (d.is_error) return resolve({ ok: false, error: String(d.result || d.api_error_status || 'cli_error').slice(0, 160) });

      const u = d.usage || {};
      const total = (d.duration_ms || (Date.now() - t0)) / 1000;
      const comp = u.output_tokens || 0;
      const ttft = d.ttft_ms != null ? d.ttft_ms / 1000 : null;
      resolve({
        ok: true,
        content: d.result || '',
        reasoning: '',                                 // Claude Code omits thinking text in json output
        tool_calls: [],
        finish: d.stop_reason || null,
        usage: { prompt: u.input_tokens || 0, completion: comp, reasoning: 0 },
        cost: Number(d.total_cost_usd || 0),           // API-equivalent, not a subscription charge
        ttft: ttft != null ? +ttft.toFixed(3) : null,  // ! inflated by ~46k harness prefill
        total: +total.toFixed(2),
        tokps: total > 0 ? +(comp / total).toFixed(1) : 0, // ! decode rate hidden behind prefill
      });
    });

    child.stdin.write(userPrompt);
    child.stdin.end();
  });
}

// Same signature/contract as the other clients. `stream`/`temperature`/`max_tokens` are accepted
// for interface parity but not settable via `claude -p` (Fable 5 ignores temperature regardless).
async function chat({ model, messages, max_tokens, tools, tool_choice, stream, temperature } = {}) {
  // ! Agentic tool-loop is not comparable through `claude -p` — surface it explicitly so the
  //   runner records an honest failure instead of a fabricated agentic score.
  if (tools) return { ok: false, error: 'agentic_unsupported_via_claude_code' };

  const { system, userPrompt } = foldMessages(messages);
  // Belt-and-suspenders alongside the --system-prompt switch above: spell out the no-tools
  // contract explicitly, since --system-prompt alone still left a one-line preamble ("Понял,
  // что файл нужен интерактивно...") before the code fence in testing.
  const NO_TOOLS_CLAUSE = 'You have NO file access and NO tools in this evaluation — any path mentioned in the task is illustrative only, not a real file. Do not attempt to write, edit, or create files; do not ask for write permission; do not claim a file was created. Respond with ONLY the complete requested code as plain text in your message — that text IS the graded answer. No narration, no explanation, no "Insight" callouts, no summary of what you would do.';
  const hardenedSystem = system ? `${NO_TOOLS_CLAUSE}\n\n${system}` : NO_TOOLS_CLAUSE;
  const cliModel = String(model || '').replace(/^anthropic\//, ''); // accept bare or OR-style ids

  for (let a = 0; a < 3; a++) {
    const ctrl = new AbortController();
    let timer;
    const deadline = new Promise((_, rej) => { timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} rej(new Error('__TIMEOUT__')); }, DEADLINE_MS); });
    try {
      const res = await Promise.race([runClaude({ model: cliModel, system: hardenedSystem, userPrompt, signal: ctrl.signal }), deadline]);
      clearTimeout(timer);
      if (res.ok) return res;
      if (res.retry && a < 2) { await sleep(2500); continue; }
      return res;
    } catch (e) {
      clearTimeout(timer);
      try { ctrl.abort(); } catch (_) {}
      if (String(e && e.message).includes('__TIMEOUT__')) return { ok: false, timeout: true, error: `timeout>${DEADLINE_MS / 1000}s` };
      if (a < 2) { await sleep(2500); continue; }
      return { ok: false, error: 'spawn_fail: ' + String(e && e.message) };
    }
  }
  return { ok: false, error: 'exhausted' };
}

export { chat, sleep };
