// Tool-calling reliability benchmark — HARD variant.
// Same objective, deterministic mock-API design as run-tooluse.mjs, but tuned to STRESS
// small models and reveal where they start to fail:
//   * NAME COLLISION: two customers share the "Acme" prefix (Acme Corp vs Acme Labs) —
//     the model must select the exact one requested, not the first fuzzy match.
//   * DEEPER FAN-OUT: 5 distinct line items → 5 get_price calls to chain (dropped/dup risk).
//   * BIGGER ARITHMETIC: correct total is 360 — large enough that "eyeballed" sums diverge
//     from the honest quantity×price accumulation.
//
// Correct answer is still known in advance, so scoring stays fully objective.
// Usage: node run-tooluse-hard.mjs [model1 model2 ...]   (RUNS=K, OUT=file to override)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CLIENT_MAP = { openrouter: '../clients/openrouter-client.mjs', claudecode: '../clients/claudecode-client.mjs', morph: '../clients/morph-client.mjs' };
const { chat } = await import(CLIENT_MAP[process.env.LLM_CLIENT] || '../clients/llama-server-client.mjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// ---- deterministic mock dataset (the ground truth) ----
// Acme Corp (C1): 7×widget(10) + 3×gadget(25) + 11×gizmo(7) + 4×sprocket(12) + 6×cog(15)
//               = 70 + 75 + 77 + 48 + 90 = 360.
// Acme Labs (C2) is the DECOY — a wrong customer pick yields a very different total (35).
const CUSTOMERS = [
  { id: 'C1', name: 'Acme Corp' },
  { id: 'C2', name: 'Acme Labs' },
  { id: 'C3', name: 'Globex' },
  { id: 'C4', name: 'Initech' },
];
const ORDERS = {
  C1: [
    { item: 'widget', qty: 7 },
    { item: 'gadget', qty: 3 },
    { item: 'gizmo', qty: 11 },
    { item: 'sprocket', qty: 4 },
    { item: 'cog', qty: 6 },
  ],
  C2: [{ item: 'widget', qty: 1 }, { item: 'gadget', qty: 1 }], // decoy: total 35
  C3: [{ item: 'sprocket', qty: 4 }],
  C4: [{ item: 'widget', qty: 1 }, { item: 'cog', qty: 2 }],
};
const PRICES = { widget: 10, gadget: 25, gizmo: 7, sprocket: 12, cog: 15 };
const TARGET_NAME = 'Acme Corp';
const TARGET_TOTAL = 360;

// ---- tool schemas (OpenAI/OpenRouter function-calling format) ----
const TOOLS = [
  { type: 'function', function: { name: 'list_customers', description: 'List all customers with their id and name.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_orders', description: 'Get all orders (item and quantity) for a customer id.', parameters: { type: 'object', properties: { customer_id: { type: 'string', description: 'The customer id, e.g. C1' } }, required: ['customer_id'] } } },
  { type: 'function', function: { name: 'get_price', description: 'Get the unit price of an item.', parameters: { type: 'object', properties: { item: { type: 'string', description: 'The item name, e.g. widget' } }, required: ['item'] } } },
  { type: 'function', function: { name: 'submit_total', description: 'Submit the final computed total order value for the customer. Call this once when done.', parameters: { type: 'object', properties: { customer_name: { type: 'string' }, total: { type: 'number' } }, required: ['customer_name', 'total'] } } },
];
const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name));

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
  if (name === 'submit_total' && typeof args.total !== 'number' && isNaN(Number(args.total))) {
    return { ok: false, reason: 'total_not_number' };
  }
  return { ok: true, args };
}

function execCall(name, args) {
  if (name === 'list_customers') return JSON.stringify(CUSTOMERS);
  if (name === 'get_orders') return JSON.stringify(ORDERS[args.customer_id] ?? { error: 'no such customer' });
  if (name === 'get_price') return JSON.stringify({ item: args.item, price: PRICES[args.item] ?? null });
  return '';
}

const SYSTEM = 'You are an assistant with access to a small business API through tools. Use the tools to answer. Chain calls as needed: first discover, then fetch details, then compute. When you have the final numeric answer, call submit_total exactly once. Do not guess data you can look up.';
const TASK = "Find the customer named exactly 'Acme Corp' (note: another customer has a similar name). Compute the total value of ALL their orders (sum of quantity × unit price across every item they ordered). Then submit the total.";

async function runOnce(model, runIdx, maxSteps = 12) {
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

    if (!calls.length) break;
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

const MODELS = process.argv.slice(2).map(id => ({ id, short: id }));
if (!MODELS.length) { log('need at least one model id'); process.exit(1); }
const K = Number(process.env.RUNS || 5);
const outPath = process.env.OUT
  ? (path.isAbsolute(process.env.OUT) ? process.env.OUT : path.join(__dirname, '..', 'results', process.env.OUT))
  : path.join(__dirname, '..', 'results', 'results-tooluse-hard.json');

let records = [];
if (fs.existsSync(outPath)) { try { records = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (_) { records = []; } }
const done = new Set(records.filter(r => r.ok).map(r => `${r.model}|${r.run}`));
const save = () => fs.writeFileSync(outPath, JSON.stringify(records, null, 1));

for (const model of MODELS) {
  log(`\n===== TOOLUSE-HARD ${model.id} (target ${TARGET_NAME}=${TARGET_TOTAL}) =====`);
  for (let r = 1; r <= K; r++) {
    if (done.has(`${model.id}|${r}`)) { log(`run${r}: (skip, done)`); continue; }
    const rec = await runOnce(model, r);
    log(`run${r}: ${rec.ok ? `${rec.success ? 'OK' : 'FAIL'} submit=${rec.submitted}(${rec.submittedName}) name=${rec.nameOk} total=${rec.totalOk} valid=${rec.validCalls}/${rec.totalCalls} malformed=${rec.malformed} steps=${rec.steps} ${rec.latency}s` : 'ERR ' + rec.error}`);
    records.push(rec); save();
  }
}
log(`\nDONE ${outPath} (${records.length} records)`);
