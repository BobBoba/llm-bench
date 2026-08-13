// Tool-calling RELIABILITY benchmark — the "everyday agentic workflow" test.
// A deterministic mock business-API forces the model to CHAIN tool calls:
//   list_customers() -> get_orders(id) -> get_price(item) [fan-out] -> submit_total(name,total)
// The correct total is known in advance, so scoring is OBJECTIVE. Each model runs K times to
// measure FLAKINESS (the real weakness of fast small models: dropped/duplicated/malformed calls).
//
// Metrics per run: success (correct total submitted), valid_call% (well-formed tool calls),
// malformed (hallucinated names / unparsable args / schema misses), steps, cost, latency.
//
// Usage: LLM_CLIENT=openrouter node run-tooluse.mjs [model1 model2 ...]
//   OUT=results-fast300-tooluse.json to override output file.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Same client switch as the other runners: cloud (openrouter+ZDR) is the default target here.
const CLIENT_MAP = { openrouter: './openrouter-client.mjs', claudecode: './claudecode-client.mjs', morph: './morph-client.mjs' };
const { chat } = await import(CLIENT_MAP[process.env.LLM_CLIENT] || './lmstudio-client.mjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// ---- deterministic mock dataset (the ground truth) ----
// Acme's orders: 3×widget(10) + 2×gadget(25) + 5×gizmo(7) = 30+50+35 = 115.
const CUSTOMERS = [
  { id: 'C1', name: 'Acme' },
  { id: 'C2', name: 'Globex' },
  { id: 'C3', name: 'Initech' },
];
const ORDERS = {
  C1: [{ item: 'widget', qty: 3 }, { item: 'gadget', qty: 2 }, { item: 'gizmo', qty: 5 }],
  C2: [{ item: 'sprocket', qty: 4 }],
  C3: [{ item: 'widget', qty: 1 }, { item: 'cog', qty: 2 }],
};
const PRICES = { widget: 10, gadget: 25, gizmo: 7, sprocket: 12, cog: 15 };
const TARGET_NAME = 'Acme';
const TARGET_TOTAL = 115;

// ---- tool schemas (OpenAI/OpenRouter function-calling format) ----
const TOOLS = [
  { type: 'function', function: { name: 'list_customers', description: 'List all customers with their id and name.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_orders', description: 'Get all orders (item and quantity) for a customer id.', parameters: { type: 'object', properties: { customer_id: { type: 'string', description: 'The customer id, e.g. C1' } }, required: ['customer_id'] } } },
  { type: 'function', function: { name: 'get_price', description: 'Get the unit price of an item.', parameters: { type: 'object', properties: { item: { type: 'string', description: 'The item name, e.g. widget' } }, required: ['item'] } } },
  { type: 'function', function: { name: 'submit_total', description: 'Submit the final computed total order value for the customer. Call this once when done.', parameters: { type: 'object', properties: { customer_name: { type: 'string' }, total: { type: 'number' } }, required: ['customer_name', 'total'] } } },
];
const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name));

// Validate a single tool call against the schema. Returns {ok, args, reason}.
function validateCall(c) {
  const name = c.function?.name;
  if (!TOOL_NAMES.has(name)) return { ok: false, reason: `unknown_tool:${name}` };
  let args;
  try { args = c.function.arguments ? JSON.parse(c.function.arguments) : {}; }
  catch (_) { return { ok: false, reason: 'unparsable_args' }; }
  const spec = TOOLS.find(t => t.function.name === name).function.parameters;
  for (const req of (spec.required || [])) {
    if (!(req in args)) return { ok: false, reason: `missing:${req}` };
  }
  // light type check for submit_total.total (the common failure: total sent as string)
  if (name === 'submit_total' && typeof args.total !== 'number' && isNaN(Number(args.total))) {
    return { ok: false, reason: 'total_not_number' };
  }
  return { ok: true, args };
}

// Execute a valid tool call against the mock dataset, return the tool result string.
function execCall(name, args) {
  if (name === 'list_customers') return JSON.stringify(CUSTOMERS);
  if (name === 'get_orders') return JSON.stringify(ORDERS[args.customer_id] ?? { error: 'no such customer' });
  if (name === 'get_price') return JSON.stringify({ item: args.item, price: PRICES[args.item] ?? null });
  return '';
}

