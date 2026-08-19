#!/usr/bin/env bash
# Чем кончается столкновение двух длинных сессий за общий KV-пул при --parallel 2 --kv-unified?
#
# ЗАЧЕМ. Второй слот дёшев (+448 МиБ) и не режет окно, но пул общий: сумма двух длинных
# контекстов может превысить ёмкость. Вопрос не «случится ли», а «как именно»: запрос упадёт
# (тогда --parallel 2 опасен для длинной агентной работы), встанет в очередь (тогда безопасен)
# или вытеснит чужой кэш (тогда безопасен, но с потерей скорости).
#
# МАСШТАБИРОВАННАЯ МОДЕЛЬ: окно 65536 и два промпта по ~40k токенов вместо 262144 и 150k —
# условие столкновения то же (сумма промптов больше пула), а стоит вчетверо дешевле.
set -u
BIN=/mnt/4tb/llm/unsloth-studio/llama.cpp/llama-server
M=$(ls /mnt/4tb/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/*/Qwen3.8-27B-UD-Q3_K_XL.gguf | head -1)
PORT=8090
OUT=/tmp/slot-collision.txt
: > "$OUT"

python3 - <<'PY'
import json, random
def make(seed, n):
    r = random.Random(seed)
    w = ["ledger","turbine","harbor","quartz","meadow","cipher","anvil","lantern","glacier","pylon",
         "marrow","fathom","bramble","zenith","kiln","verdict","sable","thicket","onyx","furrow"]
    return " ".join(f"Record {seed}-{i}: the {r.choice(w)} {r.choice(w)} measured {r.randint(1000,9999)} units."
                    for i in range(n))
# замер: ~22 токена на предложение -> 1800 предложений ≈ 40k токенов
for name, seed in (("A", 11), ("B", 97)):
    json.dump({"prompt": make(seed, 1800), "n_predict": 32, "temperature": 0, "cache_prompt": True},
              open(f"/tmp/sc-{name}.json", "w"))
PY

for t in $(seq 1 60); do
  V=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits)
  N=$(ps -eo args | grep -c "[l]lama-server")
  [ "$V" -lt 500 ] && [ "$N" -eq 0 ] && break
  sleep 5
done

LOG=/tmp/sc-server.log
nohup "$BIN" -m "$M" --host 127.0.0.1 --port "$PORT" -c 65536 \
  --cache-type-k q4_0 --cache-type-v q4_0 --flash-attn on --jinja -ngl -1 \
  --parallel 2 --kv-unified --spec-type draft-mtp --spec-draft-n-max 2 > "$LOG" 2>&1 &
PID=$!
OK=""
for t in $(seq 1 90); do
  sleep 5
  curl -s -m 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q ok && { OK=yes; break; }
  kill -0 "$PID" 2>/dev/null || break
done
[ -n "$OK" ] || { echo "НЕ ПОДНЯЛСЯ" >> "$OUT"; exit 1; }
echo "слоты: $(grep -aoE "n_slots = [0-9]+, n_ctx_slot = [0-9]+" "$LOG" | head -1)" >> "$OUT"

S=$(date +%s)
curl -s -m 900 -o /tmp/sc-out-A.json -w "A: код=%{http_code} время=%{time_total}с\n" \
  "http://127.0.0.1:$PORT/completion" -H 'Content-Type: application/json' --data-binary "@/tmp/sc-A.json" >> "$OUT" &
J1=$!
curl -s -m 900 -o /tmp/sc-out-B.json -w "B: код=%{http_code} время=%{time_total}с\n" \
  "http://127.0.0.1:$PORT/completion" -H 'Content-Type: application/json' --data-binary "@/tmp/sc-B.json" >> "$OUT" &
J2=$!
wait "$J1" "$J2"
echo "общая стенка: $(( $(date +%s) - S )) с" >> "$OUT"

for X in A B; do
  echo "-- ответ $X: $(python3 -c "
import json
d=json.load(open('/tmp/sc-out-$X.json'))
print('токенов промпта', d.get('tokens_evaluated'), '| сгенерировано', d.get('tokens_predicted'), '| причина', d.get('stop_type') or d.get('stopped_eos'), '| ошибка:', d.get('error','нет'))
" 2>&1 | head -2)" >> "$OUT"
done
echo "-- признаки нехватки ячеек в журнале:" >> "$OUT"
grep -aiE "failed to find|available cells|slot is not available|kv cache is full|erase|shift" "$LOG" | tail -6 >> "$OUT"
kill "$PID" 2>/dev/null
echo "ЗАВЕРШЕНО" >> "$OUT"
