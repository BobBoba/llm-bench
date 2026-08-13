#!/usr/bin/env bash
# Batch `new0802` — новые модели по запросу владельца ([[02.08.2026]]).
#
# Из пяти запрошенных моделей прогоняется одна:
#   deepseek/deepseek-v4-flash-0731 — датированный снимок V4 Flash (добавлен в каталог 31.07.2026),
#     ZDR подтверждён пробным запросом (провайдер SiliconFlow). Это ОТДЕЛЬНАЯ модель от уже
#     присутствующих в таблице `deepseek-v4-flash` / `DS-V4-Flash`, поэтому конфликта имён нет.
#
# Остальные четыре не запускаются, причины разные:
#   openai/gpt-5.6-luna       — уже протестирована [[30.07.2026]] (группа `new0730`), все три вкладки.
#   qwen/qwen3.7-plus         — единственный провайдер Alibaba, ZDR-эндпоинта нет (404 на
#   qwen/qwen3.6-plus           data_collection=deny). Прогон потребовал бы отключить ZDR-политику.
#   agnes-2.5-pro-alpha       — отсутствует в OpenRouter, доступна только через первичный API
#                               Agnes AI (apihub.agnes-ai.com), нужен отдельный ключ и клиент.
#
# Три батареи параллельно: общего состояния нет (разные OUT, эфемерные каталоги, разные тулчейны).
set -u
cd /code/work/llm-bench
export LLM_CLIENT=openrouter

MODELS=(deepseek/deepseek-v4-flash-0731)

echo "[new0802] start $(date '+%F %H:%M:%S')" >> results/new0802-orchestrate.log

OUT=results-new0802-rust.json      node runners/run-rust.mjs      "${MODELS[@]}" > results/new0802-rust.log      2>&1 &
P1=$!
OUT=results-new0802-ts.json        node runners/run-ts.mjs        "${MODELS[@]}" > results/new0802-ts.log        2>&1 &
P2=$!
OUT=results-new0802-knowledge.json node runners/run-knowledge.mjs "${MODELS[@]}" > results/new0802-knowledge.log 2>&1 &
P3=$!

wait $P1; echo "[new0802] rust exit=$? $(date '+%H:%M:%S')"      >> results/new0802-orchestrate.log
wait $P2; echo "[new0802] ts exit=$? $(date '+%H:%M:%S')"        >> results/new0802-orchestrate.log
wait $P3; echo "[new0802] knowledge exit=$? $(date '+%H:%M:%S')" >> results/new0802-orchestrate.log
echo "[new0802] ALL_DONE $(date '+%F %H:%M:%S')" >> results/new0802-orchestrate.log
