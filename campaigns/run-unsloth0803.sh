#!/usr/bin/env bash
# Батареи для локальных моделей на Unsloth Studio (GPU-стенд) — [[03.08.2026]], группа `unsloth0803`.
#
# Эндпоинт: http://192.168.89.53:8888/v1, OpenAI-совместимый, ТРЕБУЕТ Bearer-ключ (без него 401).
# Ключ читается клиентом из файла (LMSTUDIO_KEY_FILE), в конфиги и логи не попадает.
#
# Квант закрепляется СУФФИКСОМ в идентификаторе (`repo:VARIANT`) — отдельной настройки «закрепить
# квант» в Studio нет ни в UI, ни в overrides, а без суффикса берётся variants[0], порядок которого
# не совпадает с тем, что показывает API. См. [[qwen-quants-256k-benchmark-2026-08]].
#
# ПОЧЕМУ ПОСЛЕДОВАТЕЛЬНО, а не тремя батареями сразу, как в облаке:
#   1) GPU одна. Studio держит 3–4 слота, то есть параллельные запросы физически возможны, но они
#      делят одну карту — медианная задержка и tok/s тогда отражали бы конкуренцию за неё, а не
#      модель, и стали бы несопоставимы с остальными строками таблицы, снятыми последовательно.
#   2) Обе модели одного провайдера: обращение к незагруженной модели заставляет Studio выгрузить
#      текущую и загрузить нужную (~57 с). Поэтому все батареи одной модели идут подряд — на весь
#      прогон приходится ровно одно переключение.
set -u
cd /code/work/llm-bench
export LMSTUDIO_BASE=http://192.168.89.53:8888/v1
export LMSTUDIO_KEY_FILE=/tmp/.unsloth
# LLM_CLIENT не выставляем: по умолчанию раннеры берут llama-server-client.mjs (OpenAI-совместимый).

AW='unsloth/Qwen-AgentWorld-35B-A3B-GGUF:UD-Q3_K_XL'
QCN='unsloth/Qwen3-Coder-Next-GGUF:UD-Q4_K_M'
LOG=results/unsloth0803-orchestrate.log

echo "[unsloth0803] start $(date '+%F %H:%M:%S')" >> $LOG

# --- AgentWorld загружена последней смоук-тестом, начинаем с неё: экономим одно переключение
for battery in rust ts knowledge; do
  echo "[unsloth0803] agentworld/$battery $(date '+%H:%M:%S')" >> $LOG
  OUT=results-unsloth0803-agentworld-$battery.json \
    node runners/run-$battery.mjs "$AW" > results/unsloth0803-agentworld-$battery.log 2>&1
  echo "[unsloth0803] agentworld/$battery exit=$? $(date '+%H:%M:%S')" >> $LOG
done

# --- переключение на 80B (одно на весь прогон)
for battery in rust ts knowledge; do
  echo "[unsloth0803] qwen3-coder-next/$battery $(date '+%H:%M:%S')" >> $LOG
  OUT=results-unsloth0803-qcn-$battery.json \
    node runners/run-$battery.mjs "$QCN" > results/unsloth0803-qcn-$battery.log 2>&1
  echo "[unsloth0803] qwen3-coder-next/$battery exit=$? $(date '+%H:%M:%S')" >> $LOG
done

echo "[unsloth0803] ALL_DONE $(date '+%F %H:%M:%S')" >> $LOG
