#!/usr/bin/env bash
# Лаунчер 80B Qwen3-Coder-Next на 5090: квант выбирается переменной, всё остальное — по замерам.
# Q2_K_XL помещается на карту ЦЕЛИКОМ (RSS 1.6 ГиБ = на процессоре ничего) и даёт 217 т/с при
# полном окне 262144. Старшие кванты не помещаются, эксперты уезжают в ОЗУ (Q3 — 35 ГиБ,
# Q4 — 47 ГиБ) и скорость падает до 139 и 90 т/с соответственно.
set -u
QUANT="${QUANT:-UD-Q2_K_XL}"
KV="${KV:-q4_0}"
CTX="${CTX:-262144}"
PARALLEL="${PARALLEL:-2}"
M="/models/Qwen3-Coder-Next-$QUANT.gguf"
[ -f "$M" ] || { echo "нет файла $M"; exit 1; }
echo "модель: $M | KV: $KV | окно: $CTX | слотов: $PARALLEL"
exec /opt/bin/llama-server -m "$M" --host 127.0.0.1 --port 8099 --api-key "$(cat /root/.apikey)" \
  -c "$CTX" --cache-type-k "$KV" --cache-type-v "$KV" \
  --flash-attn on --jinja -ngl -1 --kv-unified --parallel "$PARALLEL"