const SYSTEM = 'You are an assistant with access to a small business API through tools. Use the tools to answer. Chain calls as needed: first discover, then fetch details, then compute. When you have the final numeric answer, call submit_total exactly once. Do not guess data you can look up.';
const TASK = "Find the customer named 'Acme'. Compute the total value of ALL their orders (sum of quantity × unit price across every item they ordered). Then submit the total.";

async function runOnce(model, runIdx, maxSteps = 8) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: TASK },
  ];
  let steps = 0, totalCalls = 0, validCalls = 0, malformed = 0;
  let submitted = null, submittedName = null, cost = 0, latency = 0, reasonTok = 0, finish = null;
  let err = null;

  for (let step = 0; step < maxSteps; step++) {
    const res = await chat({ model: model.id, max_tokens: 4000, tools: TOOLS, tool_choice: 'auto', messages });
    if (!res.ok) { err = res.error; if (res.timeout) err = 'timeout'; break; }
    steps++; cost += res.cost || 0; latency += res.total || 0; reasonTok += res.usage?.reasoning || 0;
    finish = res.finish;
    const calls = res.tool_calls || [];
    messages.push({ role: 'assistant', content: res.content || '', tool_calls: calls.length ? calls : undefined });

    if (!calls.length) {
      // Model produced text instead of a tool call. If it's the terminal step it just gave up
      // on the protocol — that's a reliability miss (no submit_total). Stop.
      break;
    }
    let terminal = false;
    for (const c of calls) {
      totalCalls++;
      const v = validateCall(c);
      if (!v.ok) {
        malformed++;
        messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ error: `invalid tool call: ${v.reason}` }) });
        continue;
      }
      validCalls++;
      const name = c.function.name;
      if (name === 'submit_total') {
        submitted = Number(v.args.total);
        submittedName = String(v.args.customer_name || '');
        messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ received: true }) });
        terminal = true;
      } else {
        messages.push({ role: 'tool', tool_call_id: c.id, content: execCall(name, v.args) });
      }
    }
    if (terminal) break;
  }

  const nameOk = submittedName != null && submittedName.toLowerCase().includes(TARGET_NAME.toLowerCase());
  const totalOk = submitted != null && Math.abs(submitted - TARGET_TOTAL) < 0.5;
  const success = nameOk && totalOk;
  return {
    model: model.short, run: runIdx, ok: err == null, error: err,
    success, submitted, submittedName, nameOk, totalOk,
    steps, totalCalls, validCalls, malformed,
    validRate: totalCalls ? +(validCalls / totalCalls).toFixed(3) : 0,
    cost: +cost.toFixed(6), latency: +latency.toFixed(1), reasonTok, finish,
  };
}

// ---- driver: resumable, crash-safe (save after each run, skip done model|run) ----
const MODELS = process.argv.slice(2).map(id => ({ id, short: id }));
if (!MODELS.length) { log('need at least one model id'); process.exit(1); }
const K = Number(process.env.RUNS || 3);
const outPath = process.env.OUT
  ? (path.isAbsolute(process.env.OUT) ? process.env.OUT : path.join(__dirname, 'results', process.env.OUT))
  : path.join(__dirname, 'results', 'results-fast300-tooluse.json');

let records = [];
if (fs.existsSync(outPath)) { try { records = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (_) { records = []; } }
const done = new Set(records.filter(r => r.ok).map(r => `${r.model}|${r.run}`));
const save = () => fs.writeFileSync(outPath, JSON.stringify(records, null, 1));

for (const model of MODELS) {
  log(`\n===== TOOLUSE ${model.id} (target ${TARGET_NAME}=${TARGET_TOTAL}) =====`);
  for (let r = 1; r <= K; r++) {
    if (done.has(`${model.id}|${r}`)) { log(`run${r}: (skip, done)`); continue; }
    const rec = await runOnce(model, r);
    log(`run${r}: ${rec.ok ? `${rec.success ? 'OK' : 'FAIL'} submit=${rec.submitted}(${rec.submittedName}) valid=${rec.validCalls}/${rec.totalCalls} malformed=${rec.malformed} steps=${rec.steps} ${rec.latency}s $${rec.cost}` : 'ERR ' + rec.error}`);
    records.push(rec); save();
  }
}
log(`\nDONE ${outPath} (${records.length} records)`);
