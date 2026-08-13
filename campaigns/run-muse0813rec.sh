#!/usr/bin/env bash
# Кампания muse0813rec [[13.08.2026]] — стандартные батареи Muse-Glimmer на РЕКОМЕНДОВАННЫХ
# настройках Meta (temperature=1.0, top_p=0.95, top_k=64; unsloth.ai/docs/models/muse-glimmer).
# Дополнение к muse0813: hard-набор на этих настройках уже прогнан (19/22 против 16/22 при
# контрольной t=0.2), теперь та же пара строк появляется и на стандартных вкладках.
# Идентификатор с суффиксом кванта разводит записи с контрольной строкой.
set -u
cd "$(dirname "$0")/.."
export LMSTUDIO_BASE=http://gaming-pc.lan:8888/v1
export LMSTUDIO_KEY_FILE=/tmp/.unsloth-gp
[ -s /tmp/.unsloth-gp ] || secret-tool lookup service unsloth-studio host gaming-pc purpose api-key > /tmp/.unsloth-gp
export LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=64

M="unsloth/Muse-Glimmer-30B-GGUF:UD-Q4_K_XL"
LOG=results/muse0813rec.log
: > "$LOG"

OUT=results-muse0813rec-rust.json      node runners/run-rust.mjs      "$M" >> "$LOG" 2>&1
OUT=results-muse0813rec-ts.json        node runners/run-ts.mjs        "$M" >> "$LOG" 2>&1
OUT=results-muse0813rec-knowledge.json node runners/run-knowledge.mjs "$M" >> "$LOG" 2>&1
echo "=== muse0813rec: батареи завершены ===" >> "$LOG"
