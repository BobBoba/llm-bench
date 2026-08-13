#!/usr/bin/env bun
// Transparent reverse proxy in front of LM Studio (gaming-pc.lan:1234) that guards
// specific models against malformed tool-call output.
//
// Root cause (see claudedocs/omp-ornith-vs-ds-vs-gptoss-bench.md and the [[04.07.2026]]
// diagnosis session): ornith-1.0-35b was trained on a mix of the Hermes tool-call
// convention (`<tool_call>{"name":...,"arguments":{...}}</tool_call>`) and the
// unrelated Qwen3-Coder XML convention (`<function=name><parameter=x>v</parameter></function>`).
// It intermittently (~20-25% of turns, confirmed live) blends the two or emits an
// empty `<tool_call></tool_call>` shell with finish_reason "stop" instead of "tool_calls".
// This is model-inherent, not fixable by prompt template or sampling params alone, and
// omp's own auto-retry (docs/non-compaction-retry-policy.md) structurally excludes it
// (it only retries stopReason "error", never a clean "stop" that carries text content).
//
// Fix: sit between omp and LM Studio. For guarded models, force non-streaming upstream,
// inspect the response, and either (a) recover the call from the malformed text with the
// same regexes already proven in run-ts.mjs's parseNativeToolCalls(), or (b) if nothing
// is recoverable (the empty-shell case), re-issue the request for a fresh sampling draw.
// All other models/paths pass through untouched, including streaming.
//
// Third failure mode (found [[04.07.2026]], LM Studio server log for task 85192/slot 2):
// instead of returning quickly with an empty/hybrid tool-call shell, the model sometimes
// gets stuck in LM Studio's own grammar-constrained tool-call sampler — it repeats
// "Start to generate a tool call... / Tool name generated: bash" thousands of tokens in a
// row without ever producing a grammar-valid close, because the request carried no
// `max_tokens` cap. A real tool call from this model is always short, so an unbounded
// generation has no way to fail fast: it runs until Bun's own fetch timeout fires
// (~5 minutes), and since that surfaces to omp as a transport error, omp's own retry
// (docs/non-compaction-retry-policy.md) dutifully re-sends the identical request and eats
// another 5 minutes hitting the same loop. Fix: cap max_tokens for guarded models (bounds
// worst-case latency to seconds, not minutes) and wrap the upstream fetch in its own
// shorter timeout INSIDE the retry loop (not just the outer handler), so a stuck attempt
// is treated like any other malformed response and retried within this proxy instead of
// bubbling up as a slow 502.

const UPSTREAM = process.env.ORNITH_PROXY_UPSTREAM ?? "http://gaming-pc.lan:1234";
const PORT = Number(process.env.ORNITH_PROXY_PORT ?? 8234);
const GUARDED_MODELS = new Set((process.env.ORNITH_PROXY_GUARDED ?? "ornith-1.0-35b").split(","));
const MAX_ATTEMPTS = Number(process.env.ORNITH_PROXY_MAX_ATTEMPTS ?? 3); // 1 original + retries
const REQUEST_TIMEOUT_MS = Number(process.env.ORNITH_PROXY_TIMEOUT_MS ?? 45_000); // per-attempt upstream fetch cap
const GUARDED_MAX_TOKENS = Number(process.env.ORNITH_PROXY_MAX_TOKENS ?? 1024); // real tool calls never need more

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Ported verbatim from claudedocs/llm-bench/run-ts.mjs (parseNativeToolCalls),
// which already handles both formats plus the duplicated-<tool_call> tag edge case.
function parseNativeToolCalls(text: string, step: number) {
  if (!text) return [] as Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  const out: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  // format 1 — Qwen3-Coder XML function/parameter blocks
  const fnRe = /<function=([\w.-]+)>([\s\S]*?)<\/function>/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(text)) !== null) {
    const name = m[1];
    const argsObj: Record<string, string> = {};
    const pRe = /<parameter=([\w.-]+)>\s*([\s\S]*?)\s*<\/parameter>/g;
    let pm: RegExpExecArray | null;
    while ((pm = pRe.exec(m[2])) !== null) argsObj[pm[1]] = pm[2];
    out.push({ id: `call_${step}_${out.length}`, type: "function", function: { name, arguments: JSON.stringify(argsObj) } });
  }
  if (out.length) return out;
  // format 2 — Hermes JSON payload inside <tool_call> ... </tool_call>
  const jsonRe = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  while ((m = jsonRe.exec(text)) !== null) {
    try {
      const j = JSON.parse(m[1]);
      if (j?.name) out.push({ id: `call_${step}_${out.length}`, type: "function", function: { name: j.name, arguments: JSON.stringify(j.arguments || {}) } });
    } catch {
      /* not recoverable from this block */
    }
  }
  return out;
}

function isMalformed(message: any): boolean {
  const hasToolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
  if (hasToolCalls) return false;
  const content: string = message?.content ?? "";
  return content.includes("<tool_call>") || content.includes("<function=");
}

