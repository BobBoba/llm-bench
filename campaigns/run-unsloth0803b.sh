#!/usr/bin/env bash
# Батареи для трёх новых локальных моделей на Unsloth Studio — [[03.08.2026]], группа `unsloth0803b`.
#
# ЧЕТЫРЕ ТОЧКИ ЗАМЕРА на трёх моделях (у Seed-OSS локально лежат два кванта):
#   Seed-OSS-36B-Instruct  UD-Q4_K_XL  ctx 32768    (веса 20.5 ГиБ)
#   Seed-OSS-36B-Instruct  UD-Q3_K_XL  ctx 32768    (веса 16.8 ГиБ)
#   Apriel-1.5-15b-Thinker UD-Q8_K_XL  ctx 98304    (веса 16.8 ГиБ)
#   gemma-4-31B-it-qat     UD-Q4_K_XL  ctx 262144   (веса 16.1 ГиБ)
#
# ПОЧЕМУ ОКНА РАЗНЫЕ. Цель была 262144 у всех — столько же, сколько у пары Qwen из прошлого
# прогона. Упирается в видеопамять: KV при 262144 и q4_0 составляет ~18 ГиБ у Seed-OSS и ~13.6 ГиБ
# у Apriel, что вместе с весами даёт 38 и 30 ГиБ против 24 ГиБ карты. У gemma иначе — скользящее
# окно внимания делает её KV на порядок дешевле (~6 ГиБ), поэтому 262144 она держит.
# Обе модели ПЛОТНЫЕ, не MoE: каждый вытесненный на CPU слой затрагивается на КАЖДОМ токене,
# поэтому offload здесь стоит кратно дороже, чем у MoE, где выгружается лишь часть экспертов.
# Решение владельца: 262144 там, где влезает, иначе максимум, при котором модель остаётся на карте.
#
# ОБА КВАНТА Seed-OSS ИДУТ НА ОДНОМ ОКНЕ 32768, и это не ограничение, а требование методики:
# переопределения Studio ключуются по РЕПОЗИТОРИЮ, а не по кванту, и при сравнении квантов окно
# обязано быть контрольной константой — иначе вклад кванта неотделим от вклада контекста.
#
# ФАКТИЧЕСКОЕ ОКНО КАЖДОЙ ТОЧКИ ПИШЕТСЯ В КОЛОНКУ CTX таблицы. Скорости между точками с разными
# окнами напрямую не сравнивать: у gemma на 262144 замерено 10.1 т/с против 94.8 т/с на 32768 —
# девятикратная разница объясняется offload'ом, а не моделью.
set -u
cd /code/work/llm-bench
export LLAMA_SERVER_BASE=http://192.168.89.53:8888/v1
export LLAMA_SERVER_KEY_FILE=/tmp/.unsloth

LOG=results/unsloth0803b-orchestrate.log
echo "[unsloth0803b] start $(date '+%F %H:%M:%S')" >> $LOG

# Батареи одной точки идут подряд: обращение к незагруженной модели заставляет Studio выгрузить
# текущую и загрузить нужную (~57 с), поэтому на точку приходится ровно одно переключение.
run_point() {
  local tag="$1" mid="$2"
  for battery in rust ts knowledge; do
    echo "[unsloth0803b] $tag/$battery $(date '+%H:%M:%S')" >> $LOG
    OUT=results-unsloth0803b-$tag-$battery.json \
      node runners/run-$battery.mjs "$mid" > results/unsloth0803b-$tag-$battery.log 2>&1
    echo "[unsloth0803b] $tag/$battery exit=$? $(date '+%H:%M:%S')" >> $LOG
  done
}

# Порядок начинается с уже загруженной Seed-OSS Q4 — экономит одно переключение.
run_point seedoss-q4 'unsloth/Seed-OSS-36B-Instruct-GGUF:UD-Q4_K_XL'
run_point seedoss-q3 'unsloth/Seed-OSS-36B-Instruct-GGUF:UD-Q3_K_XL'
run_point apriel     'unsloth/Apriel-1.5-15b-Thinker-GGUF:UD-Q8_K_XL'
run_point gemma31    'unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL'

echo "[unsloth0803b] ALL_DONE $(date '+%F %H:%M:%S')" >> $LOG
