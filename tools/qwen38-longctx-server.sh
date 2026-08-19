#!/usr/bin/env bash
# Голый llama-server для Qwen3.8-27B на ПОЛНОМ родном окне 262144 — обход потолка прослойки.
#
# ЗАЧЕМ. Через Unsloth Studio длинный контекст ломается около ~190k: ответ приходит ПУСТОЙ при
# HTTP 200 (`finish: stop`), `usage.prompt_tokens` показывает ~68k вместо фактических ~194k,
# а иногда служба просто падает («peer closed connection»). Замерено ночью [[19.08.2026]] на
# четырёх квантах — картина одинаковая, то есть дело не в модели. Тот же промпт на голом
# сервере: recall 8/8 на 196k И на 229k, честный `promptTok` (193323 / 225501) и ВТРОЕ быстрее
# (55 и 87 с против 180+ через Studio).
#
# YaRN/--override-kv здесь НЕ нужны: у Qwen3.8 родное окно и есть 262144.
#
# Использование: QUANT=UD-Q2_K_XL KV_POOL=262144 qwen38-longctx-server.sh
#   QUANT   — UD-Q2_K_XL (умолчание; полное окно + лучший запас VRAM) | UD-Q3_K_XL | UD-IQ2_M
#   KV_POOL — ёмкость KV-пула; она же потолок запроса и объём кэша промптов.
# Перед запуском: выгрузить модель из Studio (запрос к unsloth/Qwen3-0.6B-GGUF) и `gui-off -y`.
set -u
QUANT="${QUANT:-UD-Q2_K_XL}"
KV_POOL="${KV_POOL:-262144}"
M=$(ls /mnt/4tb/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/*/Qwen3.8-27B-"$QUANT".gguf 2>/dev/null | head -1)
[ -n "$M" ] || { echo "квант $QUANT не найден в кэше HF"; exit 1; }
echo "модель: $M"
# --parallel 1: пул KV един для всех слотов, а одному пользователю с промптами под окно нужен
# весь пул в одном слоте (иначе кэши длинных промптов вытесняют друг друга).
# reasoning_effort=medium: дефолтный xhigh на тяжёлых задачах не сходится за бюджет.
exec /mnt/4tb/llm/unsloth-studio/llama.cpp/llama-server \
  -m "$M" \
  --host 0.0.0.0 --port 8080 \
  -c "$KV_POOL" \
  --cache-type-k q4_0 --cache-type-v q4_0 \
  --flash-attn on --jinja -ngl -1 --kv-unified --parallel 1 \
  --chat-template-kwargs '{"reasoning_effort":"medium"}'
