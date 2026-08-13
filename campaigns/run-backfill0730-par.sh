#!/usr/bin/env bash
# Ускоренный остаток `backfill0730` — 20 облачных моделей пятью параллельными раннерами.
#
# Почему можно распараллеливать: в отличие от локальных прогонов (одна GPU, LM Studio своппит веса),
# облачные модели исполняются на стороне провайдера и между собой ничем не делятся. Единственное
# общее — файл результатов, поэтому у каждой группы СВОЙ OUT; агрегатор (gsheets_add_ttc_column.py)
# читает все results-*.json и склеивает их по ключу model|mode|task|run.
# Последовательный прогон давал ~50 минут на модель (тяжёлые reasoning-модели тратят до 570 с на
# один агентный цикл) — на 22 модели это сутки. Пять групп сокращают до нескольких часов.
#
# Раннеры возобновляемые: уже посчитанные единицы из results-backfill0730-rust.json не
# пересчитываются, если модель попадает в ту же группу.
set -u
cd /code/work/llm-bench
export LLM_CLIENT=openrouter

G1=(z-ai/glm-5.1 minimax/minimax-m3 meta-llama/llama-4-maverick openai/gpt-oss-120b)
G2=(moonshotai/kimi-k2.5 inclusionai/ring-2.6-1t qwen/qwen3-235b-a22b-2507 openai/gpt-oss-20b)
G3=(moonshotai/kimi-k2.6 nvidia/nemotron-3-super-120b-a12b qwen/qwen3.5-122b-a10b anthropic/claude-opus-4.8)
G4=(minimax/minimax-m2.5 nvidia/nemotron-3-ultra-550b-a55b qwen/qwen3-coder anthropic/claude-sonnet-4.6)
G5=(minimax/minimax-m2.7 meta-llama/llama-4-scout arcee-ai/trinity-large-thinking anthropic/claude-haiku-4.5)

echo "[par] start $(date '+%F %H:%M:%S')" >> results/backfill0730-orchestrate.log

OUT=results-backfill0730-rust-g1.json node runners/run-rust.mjs "${G1[@]}" > results/backfill0730-rust-g1.log 2>&1 &
OUT=results-backfill0730-rust-g2.json node runners/run-rust.mjs "${G2[@]}" > results/backfill0730-rust-g2.log 2>&1 &
OUT=results-backfill0730-rust-g3.json node runners/run-rust.mjs "${G3[@]}" > results/backfill0730-rust-g3.log 2>&1 &
OUT=results-backfill0730-rust-g4.json node runners/run-rust.mjs "${G4[@]}" > results/backfill0730-rust-g4.log 2>&1 &
OUT=results-backfill0730-rust-g5.json node runners/run-rust.mjs "${G5[@]}" > results/backfill0730-rust-g5.log 2>&1 &
wait
echo "[par] ALL_DONE $(date '+%F %H:%M:%S')" >> results/backfill0730-orchestrate.log
