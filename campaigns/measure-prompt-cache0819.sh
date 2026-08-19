#!/usr/bin/env bash
# Сколько промптов слот держит в кэше: один последний или несколько, пока хватает пула?
#
# От ответа зависит смысл всего пула сверх родного окна. Ночью записано «пул 524288 = два
# полноразмерных контекста в горячем кэше»; если кэш хранит только ПОСЛЕДНИЙ промпт, это
# неверно и пул сверх окна не нужен вовсе.
#
# Дешёвая и решающая постановка: промпты по ~20k токенов, последовательность A -> B -> A.
#   -c 131072: пул вмещает оба промпта с большим запасом. Переиспользовался ли A на третьем шаге?
#   -c 32768:  контроль, тот же запас относительно промптов.
# Если повторный A пересчитывается ЦЕЛИКОМ на обеих ёмкостях — кэш строго однопромптовый,
# и увеличение пула не покупает ни одной дополнительной сессии.
set -u
BIN=/mnt/4tb/llm/unsloth-studio/llama.cpp/llama-server
M=$(ls /mnt/4tb/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/*/Qwen3.8-27B-UD-IQ2_XXS.gguf | head -1)
PORT=8088
OUT=/tmp/cache-mechanism.txt
: > "$OUT"

python3 - <<'PY'
import json, random
def make(seed, n):
    r = random.Random(seed)
    w = ["ledger","turbine","harbor","quartz","meadow","cipher","anvil","lantern","glacier","pylon",
         "marrow","fathom","bramble","zenith","kiln","verdict","sable","thicket","onyx","furrow"]
    return " ".join(f"Record {seed}-{i}: the {r.choice(w)} {r.choice(w)} measured {r.randint(1000,9999)} units."
                    for i in range(n))
# замер прошлого прогона: 11000 предложений = 240785 токенов, то есть ~22 токена на предложение
for name, seed in (("A", 11), ("B", 97)):
    body = {"prompt": make(seed, 900), "n_predict": 8, "temperature": 0, "cache_prompt": True}
    json.dump(body, open(f"/tmp/cm-{name}.json", "w"))
PY

for C in 32768 131072; do
  LOG="/tmp/cm-$C.log"
  nohup "$BIN" -m "$M" --host 127.0.0.1 --port "$PORT" -c "$C" \
    --cache-type-k q4_0 --cache-type-v q4_0 --flash-attn on --jinja -ngl -1 --kv-unified \
    --parallel 1 --spec-type draft-mtp --spec-draft-n-max 2 > "$LOG" 2>&1 &
  PID=$!
  OK=""
  for t in $(seq 1 60); do
    sleep 5
    curl -s -m 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q ok && { OK=yes; break; }
    kill -0 "$PID" 2>/dev/null || break
  done
  [ -n "$OK" ] || { echo "=== -c $C НЕ ПОДНЯЛСЯ ===" >> "$OUT"; kill "$PID" 2>/dev/null; sleep 5; continue; }
  echo "=== -c $C ===" >> "$OUT"
  for STEP in A B A; do
    M0=$(wc -l < "$LOG")
    S=$(date +%s)
    curl -s -m 900 "http://127.0.0.1:$PORT/completion" -H 'Content-Type: application/json' \
      --data-binary "@/tmp/cm-$STEP.json" > /dev/null
    E=$(date +%s)
    T=$(tail -n "+$((M0+1))" "$LOG" | grep -aoE "prompt eval time = *[0-9.]+ ms / *[0-9]+ tokens" | head -1)
    # строка о переиспользовании префикса — прямое свидетельство попадания в кэш
    K=$(tail -n "+$((M0+1))" "$LOG" | grep -aoE "n_past = [0-9]+|n_prompt_tokens_processed = [0-9]+|reus[a-z]* [0-9]+ [a-z]+" | head -3 | tr '\n' ' ')
    echo "  $STEP: ${T:-нет строки prompt eval (промпт взят из кэша целиком)} | стенка $((E-S)) с | $K" >> "$OUT"
  done
  kill "$PID" 2>/dev/null
  sleep 8
done
echo "ЗАВЕРШЕНО" >> "$OUT"
