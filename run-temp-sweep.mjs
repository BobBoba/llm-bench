// Temperature sweep for a local model — direct (non-agentic) behavior probe.
// For each temperature × query, sends the prompt and PRINTS the full query and response,
// plus per-call stats (completion tokens, latency, tok/s, finish reason). Purpose: eyeball
// how temperature shifts determinism, correctness and diversity on a small local model.
//
// Usage: node run-temp-sweep.mjs [model]   (default minicpm5-1b)
//   TEMPS="0,0.3,0.7,1.0" to override temperatures, MAXTOK=300, REPEAT=1 samples per cell.

import { chat } from './lmstudio-client.mjs';

const MODEL = process.argv[2] || 'minicpm5-1b';
const TEMPS = (process.env.TEMPS || '0,0.3,0.7,1.0').split(',').map(Number);
const MAXTOK = Number(process.env.MAXTOK || 1536);
const SHOWREASON = process.env.SHOWREASON !== '0'; // print the hidden reasoning channel too
const REPEAT = Number(process.env.REPEAT || 1);
const out = (...a) => process.stdout.write(a.join(' ') + '\n');

// Diverse probe set — each targets a different axis of behavior.
const QUERIES = [
  { id: 'fact', tag: 'factual / instruction-follow', prompt: 'What is the capital of Australia? Answer with only the city name.' },
  { id: 'math', tag: 'arithmetic (the 360 basket that failed agentically)', prompt: 'Compute step by step, then give the final number on its own line: 7*10 + 3*25 + 11*7 + 4*12 + 6*15' },
  { id: 'code', tag: 'code generation', prompt: 'Write a Python function is_prime(n) that returns True if n is prime, False otherwise. Output only the code, no explanation.' },
  { id: 'constrained', tag: 'constrained explanation', prompt: 'In exactly one sentence, explain what a mutex is.' },
  { id: 'creative', tag: 'creative (diversity vs temperature)', prompt: 'Invent a name for a coffee shop located on Mars. Reply with just the name.' },
];

out(`\n=================== TEMPERATURE SWEEP: ${MODEL} ===================`);
out(`temps=[${TEMPS.join(', ')}]  max_tokens=${MAXTOK}  repeat=${REPEAT}/cell\n`);

for (const t of TEMPS) {
  out(`\n#################### TEMPERATURE = ${t} ####################`);
  for (const q of QUERIES) {
    for (let rep = 1; rep <= REPEAT; rep++) {
      const messages = [{ role: 'user', content: q.prompt }];
      const res = await chat({ model: MODEL, messages, max_tokens: MAXTOK, temperature: t });
      const repTag = REPEAT > 1 ? ` [sample ${rep}/${REPEAT}]` : '';
      out(`\n----- [${q.id}] ${q.tag}${repTag} -----`);
      out(`Q: ${q.prompt}`);
      if (!res.ok) { out(`A: <ERROR: ${res.error}>`); continue; }
      const reason = (res.reasoning || '').trim();
      const content = (res.content || '').trim();
      // A small reasoner emits a hidden reasoning_content channel; show it so an empty
      // `content` with finish=length is legible as "budget consumed while thinking".
      if (SHOWREASON && reason) out(`[reasoning ${res.usage?.reasoning ?? '?'} tok]: ${reason}`);
      const truncated = res.finish === 'length';
      out(`A: ${content || (truncated ? '<no final answer — hit max_tokens while reasoning>' : '<empty>')}`);
      out(`   · comp=${res.usage?.completion ?? '?'} tok (reasoning=${res.usage?.reasoning ?? 0}) · ${res.total}s · ${res.tokps} tok/s · finish=${res.finish}`);
    }
  }
}
out(`\n=================== DONE ===================`);
