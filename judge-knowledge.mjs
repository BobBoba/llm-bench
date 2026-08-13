// Automated Opus-4.8 LLM-judge for the knowledge battery, so a 40-model sweep can be scored
// consistently against the SAME blind rubric a human Opus judge used for prior rows.
//
// * One judge call per model, covering all 5 axes at once (the judge sees the whole profile).
//   Facts are scored against the pre-written V/F/U answer key; the four open axes against their
//   documented rubrics. Judge = anthropic/claude-opus-4-8 via OpenRouter (judging our own outputs,
//   so ZDR is irrelevant here). Returns strict JSON -> hum-scores-<tag>.json for the injector.
// * Resumable: skips models already scored. Usage:
//     OPENROUTER_API_KEY=... node judge-knowledge.mjs <knowledge-results.json> <out-scores.json>

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { TASKS, FACT_PROBES } = require('./tasks-knowledge.js');
const KEY = (process.env.OPENROUTER_API_KEY || fs.readFileSync('/tmp/.orkey', 'utf8')).trim();
const JUDGE_MODEL = 'anthropic/claude-opus-4-8';

const inPath = process.argv[2] || path.join(__dirname, 'results', 'results-fast100-knowledge.json');
const outPath = process.argv[3] || path.join(__dirname, 'results', 'hum-scores-fast100.json');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const AXIS = Object.fromEntries(TASKS.map(t => [t.key, t]));
const FACT_KEY = FACT_PROBES.map((p, i) => `${i + 1}. [${p.type}] Q: ${p.q}\n   KEY: ${p.key}`).join('\n');

function buildPrompt(answers) {
  const get = k => (answers[k] || '').trim() || '[EMPTY ANSWER]';
  return `You are a strict, calibrated benchmark judge. Score a model's answers on five axes, each 0-10 (one decimal ok). Be discriminating: 9-10 = excellent, 7-8 = solid, 5-6 = mediocre, <5 = poor. Do not inflate.

=== AXIS 1: FACTS / HALLUCINATION ===
A 14-probe battery. V = verifiable (reward correct fact), F = false-premise (reward REFUTING the premise; a confident substantive answer = hallucination = penalize hard), U = unanswerable (reward honest decline/hedge; a confident specific answer = confabulation = penalize). Answer key:
${FACT_KEY}

MODEL'S FACT ANSWERS:
${get('facts')}

=== AXIS 2: IDEAS / CREATIVITY ===
Rubric: ${AXIS.ideas.rubric}
MODEL'S ANSWER:
${get('ideas')}

=== AXIS 3: FERMI ESTIMATION ===
Rubric: ${AXIS.fermi.rubric}
Anchor: ${AXIS.fermi.answerKey}
MODEL'S ANSWER:
${get('fermi')}

=== AXIS 4: FORECASTING / CALIBRATION ===
Rubric: ${AXIS.forecast.rubric}
MODEL'S ANSWER:
${get('forecast')}

=== AXIS 5: ANALYSIS / REASONING ===
Rubric: ${AXIS.analysis.rubric}
MODEL'S ANSWER:
${get('analysis')}

Return ONLY a JSON object, no prose, no code fence:
{"facts":N,"ideas":N,"fermi":N,"forecast":N,"analysis":N,"notes":"one terse sentence on the standout strength/weakness"}`;
}

async function judge(prompt) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: JUDGE_MODEL, max_tokens: 4000, temperature: 0,
          messages: [{ role: 'user', content: prompt }] }),
      });
      const d = await r.json();
      if (d.error) { if (a < 2) { await new Promise(s => setTimeout(s, 3000)); continue; } return { error: JSON.stringify(d.error).slice(0, 120) }; }
      let c = d.choices?.[0]?.message?.content || '';
      const m = c.match(/\{[\s\S]*\}/);
      if (!m) { if (a < 2) continue; return { error: 'no_json' }; }
      return JSON.parse(m[0]);
    } catch (e) { if (a < 2) { await new Promise(s => setTimeout(s, 3000)); continue; } return { error: String(e.message).slice(0, 100) }; }
  }
  return { error: 'exhausted' };
}

const recs = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const byModel = {};
for (const r of recs) { (byModel[r.model] ||= {}); if (r.ok) byModel[r.model][r.axis] = r.answer; }

let scores = {};
if (fs.existsSync(outPath)) { try { scores = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (_) {} }

for (const [model, answers] of Object.entries(byModel)) {
  if (scores[model]) { log(`${model}: (skip, judged)`); continue; }
  const empties = TASKS.filter(t => !((answers[t.key] || '').trim())).length;
  const s = await judge(buildPrompt(answers));
  if (s.error) { log(`${model}: JUDGE ERR ${s.error}`); continue; }
  s.empties = empties;
  s.avg = +(((s.facts + s.ideas + s.fermi + s.forecast + s.analysis) / 5)).toFixed(2);
  scores[model] = s;
  fs.writeFileSync(outPath, JSON.stringify(scores, null, 1));
  log(`${model}: facts=${s.facts} ideas=${s.ideas} fermi=${s.fermi} forecast=${s.forecast} analysis=${s.analysis} avg=${s.avg} empties=${empties} — ${s.notes || ''}`);
}
log(`\nDONE ${outPath} (${Object.keys(scores).length} models scored)`);
