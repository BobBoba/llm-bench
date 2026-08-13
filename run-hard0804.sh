#!/usr/bin/env bash
# Кампания hard0804 — ОБЛАЧНАЯ часть: 26 моделей со single_shot_% > 80 (вкладка RUST),
# 12 тяжёлых задач (3 языка × edit / edit-long / algo / conc), одношот, ZDR-маршрутизация.
#
# Отбор моделей: все строки RUST-вкладки с S% > 80, МИНУС 2 локальные (идут отдельным скриптом
# run-hard0804-local.sh через Unsloth Studio) и 4 эталонные Claude по подписке (не кандидаты
# в «рабочую лошадь» — они уже основной инструмент, кампания ищет им замену на каждый день).
#
# ПЯТЬ ПАРАЛЛЕЛЬНЫХ ГРУПП: внутри группы модели идут последовательно, группы — одновременно.
# Медленные рассуждающие модели (grok, gemini-pro, gpt-5.6) разложены по РАЗНЫМ группам,
# чтобы ни одна группа не стала хвостом кампании.
#
# Каждая группа пишет СВОЙ файл результатов (crash-safe, резюмируемый по ключу
# model|lang|task|run) — повторный запуск скрипта доделает только недостающее.
set -u
cd /code/work/llm-bench
export LLM_CLIENT=openrouter
# Ключ уже должен лежать в /tmp/.orkey (secret-tool lookup Title "OpenRouter API key").
[ -s /tmp/.orkey ] || { echo "нет /tmp/.orkey — положите ключ OpenRouter"; exit 1; }

run_group() {  # $1 = имя группы, $2.. = модели
  local g="$1"; shift
  OUT="results-hard0804-$g.json" node run-hard.mjs "$@" > "results/hard0804-$g.log" 2>&1
  echo "группа $g завершена ($?)"
}

# kat-coder-pro-v2 исключена [[04.08.2026]]: у неё исчез эндпоинт под data_collection:deny
# (404 «No endpoints available matching your data policy») — не бенчмаркуется в рамках нашей
# приватной политики. Это находка о маршрутизации, а не о модели.
run_group g1 openai/gpt-5.6-sol       moonshotai/kimi-k3          deepseek/deepseek-v3.2      z-ai/glm-5      bytedance-seed/seed-2.0-mini &
run_group g2 openai/gpt-5.6-luna      google/gemini-3.1-flash-lite moonshotai/kimi-k2-0905     deepseek/deepseek-v4-pro    z-ai/glm-5.1 &
run_group g3 google/gemini-3.1-pro-preview openai/gpt-5.3-codex    moonshotai/kimi-k2.6        deepseek/deepseek-v4-flash  nex-agi/nex-n2-pro &
run_group g4 x-ai/grok-4.3            openai/gpt-5.2-codex        google/gemini-3.1-flash-lite-preview z-ai/glm-5.2       inclusionai/ring-2.6-1t &
run_group g5 x-ai/grok-4.20           openai/gpt-5.4-mini         x-ai/grok-4.20-multi-agent  tencent/hy3                 xiaomi/mimo-v2.5-pro &

wait
echo "hard0804 cloud: все группы завершены"
