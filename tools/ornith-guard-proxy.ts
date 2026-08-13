#!/usr/bin/env bun
// * Unified LAN guard proxy in front of LM Studio (gaming-pc.lan:1234).
// * Serves BOTH clients that use the guarded model ornith-1.0-35b:
// *   - omp (agentic tool-calls)      -> recover malformed tool-call output
// *   - Hindsight (structured output) -> guarantee valid, non-empty JSON
// *
// * Evolution of claudedocs/llm-bench/ornith-toolcall-proxy.ts. That one was a
// * client-side localhost shim for omp only, and capped max_tokens at 1024 for
// * every guarded request. This version binds the LAN (0.0.0.0) so nas8's
// * Hindsight container and work-pc's omp can both point at it, and it splits
// * the guarded path in two by request shape.
//
// ! Root cause of ALL ornith structured-output failures (measured [[10.07.2026]]):
// ! max_tokens too small (800-1024), NOT temperature, NOT the mask stop token.
// ! ornith is a reasoning model: with a tiny budget it spends it on the
// ! reasoning preamble and never emits the JSON content -> empty response
// ! (finish_reason "stop", content ""). With max_tokens>=4096 it returns valid
// ! JSON 60/60 across temperature 0.0-0.8, with or without sampler tweaks.
// ! Therefore: for the structured path we RAISE the max_tokens floor and PASS
// ! TEMPERATURE THROUGH UNCHANGED — Hindsight consolidation runs at temp 0 for
// ! deterministic dedup, and raising temp would only degrade dedup quality.
//
// * The tool-call path (omp) is kept byte-for-byte as the original: a real tool
// * call is always short, so its 1024 cap is correct and bounds the known
// * grammar-sampler runaway loop. Do not "unify" the two caps — they are
// * deliberately opposite (tool-calls: cap DOWN; structured: floor UP).

