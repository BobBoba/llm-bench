#!/usr/bin/env bash
# Local backfill `local0730` — дозаполнение колонки «время до решения» для ЛОКАЛЬНЫХ строк ([[30.07.2026]]).
#
# Почему нельзя прогнать эти модели через облако: строка таблицы описывает ЛОКАЛЬНЫЙ прогон на
# конкретном железе (gaming-pc, RTX 3090). Время облачного инстанса той же модели — другая
# величина, и подстановка её в локальную строку молча исказила бы смысл строки.
#
# Доступ к LM Studio: сервер на стенде живёт ровно на время SSH-сессии из scratchpad/lms-tunnel.sh
# и проброшен на 127.0.0.1:11234. Наружу порт не открывается, на стенде ничего не остаётся.
#
# Батареи идут ПОСЛЕДОВАТЕЛЬНО: GPU одна, при параллельном запуске LM Studio начнёт своппить веса
# и замеры времени станут бессмысленными (в этом же причина последовательности в orchestrate.sh).
# TypeScript не гоняется — вкладка уже заполнена целиком.
set -u
cd /code/work/llm-bench
export LLAMA_SERVER_BASE=http://127.0.0.1:11234/v1     # клиент по умолчанию смотрит на gaming-pc.lan:1234

MODELS=(
  zai-org/glm-4.7-flash
  mistralai/ministral-3-14b-reasoning
  nvidia/nemotron-3-nano
  openai/gpt-oss-20b
  qwen/qwen3-30b-a3b-2507
  qwen/qwen3-coder-30b
  qwen/qwen3.6-27b
  qwen3.6-35b-a3b-uncensored-heretic-native-mtp-preserved-nvfp4-experts-only
)

echo "[local0730] start $(date '+%F %H:%M:%S') — ${#MODELS[@]} моделей" >> results/local0730-orchestrate.log

OUT=results-local0730-rust.json node runners/run-rust.mjs "${MODELS[@]}" > results/local0730-rust.log 2>&1
echo "[local0730] rust exit=$? $(date '+%H:%M:%S')" >> results/local0730-orchestrate.log

OUT=results-local0730-knowledge.json node runners/run-knowledge.mjs "${MODELS[@]}" > results/local0730-knowledge.log 2>&1
echo "[local0730] knowledge exit=$? $(date '+%H:%M:%S')" >> results/local0730-orchestrate.log

echo "[local0730] ALL_DONE $(date '+%F %H:%M:%S')" >> results/local0730-orchestrate.log
