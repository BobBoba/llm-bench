// Variant of judge-knowledge.mjs that judges via the `claude` CLI (subscription, Opus 4.8)
// instead of OpenRouter — used when no OpenRouter inference key is available.
// Same blind rubric/prompt as the original, so scores stay comparable.
// Usage: node judge-knowledge-cc.mjs <knowledge-results.json> <out-scores.json>
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { TASKS, FACT_PROBES } = require('./tasks-knowledge.js');

const inPath = process.argv[2];
const outPath = process.argv[3];
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

function judge(prompt) {
  for (let a = 0; a < 2; a++) {
    try {
      const out = execFileSync('claude', ['-p'], { input: prompt, encoding: 'utf8', maxBuffer: 20e6, timeout: 240000 });
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) { if (a < 1) continue; return { error: 'no_json' }; }
      return JSON.parse(m[0]);
    } catch (e) { if (a < 1) continue; return { error: String(e.message).slice(0, 150) }; }
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
  const s = judge(buildPrompt(answers));
  if (s.error) { log(`${model}: JUDGE ERR ${s.error}`); continue; }
  s.empties = empties;
  s.avg = +(((s.facts + s.ideas + s.fermi + s.forecast + s.analysis) / 5)).toFixed(2);
  scores[model] = s;
  fs.writeFileSync(outPath, JSON.stringify(scores, null, 1));
  log(`${model}: facts=${s.facts} ideas=${s.ideas} fermi=${s.fermi} forecast=${s.forecast} analysis=${s.analysis} avg=${s.avg} empties=${empties} — ${s.notes || ''}`);
}
log(`\nDONE ${outPath} (${Object.keys(scores).length} models scored)`);
