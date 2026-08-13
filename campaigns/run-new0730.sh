#!/usr/bin/env bash
# Batch `new0730` — новые ZDR-модели OpenRouter по запросу владельца ([[30.07.2026]]).
#
# Состав: Tencent Hy3, GPT-5.6 Sol, GPT-5.6 Luna, Kimi K3, GLM 5.2, Nex-N2-Pro.
# Kimi K2.6 участвует ТОЛЬКО в TypeScript-батарее: её строки в `RUST` и `humanitarian`
# уже есть в Google Sheet, а проверка дублей в gsheets_add_models.py регистрозависима
# (short() даёт `kimi-k2.6`, в таблице — `Kimi-K2.6`), поэтому повторный код-прогон
# создал бы вторую строку.
# KAT-Coder-Pro V2 не запускается: он уже протестирован во всех трёх вкладках, а его
# ZDR-эндпоинты сейчас отсутствуют (OpenRouter отдаёт 404 на data_collection=deny).
#
# Три батареи идут одновременно: общего состояния нет (разные OUT, эфемерные crate/проект
# каталоги через mkdtemp, независимые тулчейны cargo и bun/tsc), поэтому суммарное время
# равно самой медленной батарее, а не их сумме. Раннеры возобновляемые — повторный запуск
# догоняет только незавершённые единицы работы.
set -u
cd /code/work/llm-bench
export LLM_CLIENT=openrouter

NEW=(
  tencent/hy3
  openai/gpt-5.6-sol
  openai/gpt-5.6-luna
  moonshotai/kimi-k3
  z-ai/glm-5.2
  nex-agi/nex-n2-pro
)
TS_MODELS=( "${NEW[@]}" moonshotai/kimi-k2.6 )

echo "[new0730] start $(date '+%F %H:%M:%S')" >> results/new0730-orchestrate.log

OUT=results-new0730-rust.json      node runners/run-rust.mjs      "${NEW[@]}"       > results/new0730-rust.log      2>&1 &
P_RUST=$!
OUT=results-new0730-ts.json        node runners/run-ts.mjs        "${TS_MODELS[@]}" > results/new0730-ts.log        2>&1 &
P_TS=$!
OUT=results-new0730-knowledge.json node runners/run-knowledge.mjs "${NEW[@]}"       > results/new0730-knowledge.log 2>&1 &
P_KN=$!

wait $P_RUST; echo "[new0730] rust exit=$? $(date '+%H:%M:%S')"      >> results/new0730-orchestrate.log
wait $P_TS;   echo "[new0730] ts exit=$? $(date '+%H:%M:%S')"        >> results/new0730-orchestrate.log
wait $P_KN;   echo "[new0730] knowledge exit=$? $(date '+%H:%M:%S')" >> results/new0730-orchestrate.log
echo "[new0730] ALL_DONE $(date '+%F %H:%M:%S')" >> results/new0730-orchestrate.log
