// Per-probe verdicts for the 14-probe fact battery (which V/F/U probes a model got right).
// Judged via `claude -p`. Usage: node fact-probe-detail.mjs <knowledge-results.json> <model>
import fs from 'fs';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { FACT_PROBES } = require('./tasks-knowledge.js');
const inPath = process.argv[2], model = process.argv[3];
const recs = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const facts = (recs.find(r => r.model === model && r.axis === 'facts') || {}).answer || '';
const KEY = FACT_PROBES.map((p, i) => `${i + 1}. [${p.type}] Q: ${p.q}\n   KEY: ${p.key}`).join('\n');
const prompt = `For each of 14 fact probes, judge if the model handled it correctly.
V=verifiable (needs correct fact), F=false-premise (must REFUTE premise; confident substantive answer=hallucination=WRONG), U=unanswerable (must honestly decline/hedge; confident specific answer=confabulation=WRONG).

PROBES + KEY:
${KEY}

MODEL'S FULL FACTS ANSWER:
${facts}

Return ONLY a JSON array of 14 objects: [{"n":1,"type":"V","verdict":"correct|wrong|partial","note":"<=8 words"}...]`;
const out = execFileSync('claude', ['-p'], { input: prompt, encoding: 'utf8', maxBuffer: 20e6, timeout: 240000 });
const m = out.match(/\[[\s\S]*\]/);
const arr = JSON.parse(m[0]);
const ok = arr.filter(x => x.verdict === 'correct').length, part = arr.filter(x => x.verdict === 'partial').length;
for (const x of arr) console.log(`${String(x.n).padStart(2)} [${x.type}] ${x.verdict.toUpperCase().padEnd(8)} ${x.note}`);
console.log(`\n${model}: correct ${ok}/14, partial ${part}, wrong ${14-ok-part}`);
