#!/usr/bin/env bash
# Finishes batch-2 after the LM Studio restart (JIT re-enabled).
# Phase 1: retry the 5 models that failed on the broken loader (RUST).
# Phase 2: humanitarian for all 16 batch-2 models.
# Single writer, no watchdog. Bash arrays = correct word-splitting (zsh would not split).
set -u
cd /sync/Homie/Obsidian/Primary/claudedocs/llm-bench

RETRY5=(
  zai-org/glm-4.7-flash
  qwen/qwq-32b
  allenai/olmo-3-32b-think
  bytedance/seed-oss-36b
  qwen36-a3b-claude-coder-llama.cpp
)
ALL16=(
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

echo "PHASE1 RUST retry5 $(date '+%H:%M')" > results/phase.log
OUT=results-batch2-rust.json node run-rust.mjs "${RETRY5[@]}" > results/rust-retry.log 2>&1
echo "PHASE2 knowledge all16 $(date '+%H:%M')" >> results/phase.log
OUT=results-batch2-knowledge.json node run-knowledge.mjs "${ALL16[@]}" > results/knowledge-batch2.log 2>&1
echo "ALLFINISHED $(date '+%H:%M')" >> results/phase.log