async function handleGuardedChatCompletion(body: any): Promise<Response> {
  const wantsStream = !!body.stream;
  const baseTemperature = typeof body.temperature === "number" ? body.temperature : 0.6;

  let data: any = null;
  let attempt = 0;
  for (; attempt < MAX_ATTEMPTS; attempt++) {
    // Cap generation length (a real tool call is always short — this bounds worst-case
    // latency if the model falls into the grammar-sampler loop described above) and widen
    // sampling a little on each retry to improve the odds of escaping a near-deterministic loop.
    const upstreamBody = {
      ...body,
      stream: false,
      max_tokens: typeof body.max_tokens === "number" && body.max_tokens < GUARDED_MAX_TOKENS ? body.max_tokens : GUARDED_MAX_TOKENS,
      temperature: Math.min(1.0, baseTemperature + attempt * 0.15),
    };

    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(`${UPSTREAM}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      log(
        `upstream request timed out/failed (model=${body.model}, attempt ${attempt + 1}/${MAX_ATTEMPTS}, cap ${upstreamBody.max_tokens} tokens, ${REQUEST_TIMEOUT_MS}ms budget): ${e} — ${attempt + 1 < MAX_ATTEMPTS ? "retrying" : "giving up"}`,
      );
      continue;
    }

    if (!upstreamResp.ok) {
      // Provider-level error (rate limit, offline, etc.) — not our concern, forward as-is.
      // omp's own retry policy already handles stopReason "error" cases.
      const text = await upstreamResp.text();
      return new Response(text, { status: upstreamResp.status, headers: { "content-type": "application/json" } });
    }
    data = await upstreamResp.json();
    const choice = data?.choices?.[0];
    const message = choice?.message;
    if (!isMalformed(message)) {
      if (attempt > 0) log(`recovered on attempt ${attempt + 1}/${MAX_ATTEMPTS} (model=${body.model}) via clean retry`);
      break;
    }

    const combined = `${message?.content ?? ""}\n${message?.reasoning_content ?? ""}`;
    const recovered = parseNativeToolCalls(combined, attempt);
    if (recovered.length) {
      message.tool_calls = recovered;
      message.content = "";
      choice.finish_reason = "tool_calls";
      log(`recovered malformed tool_call via regex parse (model=${body.model}, attempt ${attempt + 1}): ${recovered.map((c) => c.function.name).join(", ")}`);
      break;
    }

    data = null; // this attempt's response is unusable — don't fall through to it if we exhaust retries
    log(`unrecoverable malformed tool_call (model=${body.model}, attempt ${attempt + 1}/${MAX_ATTEMPTS}, finish_reason=${choice?.finish_reason}): ${JSON.stringify((message?.content ?? "").slice(0, 200))} — ${attempt + 1 < MAX_ATTEMPTS ? "retrying" : "giving up"}`);
  }

  if (!data) {
    const msg = `ornith-toolcall-proxy: all ${MAX_ATTEMPTS} attempts for ${body.model} failed (timed out at ${REQUEST_TIMEOUT_MS}ms and/or stayed malformed)`;
    log(msg);
    return new Response(JSON.stringify({ error: { message: msg } }), { status: 504, headers: { "content-type": "application/json" } });
  }

  if (!wantsStream) {
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  }

  // Client asked for SSE — synthesize a minimal valid stream from the buffered result.
  // No incremental typing effect for guarded models, but shape is spec-compliant.
  const choice = data.choices[0];
  const message = choice.message;
  const id = data.id ?? `chatcmpl-proxy-${Date.now()}`;
  const created = data.created ?? Math.floor(Date.now() / 1000);
  const model = data.model ?? body.model;
  // Clients that pass stream_options.include_usage (agent harnesses tracking cost/usage per
  // turn, e.g. omp) expect one final chunk with an empty choices array and a populated
  // `usage` field, per the OpenAI streaming spec — found missing [[04.07.2026]] after the
  // guarded model's usage showed as 0 in omp's own dashboard even though data.usage (from
  // LM Studio's real, buffered response) was correct all along; this stream just never
  // carried it forward.
  const wantsUsage = !!body.stream_options?.include_usage;

  const chunk = (delta: any, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

  const bodyStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunk({ role: "assistant" })));
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        message.tool_calls.forEach((tc: any, i: number) => {
          controller.enqueue(
            new TextEncoder().encode(
              chunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }),
            ),
          );
        });
      } else if (message.content) {
        controller.enqueue(new TextEncoder().encode(chunk({ content: message.content })));
      }
      controller.enqueue(new TextEncoder().encode(chunk({}, choice.finish_reason ?? "stop")));
      if (wantsUsage && data.usage) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: data.usage })}\n\n`),
        );
      }
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(bodyStream, { headers: { "content-type": "text/event-stream" } });
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1", // localhost-only: this is a client-side shim for omp, not a LAN service
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await req.json();
      if (GUARDED_MODELS.has(body.model)) {
        try {
          return await handleGuardedChatCompletion(body);
        } catch (e) {
          log(`proxy error for guarded model ${body.model}: ${e}`);
          return new Response(JSON.stringify({ error: { message: String(e) } }), { status: 502 });
        }
      }
      // Not a guarded model — pure passthrough, streaming included.
      const upstreamResp = await fetch(`${UPSTREAM}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return new Response(upstreamResp.body, { status: upstreamResp.status, headers: upstreamResp.headers });
    }

    // Everything else (models list, embeddings, raw completions, etc.) — transparent passthrough.
    try {
      const upstreamResp = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      });
      return new Response(upstreamResp.body, { status: upstreamResp.status, headers: upstreamResp.headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: { message: `upstream unreachable: ${e}` } }), { status: 502 });
    }
  },
});

log(`ornith-toolcall-proxy listening on 127.0.0.1:${PORT} -> ${UPSTREAM}, guarding: ${[...GUARDED_MODELS].join(", ")}`);
