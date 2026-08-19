#!/usr/bin/env bash
# Добор ступеней бисекции, потерянных фильтром прореживания [[19.08.2026]].
# Ждём конца текущей бисекции, затем догоняем пропущенные точки (фильтр уже отключён для
# явных RUNGS, поэтому теперь пройдут все).
set -u
cd "$(dirname "$0")/.."
export LLAMA_SERVER_BASE=http://gaming-pc.lan:8888/v1
export LLAMA_SERVER_KEY_FILE=/tmp/.unsloth-gp
REPO="unsloth/Qwen3.8-27B-GGUF"
LOG=results/qwen38-cliff0819.log
VS="LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20"
while pgrep -f "run-qwen38-cliff0819.sh" > /dev/null; do sleep 30; done

echo "=== ДОБОР: Q2 пропущенные ступени 163840,196608 ===" >> "$LOG"
bash tools/wait-studio.sh 900 >> "$LOG" 2>&1
bash tools/ladder-probe.sh "$REPO:UD-Q2_K_XL" 262144 >> "$LOG" 2>&1
env $VS LLM_DEADLINE_MS=2400000 CTX=262144 RUNGS="163840,196608" \
  OUT="results-EXP-qwen38q-udq2kxl-cliff.json" node runners/run-multineedle.mjs "$REPO:UD-Q2_K_XL" >> "$LOG" 2>&1

echo "=== ДОБОР: IQ2_XXS граница (8/8 на 131k, 0/8 на 196k в лестнице) ===" >> "$LOG"
bash tools/wait-studio.sh 900 >> "$LOG" 2>&1
bash tools/ladder-probe.sh "$REPO:UD-IQ2_XXS" 262144 >> "$LOG" 2>&1
env $VS LLM_DEADLINE_MS=2400000 CTX=262144 RUNGS="163840,196608" \
  OUT="results-EXP-qwen38q-udiq2xxs-cliff.json" node runners/run-multineedle.mjs "$REPO:UD-IQ2_XXS" >> "$LOG" 2>&1

echo "=== добор завершён ===" >> "$LOG"
