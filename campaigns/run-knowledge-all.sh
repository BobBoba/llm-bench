#!/usr/bin/env bash
# Humanitarian (knowledge) run for all 16 batch-2 models. Most-valuable (RUST-valid)
# models first; the 4 that failed RUST loading last, so any LM Studio swap degradation
# costs the least. Resumable + incremental write. Bash array = correct word-splitting.
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
  zai-org/glm-4.7-flash
  bytedance/seed-oss-36b
  qwen/qwq-32b
  allenai/olmo-3-32b-think
  qwen36-a3b-claude-coder-llama.cpp
)
echo "KNOW START $(date '+%H:%M')" > results/knowledge-phase.log
OUT=results-batch2-knowledge.json node runners/run-knowledge.mjs "${MODELS[@]}" > results/knowledge-batch2.log 2>&1
echo "KNOW DONE $(date '+%H:%M')" >> results/knowledge-phase.log
