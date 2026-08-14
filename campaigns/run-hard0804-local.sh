#!/usr/bin/env bash
# Кампания hard0804 — ЛОКАЛЬНАЯ часть: два кванта Qwen3-Coder-Next через Unsloth Studio
# на GPU-стенде (192.168.89.53:8888). Строго ПОСЛЕДОВАТЕЛЬНО: сервер один, горячая смена
# кванта ~57 с выполняется самим Studio по идентификатору `репозиторий:КВАНТ`.
#
# Именно здесь ответ на главный вопрос кампании про длинный контекст: у обеих точек окно
# 262144 (переопределение Studio ключуется по репозиторию и уже стоит с кампании квантов
# [[02.08.2026]], KV q4_0), и edit-long (~63k токенов prefill) покажет, сколько локальная
# модель платит за длинный контекст там, где облако укладывается в секунды.
set -u
cd /code/work/llm-bench
export LLAMA_SERVER_BASE=http://192.168.89.53:8888/v1
export LLAMA_SERVER_KEY_FILE=/tmp/.unsloth
[ -s /tmp/.unsloth ] || { echo "нет /tmp/.unsloth — положите ключ Unsloth Studio"; exit 1; }

OUT="results-hard0804-local.json" node runners/run-hard.mjs \
  "unsloth/Qwen3-Coder-Next-GGUF:UD-Q4_K_M" \
  "unsloth/Qwen3-Coder-Next-GGUF:Q4_K_M" \
  > results/hard0804-local.log 2>&1
echo "hard0804 local: завершено ($?)"
