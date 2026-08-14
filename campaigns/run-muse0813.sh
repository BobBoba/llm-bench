#!/usr/bin/env bash
# Кампания muse0813 [[13.08.2026]] — доисследование Muse-Glimmer-30B по четырём вопросам владельца:
#   1) DFlash: ночной прогон УЖЕ шёл с драфтером (--spec-type draft-dflash), но --spec-draft-n-max 2;
#   2) кванты: мерился только UD-Q4_K_XL — добавляем UD-Q6_K_XL (потолок 24-ГиБ карты);
#   3) рекомендованные настройки (temperature 1.0, top_p 0.95, top_k 64) — ОТДЕЛЬНОЙ строкой
#      «repo:UD-Q4_K_XL», основная строка таблицы остаётся на контрольной temperature 0.2;
#   4) старые батареи (Rust / TypeScript / knowledge) — не гонялись, закрываем.
#
# Строго последовательно: сервер один. Бюджеты hard-фазы повторяют основную строку
# (MAX_TOKENS=30000, дедлайн 40 мин) — меняется ТОЛЬКО сэмплинг, сравнение контролируемое.
set -u
cd "$(dirname "$0")/.."
export LLAMA_SERVER_BASE=http://gaming-pc.lan:8888/v1
export LLAMA_SERVER_KEY_FILE=/tmp/.unsloth-gp
[ -s /tmp/.unsloth-gp ] || secret-tool lookup service unsloth-studio host gaming-pc purpose api-key > /tmp/.unsloth-gp

M="unsloth/Muse-Glimmer-30B-GGUF"
LOG=results/muse0813.log
: > "$LOG"

echo "=== ФАЗА 1: стандартные батареи (temp 0.2, сопоставимо со старыми вкладками) ===" >> "$LOG"
OUT=results-muse0813-rust.json      node runners/run-rust.mjs      "$M" >> "$LOG" 2>&1
OUT=results-muse0813-ts.json        node runners/run-ts.mjs        "$M" >> "$LOG" 2>&1
OUT=results-muse0813-knowledge.json node runners/run-knowledge.mjs "$M" >> "$LOG" 2>&1

echo "=== ФАЗА 2: hard на рекомендованных настройках Meta (t=1.0 p=0.95 k=64) ===" >> "$LOG"
LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=64 \
MAX_TOKENS=30000 LLM_DEADLINE_MS=2400000 \
OUT=results-hard-muse-recommended.json node runners/run-hard.mjs "$M:UD-Q4_K_XL" >> "$LOG" 2>&1

echo "=== muse0813: фазы 1-2 завершены ===" >> "$LOG"
