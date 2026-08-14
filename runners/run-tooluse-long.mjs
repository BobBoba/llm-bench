// Tool-calling reliability benchmark — LONG CHAIN + TOOL AMBIGUITY variant.
// Two new stress axes beyond run-tooluse-hard.mjs:
//   * LONGER CHAIN: get_orders returns SKUs, not names. Each SKU needs resolve_sku() before
//     its price can be fetched — an extra hop per item. 5 items => ~13 tool calls / 10+ steps
//     if the model does not batch. Tests state-tracking over a long loop (drop/dup/derail risk).
//   * TOOL AMBIGUITY: two price tools exist — get_wholesale_price (correct) and
//     get_retail_price (decoy, higher). The task demands WHOLESALE. Tests correct tool
//     selection under a plausible wrong alternative.
//
// Ground truth: Acme Corp, wholesale total = 360. Using retail prices yields a different number,
// so a wrong-tool pick is caught by totalOk. Also flags whether the retail tool was touched.
// Usage: node run-tooluse-long.mjs [model ...]   (RUNS=K, OUT=file to override)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CLIENT_MAP = { openrouter: '../clients/openrouter-client.mjs', claudecode: '../clients/claudecode-client.mjs', morph: '../clients/morph-client.mjs' };
const { chat } = await import(CLIENT_MAP[process.env.LLM_CLIENT] || '../clients/llama-server-client.mjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const CUSTOMERS = [
  { id: 'C1', name: 'Acme Corp' },
  { id: 'C2', name: 'Acme Labs' },
  { id: 'C3', name: 'Globex' },
  { id: 'C4', name: 'Initech' },
];
// Orders reference SKUs, not item names — forces the resolve_sku hop.
const ORDERS = {
  C1: [
    { sku: 'SKU-W', qty: 7 }, { sku: 'SKU-G', qty: 3 }, { sku: 'SKU-Z', qty: 11 },
    { sku: 'SKU-S', qty: 4 }, { sku: 'SKU-C', qty: 6 },
  ],
  C2: [{ sku: 'SKU-W', qty: 1 }, { sku: 'SKU-G', qty: 1 }],
  C3: [{ sku: 'SKU-S', qty: 4 }],
  C4: [{ sku: 'SKU-W', qty: 1 }, { sku: 'SKU-C', qty: 2 }],
};
const SKU_TO_ITEM = { 'SKU-W': 'widget', 'SKU-G': 'gadget', 'SKU-Z': 'gizmo', 'SKU-S': 'sprocket', 'SKU-C': 'cog' };
const WHOLESALE = { widget: 10, gadget: 25, gizmo: 7, sprocket: 12, cog: 15 }; // -> 360
const RETAIL = { widget: 14, gadget: 30, gizmo: 9, sprocket: 15, cog: 20 };    // decoy, wrong total
const TARGET_NAME = 'Acme Corp';
const TARGET_TOTAL = 360;

const TOOLS = [
  { type: 'function', function: { name: 'list_customers', description: 'List all customers with their id and name.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_orders', description: 'Get all orders (sku and quantity) for a customer id.', parameters: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] } } },
  { type: 'function', function: { name: 'resolve_sku', description: 'Resolve a product SKU code to its item name.', parameters: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] } } },
  { type: 'function', function: { name: 'get_wholesale_price', description: 'Get the WHOLESALE unit price of an item by name.', parameters: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] } } },
  { type: 'function', function: { name: 'get_retail_price', description: 'Get the RETAIL (consumer) unit price of an item by name.', parameters: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] } } },
  { type: 'function', function: { name: 'submit_total', description: 'Submit the final computed total. Call once when done.', parameters: { type: 'object', properties: { customer_name: { type: 'string' }, total: { type: 'number' } }, required: ['customer_name', 'total'] } } },
];
const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name));

function validateCall(c) {
  const name = c.function?.name;
  if (!TOOL_NAMES.has(name)) return { ok: false, reason: `unknown_tool:${name}` };
  let args;
  try { args = c.function.arguments ? JSON.parse(c.function.arguments) : {}; }
  catch (_) { return { ok: false, reason: 'unparsable_args' }; }
  const spec = TOOLS.find(t => t.function.name === name).function.parameters;
  for (const req of (spec.required || [])) if (!(req in args)) return { ok: false, reason: `missing:${req}` };
  if (name === 'submit_total' && typeof args.total !== 'number' && isNaN(Number(args.total))) return { ok: false, reason: 'total_not_number' };
  return { ok: true, args };
}

