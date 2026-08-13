// Claude Code (subscription) client — exposes the SAME chat() interface as lmstudio-client.mjs
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
//   Code agent harness. Every call carries Claude Code's own system prompt + tool definitions
//   (~46k tokens observed for a trivial reply), so the model answers a DIFFERENT effective prompt
//   than the OpenRouter/LM Studio rows. Consequences:
//     - Use only for objective-oracle single-shot (RUST/TS, robust to prompt contamination) and
//       the judged knowledge battery.
//     - The agentic tool-loop is NOT representable here (Claude Code IS the agent) — chat() with
//       `tools` returns an explicit error rather than fabricating a comparable A%.
//     - tok/s and TTFT are inflated by harness prefill → treat as N/A, not peer metrics.
//     - `cost` is the API-EQUIVALENT (`total_cost_usd`); the subscription does not bill it
//       per-token, it draws window quota. Record it, but it is not a $/task peer to cloud rows.

import { spawn } from 'child_process';

const DEADLINE_MS = 1200000; // 20 min reliable wall-clock cap per call (matches the other clients)
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fold the OpenAI-style messages array into (system, userPrompt) for `claude -p`.
//   * system turns  -> --append-system-prompt (Claude Code keeps its base prompt and appends this)
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
// `--allowedTools ''` forces a pure text answer (no tool calls / permission prompts in headless).
async function runClaude({ model, system, userPrompt, signal }) {
  const t0 = Date.now();
  const args = ['-p', '--model', model, '--output-format', 'json', '--allowedTools', ''];
  if (system) args.push('--append-system-prompt', system);

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
  const cliModel = String(model || '').replace(/^anthropic\//, ''); // accept bare or OR-style ids

  for (let a = 0; a < 3; a++) {
    const ctrl = new AbortController();
    let timer;
    const deadline = new Promise((_, rej) => { timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} rej(new Error('__TIMEOUT__')); }, DEADLINE_MS); });
    try {
      const res = await Promise.race([runClaude({ model: cliModel, system, userPrompt, signal: ctrl.signal }), deadline]);
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