const UPSTREAM = process.env.ORNITH_PROXY_UPSTREAM ?? "http://gaming-pc.lan:1234";
const HOST = process.env.ORNITH_PROXY_HOST ?? "0.0.0.0"; // * LAN service now, not a localhost shim
const PORT = Number(process.env.ORNITH_PROXY_PORT ?? 8234);
const GUARDED_MODELS = new Set((process.env.ORNITH_PROXY_GUARDED ?? "ornith-1.0-35b").split(","));
const MAX_ATTEMPTS = Number(process.env.ORNITH_PROXY_MAX_ATTEMPTS ?? 6); // 1 original + retries
const REQUEST_TIMEOUT_MS = Number(process.env.ORNITH_PROXY_TIMEOUT_MS ?? 120_000); // per-attempt upstream fetch cap
const TOOLCALL_MAX_TOKENS = Number(process.env.ORNITH_PROXY_MAX_TOKENS ?? 1024); // tool-call cap (short by nature)
const STRUCTURED_MIN_TOKENS = Number(process.env.ORNITH_PROXY_STRUCTURED_MIN_TOKENS ?? 4096); // structured floor
// ? After this many attempts at the client's temperature fail, escalate temperature as a
// ? last-resort rescue. At temp 0 a plain retry is deterministic (same bad draw), so a
// ? genuinely-stuck payload needs a different sampling regime to ever succeed. Kept high
// ? enough that ~99% of calls (which pass on attempt 1) never leave the requested temp.
const TEMP_ESCALATE_AFTER = Number(process.env.ORNITH_PROXY_TEMP_ESCALATE_AFTER ?? 2);

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// * Ported verbatim from ornith-toolcall-proxy.ts / run-ts.mjs parseNativeToolCalls().
function parseNativeToolCalls(text: string, step: number) {
  if (!text) return [] as Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  const out: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
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

// * A request is "structured" when the caller pinned an OpenAI response_format.
// * That is exactly the shape Hindsight sends for retain/consolidation.
function isStructuredRequest(body: any): boolean {
  const t = body?.response_format?.type;
  return t === "json_schema" || t === "json_object";
}

// * Structured content is usable only if it is non-empty AND parses as JSON.
// * Empty ("") and truncated JSON are ornith's two failure modes; both throw here.
function parseStructuredContent(message: any): unknown | null {
  const content: string = (message?.content ?? "").trim();
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function fetchUpstream(upstreamBody: any): Promise<Response> {
  return fetch(`${UPSTREAM}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

// * Structured path: guarantee valid JSON back to the client (Hindsight) or die trying.
// * Strategy: raise the max_tokens floor, keep the caller's temperature for the first
// * TEMP_ESCALATE_AFTER attempts (respecting temp 0 for deterministic dedup quality),
// * validate JSON.parse, and only escalate temperature/max_tokens as a rescue.
async function handleStructured(body: any): Promise<Response> {
  const wantsStream = !!body.stream;
  const reqTemp = typeof body.temperature === "number" ? body.temperature : 0.6;
  let maxTokens = Math.max(typeof body.max_tokens === "number" ? body.max_tokens : 0, STRUCTURED_MIN_TOKENS);

  let data: any = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Escalate temperature only after the deterministic-retry budget is spent.
    const temperature = attempt < TEMP_ESCALATE_AFTER ? reqTemp : Math.min(1.0, Math.max(reqTemp, 0.4) + (attempt - TEMP_ESCALATE_AFTER) * 0.2);
    const upstreamBody = { ...body, stream: false, max_tokens: maxTokens, temperature };

    let resp: Response;
    try {
      resp = await fetchUpstream(upstreamBody);
    } catch (e) {
      log(`structured upstream failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}, ${maxTokens} tok): ${e} — ${attempt + 1 < MAX_ATTEMPTS ? "retry" : "give up"}`);
      continue;
    }
    if (!resp.ok) {
      // Provider-level error (offline, rate limit) — forward as-is; the client's own retry owns it.
      return new Response(await resp.text(), { status: resp.status, headers: { "content-type": "application/json" } });
    }

    const candidate = await resp.json();
    const choice = candidate?.choices?.[0];
    const parsed = parseStructuredContent(choice?.message);
    if (parsed !== null) {
      if (attempt > 0) log(`structured recovered on attempt ${attempt + 1}/${MAX_ATTEMPTS} (temp=${temperature}, ${maxTokens} tok)`);
      data = candidate;
      break;
    }

    // Truncated output (hit the cap mid-JSON) -> give the next attempt more room.
    if (choice?.finish_reason === "length") {
      maxTokens = Math.min(maxTokens * 2, 16384);
      log(`structured truncated (finish_reason=length, attempt ${attempt + 1}) — raising max_tokens to ${maxTokens}`);
    } else {
      log(`structured empty/unparseable (finish_reason=${choice?.finish_reason}, attempt ${attempt + 1}/${MAX_ATTEMPTS}) — ${attempt + 1 < MAX_ATTEMPTS ? "retry" : "give up"}`);
    }
  }

  if (!data) {
    // ! Never hand the client a bad 200. A 5xx makes Hindsight/omp run their own retry.
    const msg = `ornith-guard-proxy: ${MAX_ATTEMPTS} attempts for ${body.model} all returned empty/unparseable structured output`;
    log(msg);
    return new Response(JSON.stringify({ error: { message: msg } }), { status: 502, headers: { "content-type": "application/json" } });
  }

  return wantsStream ? synthesizeStream(data, body) : new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

// * Tool-call path — preserved from ornith-toolcall-proxy.ts (omp's use case).
async function handleToolCall(body: any): Promise<Response> {
  const wantsStream = !!body.stream;
  const baseTemperature = typeof body.temperature === "number" ? body.temperature : 0.6;

  let data: any = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const upstreamBody = {
      ...body,
      stream: false,
      max_tokens: typeof body.max_tokens === "number" && body.max_tokens < TOOLCALL_MAX_TOKENS ? body.max_tokens : TOOLCALL_MAX_TOKENS,
      temperature: Math.min(1.0, baseTemperature + attempt * 0.15),
    };

    let upstreamResp: Response;
    try {
      upstreamResp = await fetchUpstream(upstreamBody);
    } catch (e) {
      log(`toolcall upstream timed out/failed (model=${body.model}, attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${e} — ${attempt + 1 < MAX_ATTEMPTS ? "retry" : "give up"}`);
      continue;
    }
    if (!upstreamResp.ok) {
      return new Response(await upstreamResp.text(), { status: upstreamResp.status, headers: { "content-type": "application/json" } });
    }
    data = await upstreamResp.json();
    const choice = data?.choices?.[0];
    const message = choice?.message;
    if (!isMalformed(message)) {
      if (attempt > 0) log(`toolcall recovered on attempt ${attempt + 1}/${MAX_ATTEMPTS} via clean retry`);
      break;
    }
    const combined = `${message?.content ?? ""}\n${message?.reasoning_content ?? ""}`;
    const recovered = parseNativeToolCalls(combined, attempt);
    if (recovered.length) {
      message.tool_calls = recovered;
      message.content = "";
      choice.finish_reason = "tool_calls";
      log(`toolcall recovered malformed call via regex (attempt ${attempt + 1}): ${recovered.map((c) => c.function.name).join(", ")}`);
      break;
    }
    data = null;
    log(`toolcall unrecoverable (attempt ${attempt + 1}/${MAX_ATTEMPTS}, finish_reason=${choice?.finish_reason}) — ${attempt + 1 < MAX_ATTEMPTS ? "retry" : "give up"}`);
  }

  if (!data) {
    const msg = `ornith-guard-proxy: all ${MAX_ATTEMPTS} tool-call attempts for ${body.model} failed/stayed malformed`;
    log(msg);
    return new Response(JSON.stringify({ error: { message: msg } }), { status: 504, headers: { "content-type": "application/json" } });
  }

  return wantsStream ? synthesizeStream(data, body) : new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

// * Buffered result -> spec-compliant SSE (no incremental typing for guarded models,
// * but shape is valid, including the final usage-only chunk when include_usage is set).
function synthesizeStream(data: any, body: any): Response {
  const choice = data.choices[0];
  const message = choice.message;
  const id = data.id ?? `chatcmpl-proxy-${Date.now()}`;
  const created = data.created ?? Math.floor(Date.now() / 1000);
  const model = data.model ?? body.model;
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
  hostname: HOST,
  idleTimeout: 240, // seconds; > REQUEST_TIMEOUT_MS so slow upstream draws are not cut by Bun
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await req.json();
      if (GUARDED_MODELS.has(body.model)) {
        try {
          return isStructuredRequest(body) ? await handleStructured(body) : await handleToolCall(body);
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

log(`ornith-guard-proxy listening on ${HOST}:${PORT} -> ${UPSTREAM}, guarding: ${[...GUARDED_MODELS].join(", ")} (structured floor ${STRUCTURED_MIN_TOKENS} tok, toolcall cap ${TOOLCALL_MAX_TOKENS} tok, ${MAX_ATTEMPTS} attempts)`);