function execCall(name, args, state) {
  if (name === 'list_customers') return JSON.stringify(CUSTOMERS);
  if (name === 'get_orders') return JSON.stringify(ORDERS[args.customer_id] ?? { error: 'no such customer' });
  if (name === 'resolve_sku') return JSON.stringify({ sku: args.sku, item: SKU_TO_ITEM[args.sku] ?? null });
  if (name === 'get_wholesale_price') return JSON.stringify({ item: args.item, price: WHOLESALE[args.item] ?? null });
  if (name === 'get_retail_price') { state.usedRetail = true; return JSON.stringify({ item: args.item, price: RETAIL[args.item] ?? null }); }
  return '';
}

const SYSTEM = 'You are an assistant with access to a business API through tools. Orders reference SKU codes — resolve each SKU to an item name before pricing it. Chain calls as needed. When done, call submit_total exactly once. Do not guess data you can look up.';
const TASK = "Find the customer named exactly 'Acme Corp' (another customer has a similar name). For each item they ordered, resolve its SKU to a name, then look up its WHOLESALE unit price (NOT the retail price). Compute the total value of all orders (sum of quantity × wholesale unit price). Then submit the total.";

async function runOnce(model, runIdx, maxSteps = 20) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: TASK }];
  const state = { usedRetail: false };
  let steps = 0, totalCalls = 0, validCalls = 0, malformed = 0;
  let submitted = null, submittedName = null, cost = 0, latency = 0, reasonTok = 0, finish = null, err = null;

  for (let step = 0; step < maxSteps; step++) {
    const res = await chat({ model: model.id, max_tokens: 4000, tools: TOOLS, tool_choice: 'auto', messages });
    if (!res.ok) { err = res.error; if (res.timeout) err = 'timeout'; break; }
    steps++; cost += res.cost || 0; latency += res.total || 0; reasonTok += res.usage?.reasoning || 0; finish = res.finish;
    const calls = res.tool_calls || [];
    messages.push({ role: 'assistant', content: res.content || '', tool_calls: calls.length ? calls : undefined });
    if (!calls.length) break;
    let terminal = false;
    for (const c of calls) {
      totalCalls++;
      const v = validateCall(c);
      if (!v.ok) { malformed++; messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ error: `invalid tool call: ${v.reason}` }) }); continue; }
      validCalls++;
      const name = c.function.name;
      if (name === 'submit_total') {
        submitted = Number(v.args.total); submittedName = String(v.args.customer_name || '');
        messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ received: true }) }); terminal = true;
      } else {
        messages.push({ role: 'tool', tool_call_id: c.id, content: execCall(name, v.args, state) });
      }
    }
    if (terminal) break;
  }

  const nameOk = submittedName != null && submittedName.toLowerCase().includes(TARGET_NAME.toLowerCase());
  const totalOk = submitted != null && Math.abs(submitted - TARGET_TOTAL) < 0.5;
  return {
    model: model.short, run: runIdx, ok: err == null, error: err,
    success: nameOk && totalOk, submitted, submittedName, nameOk, totalOk, usedRetail: state.usedRetail,
    steps, totalCalls, validCalls, malformed,
    validRate: totalCalls ? +(validCalls / totalCalls).toFixed(3) : 0,
    cost: +cost.toFixed(6), latency: +latency.toFixed(1), reasonTok, finish,
  };
}

const MODELS = process.argv.slice(2).map(id => ({ id, short: id }));
if (!MODELS.length) { log('need at least one model id'); process.exit(1); }
const K = Number(process.env.RUNS || 5);
const outPath = process.env.OUT
  ? (path.isAbsolute(process.env.OUT) ? process.env.OUT : path.join(__dirname, '..', 'results', process.env.OUT))
  : path.join(__dirname, '..', 'results', 'results-tooluse-long.json');

let records = [];
if (fs.existsSync(outPath)) { try { records = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (_) { records = []; } }
const done = new Set(records.filter(r => r.ok).map(r => `${r.model}|${r.run}`));
const save = () => fs.writeFileSync(outPath, JSON.stringify(records, null, 1));

for (const model of MODELS) {
  log(`\n===== TOOLUSE-LONG ${model.id} (target ${TARGET_NAME}=${TARGET_TOTAL} wholesale) =====`);
  for (let r = 1; r <= K; r++) {
    if (done.has(`${model.id}|${r}`)) { log(`run${r}: (skip, done)`); continue; }
    const rec = await runOnce(model, r);
    log(`run${r}: ${rec.ok ? `${rec.success ? 'OK' : 'FAIL'} submit=${rec.submitted}(${rec.submittedName}) total=${rec.totalOk} usedRetail=${rec.usedRetail} valid=${rec.validCalls}/${rec.totalCalls} malformed=${rec.malformed} steps=${rec.steps} ${rec.latency}s` : 'ERR ' + rec.error}`);
    records.push(rec); save();
  }
}
log(`\nDONE ${outPath} (${records.length} records)`);
