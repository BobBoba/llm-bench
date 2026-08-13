#!/usr/bin/env bash
# Orchestrates the full batch-2 run unattended and survives session teardowns:
#   Phase 1 — RUST for all 16 models (resumable: relaunches run-rust.mjs only if it died
#             AND not all models are done; never runs two concurrently).
#   Phase 2 — humanitarian for all 16 models.
# Writes a final ALL_DONE marker. Safe to re-run: both runners skip completed units.
set -u
cd /sync/Homie/Obsidian/Primary/claudedocs/llm-bench

MODELS=(
  vibethinker-3b
  essentialai/rnj-1
  mistralai/ministral-3-14b-reasoning
  gemma-4-12b-coder-fable5-composer2.5-v1
  openai/gpt-oss-20b
  nvidia/nemotron-3-nano
  google/gemma-4-26b-a4b-qat
  qwen/qwen3.6-27b
  qwen/qwen3-coder-30b
  qwen/qwen3-30b-a3b-2507
  mistralai/devstral-small-2-2512
  allenai/olmo-3-32b-think
  qwen/qwq-32b
  bytedance/seed-oss-36b
  zai-org/glm-4.7-flash
  qwen36-a3b-claude-coder-llama.cpp
)
N=${#MODELS[@]}

rust_done() {
  python3 -c "
import json,sys
try: d=json.load(open('results/results-batch2-rust.json'))
except Exception: sys.exit(1)
ag=set(r['model'] for r in d if r.get('mode')=='agentic' and r.get('ok'))
sys.exit(0 if len(ag)>=$N else 1)
"
}

echo "[orchestrate] phase 1: RUST $(date '+%H:%M')" >> results/orchestrate.log
while ! rust_done; do
  if ! pgrep -f run-rust.mjs >/dev/null 2>&1; then
    echo "[orchestrate] (re)launching run-rust $(date '+%H:%M')" >> results/orchestrate.log
    OUT=results-batch2-rust.json node run-rust.mjs "${MODELS[@]}" >> results/rust-batch2.log 2>&1
  fi
  sleep 20
done
echo "[orchestrate] RUST complete $(date '+%H:%M'); phase 2: knowledge" >> results/orchestrate.log

OUT=results-batch2-knowledge.json node run-knowledge.mjs "${MODELS[@]}" >> results/knowledge-batch2.log 2>&1
echo "[orchestrate] ALL_DONE $(date '+%H:%M')" >> results/orchestrate.log
