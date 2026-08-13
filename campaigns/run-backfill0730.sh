#!/usr/bin/env bash
# Backfill `backfill0730` — дозаполнение колонки «время до решения» ([[30.07.2026]]).
#
# Зачем: у июньских облачных когорт (registry / candidate / add / fresh / new0616 / ref) в
# /code/src/zdr-*-bench сохранились только АГРЕГАТЫ (med_lat_s, доли пройденных тестов) без
# времени по каждой задаче, поэтому TTC из них не восстановить — нужен настоящий повторный прогон.
#
# Состав: 22 облачные модели, у которых на 30.07.2026 подтверждён ZDR-эндпоинт пробным запросом.
# prime-intellect/intellect-3 ИСКЛЮЧЕНА — модель удалена из каталога OpenRouter («No endpoints found»).
# TypeScript НЕ гоняется: эта вкладка уже заполнена на 68/68.
#
# Идентификаторы взяты не по догадке, а из самих июньских агрегатов (поля short/id), чтобы строка
# таблицы получила время ТОЙ ЖЕ модели, что измерялась в июне.
set -u
cd /code/work/llm-bench
export LLM_CLIENT=openrouter

MODELS=(
  z-ai/glm-4.7
  z-ai/glm-5
  z-ai/glm-5.1
  moonshotai/kimi-k2.5
  moonshotai/kimi-k2.6
  minimax/minimax-m2.5
  minimax/minimax-m2.7
  minimax/minimax-m3
  inclusionai/ring-2.6-1t
  nvidia/nemotron-3-super-120b-a12b
  nvidia/nemotron-3-ultra-550b-a55b
  meta-llama/llama-4-scout
  meta-llama/llama-4-maverick
  qwen/qwen3-235b-a22b-2507
  qwen/qwen3.5-122b-a10b
  qwen/qwen3-coder
  arcee-ai/trinity-large-thinking
  openai/gpt-oss-120b
  openai/gpt-oss-20b
  anthropic/claude-opus-4.8
  anthropic/claude-sonnet-4.6
  anthropic/claude-haiku-4.5
)

echo "[backfill0730] start $(date '+%F %H:%M:%S') — ${#MODELS[@]} моделей" >> results/backfill0730-orchestrate.log

OUT=results-backfill0730-rust.json      node runners/run-rust.mjs      "${MODELS[@]}" > results/backfill0730-rust.log      2>&1 &
P_RUST=$!
OUT=results-backfill0730-knowledge.json node runners/run-knowledge.mjs "${MODELS[@]}" > results/backfill0730-knowledge.log 2>&1 &
P_KN=$!

wait $P_RUST; echo "[backfill0730] rust exit=$? $(date '+%H:%M:%S')"      >> results/backfill0730-orchestrate.log
wait $P_KN;   echo "[backfill0730] knowledge exit=$? $(date '+%H:%M:%S')" >> results/backfill0730-orchestrate.log
echo "[backfill0730] ALL_DONE $(date '+%F %H:%M:%S')" >> results/backfill0730-orchestrate.log
