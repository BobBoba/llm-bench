// Tool-calling reliability benchmark — HARD dataset + CALCULATOR tools.
// Causal experiment: the hard variant's only failure mode was ARITHMETIC (model orchestrated
// perfectly but summed wrong). Here we give the model `multiply` and `sum` tools and forbid
// mental math. If the score rises to 5/5, the failure was arithmetic, not orchestration.
//
// Same deterministic ground truth as run-tooluse-hard.mjs (Acme Corp = 360, decoy Acme Labs).
// Usage: node run-tooluse-calc.mjs [model ...]   (RUNS=K, OUT=file to override)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CLIENT_MAP = { openrouter: './openrouter-client.mjs', claudecode: './claudecode-client.mjs', morph: './morph-client.mjs' };
const { chat } = await import(CLIENT_MAP[process.env.LLM_CLIENT] || './lmstudio-client.mjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const CUSTOMERS = [
  { id: 'C1', name: 'Acme Corp' },
  { id: 'C2', name: 'Acme Labs' },
  { id: 'C3', name: 'Globex' },
  { id: 'C4', name: 'Initech' },
];
const ORDERS = {
  C1: [
    { item: 'widget', qty: 7 }, { item: 'gadget', qty: 3 }, { item: 'gizmo', qty: 11 },
    { item: 'sprocket', qty: 4 }, { item: 'cog', qty: 6 },
  ],
  C2: [{ item: 'widget', qty: 1 }, { item: 'gadget', qty: 1 }],
  C3: [{ item: 'sprocket', qty: 4 }],
  C4: [{ item: 'widget', qty: 1 }, { item: 'cog', qty: 2 }],
};
const PRICES = { widget: 10, gadget: 25, gizmo: 7, sprocket: 12, cog: 15 };
const TARGET_NAME = 'Acme Corp';
const TARGET_TOTAL = 360;

const TOOLS = [
  { type: 'function', function: { name: 'list_customers', description: 'List all customers with their id and name.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_orders', description: 'Get all orders (item and quantity) for a customer id.', parameters: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] } } },
  { type: 'function', function: { name: 'get_price', description: 'Get the unit price of an item.', parameters: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] } } },
  // --- calculator tools: the model MUST use these for arithmetic ---
  { type: 'function', function: { name: 'multiply', description: 'Multiply two numbers. Use for quantity × unit price.', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } } },
  { type: 'function', function: { name: 'sum', description: 'Sum a list of numbers. Use to total the line values.', parameters: { type: 'object', properties: { numbers: { type: 'array', items: { type: 'number' } } }, required: ['numbers'] } } },
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

function execCall(name, args) {
  if (name === 'list_customers') return JSON.stringify(CUSTOMERS);
  if (name === 'get_orders') return JSON.stringify(ORDERS[args.customer_id] ?? { error: 'no such customer' });
  if (name === 'get_price') return JSON.stringify({ item: args.item, price: PRICES[args.item] ?? null });
  if (name === 'multiply') return JSON.stringify({ result: Number(args.a) * Number(args.b) });
  if (name === 'sum') return JSON.stringify({ result: (args.numbers || []).reduce((s, n) => s + Number(n), 0) });
  return '';
}

const SYSTEM = 'You are an assistant with access to a small business API through tools. Chain calls: discover, fetch details, then compute. IMPORTANT: you are unreliable at mental math — you MUST use the multiply and sum tools for EVERY arithmetic step (quantity × price, and totalling). Never compute numbers in your head. When you have the final numeric answer from the sum tool, call submit_total exactly once.';
const TASK = "Find the customer named exactly 'Acme Corp' (another customer has a similar name). Compute the total value of ALL their orders (sum of quantity × unit price across every item). Use the multiply and sum tools for all arithmetic. Then submit the total.";

async function runOnce(model, runIdx, maxSteps = 16) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: TASK }];
  let steps = 0, totalCalls = 0, validCalls = 0, malformed = 0, calcCalls = 0;
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
      if (name === 'multiply' || name === 'sum') calcCalls++;
      if (name === 'submit_total') {
        submitted = Number(v.args.total); submittedName = String(v.args.customer_name || '');
        messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ received: true }) }); terminal = true;
      } else {
        messages.push({ role: 'tool', tool_call_id: c.id, content: execCall(name, v.args) });
      }
    }
    if (terminal) break;
  }

  const nameOk = submittedName != null && submittedName.toLowerCase().includes(TARGET_NAME.toLowerCase());
  const totalOk = submitted != null && Math.abs(submitted - TARGET_TOTAL) < 0.5;
  return {
    model: model.short, run: runIdx, ok: err == null, error: err,
    success: nameOk && totalOk, submitted, submittedName, nameOk, totalOk,
    steps, totalCalls, validCalls, malformed, calcCalls,
    validRate: totalCalls ? +(validCalls / totalCalls).toFixed(3) : 0,
    cost: +cost.toFixed(6), latency: +latency.toFixed(1), reasonTok, finish,
  };
}

const MODELS = process.argv.slice(2).map(id => ({ id, short: id }));
if (!MODELS.length) { log('need at least one model id'); process.exit(1); }
const K = Number(process.env.RUNS || 5);
const outPath = process.env.OUT
  ? (path.isAbsolute(process.env.OUT) ? process.env.OUT : path.join(__dirname, 'results', process.env.OUT))
  : path.join(__dirname, 'results', 'results-tooluse-calc.json');

let records = [];
if (fs.existsSync(outPath)) { try { records = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (_) { records = []; } }
const done = new Set(records.filter(r => r.ok).map(r => `${r.model}|${r.run}`));
const save = () => fs.writeFileSync(outPath, JSON.stringify(records, null, 1));

for (const model of MODELS) {
  log(`\n===== TOOLUSE-CALC ${model.id} (target ${TARGET_NAME}=${TARGET_TOTAL}, calc tools) =====`);
  for (let r = 1; r <= K; r++) {
    if (done.has(`${model.id}|${r}`)) { log(`run${r}: (skip, done)`); continue; }
    const rec = await runOnce(model, r);
    log(`run${r}: ${rec.ok ? `${rec.success ? 'OK' : 'FAIL'} submit=${rec.submitted}(${rec.submittedName}) total=${rec.totalOk} calc=${rec.calcCalls} valid=${rec.validCalls}/${rec.totalCalls} malformed=${rec.malformed} steps=${rec.steps} ${rec.latency}s` : 'ERR ' + rec.error}`);
    records.push(rec); save();
  }
}
log(`\nDONE ${outPath} (${records.length} records)`);
