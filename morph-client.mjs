// Morph fast-apply client — SAME chat() contract as openrouter-client.mjs, but adapted to the
// hard constraints Morph's OpenRouter endpoint imposes (empirically confirmed [[02.07.2026]]):
//
//   ! Morph V3 is a single-turn APPLY specialist, not a general chat model. Its endpoint:
//     - rejects multi-message prompts with 400 "Multi-turn conversations are not supported"
//       -> we FOLD system+user (and any history) into ONE user turn (content identical, just
//          merged — the same accommodation claudecode-client makes with --append-system-prompt);
//     - exposes NO tool-use ("No endpoints found that support tool use") -> agentic is refused
//       here so the runners record it as N/A, never a misleading 0;
//     - advertises no `reasoning` support -> we omit the reasoning param (sending it risks a 400);
//     - is not reliably streamable and returns *errors in the body* (not as SSE), which the
//       streaming path can't see -> we ALWAYS use non-streaming so errors are caught and
//       usage.cost is captured. TTFT is therefore null (n/a); tok/s is derived from wall time.
//
// Key from env OPENROUTER_API_KEY or /tmp/.orkey (never logged). Same 3-retry + deadline logic.

import fs from 'fs';
const KEY = (process.env.OPENROUTER_API_KEY || fs.readFileSync(process.env.ORKEY_FILE || '/tmp/.orkey', 'utf8')).trim();
const DEADLINE_MS = 1200000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fold an OpenAI-style message array into a single user-turn string. System content is prepended
// verbatim, tool/assistant turns are labelled so nothing is silently dropped. For the single-shot
// batteries this is exactly "system\n\nuser" — semantically identical to the two-message form.
function foldMessages(messages) {
  return messages.map(m => {
    if (m.role === 'system' || m.role === 'user') return m.content || '';
    if (m.role === 'assistant') return `[assistant]\n${m.content || ''}`;
    if (m.role === 'tool') return `[tool result]\n${m.content || ''}`;
    return m.content || '';
  }).filter(Boolean).join('\n\n');
}

async function attempt({ body, signal }) {
  const t0 = Date.now();
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal,
  });
  const txt = await r.text();
  if (!txt) return { ok: false, retry: true, error: 'empty_response' };
  let d; try { d = JSON.parse(txt); } catch (_) { return { ok: false, retry: true, error: 'bad_json: ' + txt.slice(0, 120) }; }
  if (d.error) return { ok: false, error: JSON.stringify(d.error).slice(0, 200) };
  const msg = d.choices?.[0]?.message || {};
  const u = d.usage || {};
  const total = (Date.now() - t0) / 1000;
  return {
    ok: true, content: msg.content || '', reasoning: '',
    tool_calls: [], finish: d.choices?.[0]?.finish_reason,
    usage: { prompt: u.prompt_tokens || 0, completion: u.completion_tokens || 0, reasoning: 0 },
    cost: Number(u.cost || 0), ttft: null, total: +total.toFixed(2),
    tokps: total > 0 ? +((u.completion_tokens || 0) / total).toFixed(1) : 0,
  };
}

async function chat({ model, messages, max_tokens = 40000, tools, tool_choice, stream = false, temperature = 0.2 }) {
  // Agentic tool-loops are impossible on Morph — refuse up front so the runner marks it N/A.
  if (tools) return { ok: false, error: 'tool_use_unsupported_morph' };

  const body = {
    model, temperature, max_tokens, usage: { include: true },
    provider: { data_collection: 'deny' },
    messages: [{ role: 'user', content: foldMessages(messages) }],
  };
  for (let a = 0; a < 3; a++) {
    const ctrl = new AbortController();
    let timer;
    const deadline = new Promise((_, rej) => { timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} rej(new Error('__TIMEOUT__')); }, DEADLINE_MS); });
    try {
      const res = await Promise.race([attempt({ body, signal: ctrl.signal }), deadline]);
      clearTimeout(timer);
      if (res.ok) return res;
      if (res.retry && a < 2) { await sleep(2500); continue; }
      return res;
    } catch (e) {
      clearTimeout(timer);
      try { ctrl.abort(); } catch (_) {}
      if (String(e && e.message).includes('__TIMEOUT__')) return { ok: false, timeout: true, error: `timeout>${DEADLINE_MS / 1000}s` };
      if (a < 2) { await sleep(2500); continue; }
      return { ok: false, error: 'network: ' + String(e && e.message) };
    }
  }
  return { ok: false, error: 'exhausted' };
}

export { chat, sleep };
