#!/usr/bin/env bash
# Кампания qwen38-0814 [[14.08.2026]] — интенсивный бенч свежевышедшей Qwen3.8-27B UD-Q4_K_XL
# (все батареи, поручение владельца). Плотная 27B семейства qwen35, vision + MTP, родное окно
# 262144, гибридное мышление.
#
# КОНФИГУРАЦИЯ (отпечатки размещения — в NOTES-ru.md):
#   окно 32768, KV q4_0, полный VRAM, GUI погашен -> 66.5 т/с;
#   на родных 262144 KV 10.9 ГБ выталкивает слои (selected: None) -> 14.5 т/с — не конфигурация
#   для замера; edit-long на 32k отваливается быстрым 400 — честный результат «длинный контекст
#   на этой карте недоступен» (прецеденты Seed-OSS, Qwen3.6-27B).
#   ! Суффиксный override из UI (repo:UD-Q4_K_XL, 262144) имел приоритет над репозиторным —
#   менять надо ЕГО (первая перезагрузка взяла старое окно, скорость была 15 т/с).
#
# ПАРА СЭМПЛИНГОВ (прецедент Muse-Glimmer):
#   контроль t=0.2 — сопоставимость со всеми строками таблицы (id = repo);
#   рекомендованные Qwen для thinking-режима: t=1.0, top_p=0.95, top_k=20 (id = repo:QUANT).
set -u
cd "$(dirname "$0")/.."
export LLAMA_SERVER_BASE=http://gaming-pc.lan:8888/v1
export LLAMA_SERVER_KEY_FILE=/tmp/.unsloth-gp
[ -s /tmp/.unsloth-gp ] || secret-tool lookup service unsloth-studio host gaming-pc purpose api-key > /tmp/.unsloth-gp

REPO="unsloth/Qwen3.8-27B-GGUF"
REC="unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL"
LOG=results/qwen38-0814.log
: > "$LOG"

echo "=== ФАЗА 1: hard, контроль t=0.2 ===" >> "$LOG"
MAX_TOKENS=40000 LLM_DEADLINE_MS=2400000 \
OUT=results-hard-qwen38.json node runners/run-hard.mjs "$REPO" >> "$LOG" 2>&1

echo "=== ФАЗА 2: hard, рекомендованные (t=1.0 p=0.95 k=20) ===" >> "$LOG"
LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20 \
MAX_TOKENS=40000 LLM_DEADLINE_MS=2400000 \
OUT=results-hard-qwen38-rec.json node runners/run-hard.mjs "$REC" >> "$LOG" 2>&1

echo "=== ФАЗА 3: стандартные батареи, контроль t=0.2 ===" >> "$LOG"
OUT=results-qwen38-rust.json      node runners/run-rust.mjs      "$REPO" >> "$LOG" 2>&1
OUT=results-qwen38-ts.json        node runners/run-ts.mjs        "$REPO" >> "$LOG" 2>&1
OUT=results-qwen38-knowledge.json node runners/run-knowledge.mjs "$REPO" >> "$LOG" 2>&1

echo "=== ФАЗА 4: стандартные батареи, рекомендованные ===" >> "$LOG"
LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20 \
OUT=results-qwen38rec-rust.json      node runners/run-rust.mjs      "$REC" >> "$LOG" 2>&1
LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20 \
OUT=results-qwen38rec-ts.json        node runners/run-ts.mjs        "$REC" >> "$LOG" 2>&1
LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20 \
OUT=results-qwen38rec-knowledge.json node runners/run-knowledge.mjs "$REC" >> "$LOG" 2>&1

echo "=== ФАЗА 5: tool-use (контроль) ===" >> "$LOG"
OUT=results-qwen38-tooluse.json      node runners/run-tooluse.mjs      "$REPO" >> "$LOG" 2>&1
OUT=results-qwen38-tooluse-hard.json node runners/run-tooluse-hard.mjs "$REPO" >> "$LOG" 2>&1

echo "=== qwen38-0814: все фазы завершены ===" >> "$LOG"
# Возврат рабочего стола владельцу — независимо от исхода фаз (правило playbook).
ssh gaming-pc gui-on >> "$LOG" 2>&1 || true
