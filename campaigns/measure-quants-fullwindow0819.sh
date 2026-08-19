#!/usr/bin/env bash
# Влезают ли старшие кванты в ПОЛНОЕ родное окно 262144 на голом сервере?
#
# Ночная лестница мерила каждый квант на его максимуме ПОД STUDIO (Q3 -> 229376, Q4 -> 81920),
# и разные окна сделали кванты несравнимыми. Теперь известно: пул сверх 262144 не нужен
# (кэш сессий держит оперативная память через --cache-ram), поэтому у старших квантов
# появляется бюджет видеопамяти, которого ночью не было.
# Меряем: поднимается ли квант на -c 262144, сколько ест видеопамяти и с какой скоростью.
set -u
BIN=/mnt/4tb/llm/unsloth-studio/llama.cpp/llama-server
HUB=/mnt/4tb/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots
PORT=8089
OUT=/tmp/quants-full-window.txt
: > "$OUT"
PROMPT='Write a detailed technical description of how a modern turbofan jet engine works, covering the fan, compressor, combustor and turbine stages.'

# ! Ждать РЕАЛЬНОГО освобождения карты, а не отправки сигнала: `kill` возвращается сразу, а
#   сервер, занятый длинной предобработкой, умирает не мгновенно. Один такой недожатый процесс
#   испортил целый прогон — цифры выглядели правдоподобно, но мерили две модели на одной карте.
wait_gpu_free() {
  for t in $(seq 1 60); do
    V=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits)
    [ "$V" -lt 500 ] && return 0
    sleep 5
  done
  echo "!! карта не освободилась: ${V} MiB" >> "$OUT"
  return 1
}

for Q in UD-IQ2_XXS UD-IQ2_M UD-Q2_K_XL UD-Q3_K_XL UD-Q4_K_XL; do
  M=$(ls "$HUB"/*/Qwen3.8-27B-"$Q".gguf 2>/dev/null | head -1)
  [ -n "$M" ] || { echo "=== $Q: файла нет ===" >> "$OUT"; continue; }
  SZ=$(du -Lh "$M" | cut -f1)   # -L: файлы в кэше HF — символические ссылки на blobs
  wait_gpu_free || break
  LOG="/tmp/qfw-$Q.log"
  nohup "$BIN" -m "$M" --host 127.0.0.1 --port "$PORT" -c 262144 \
    --cache-type-k q4_0 --cache-type-v q4_0 --flash-attn on --jinja -ngl -1 --kv-unified \
    --parallel 1 --spec-type draft-mtp --spec-draft-n-max 2 > "$LOG" 2>&1 &
  PID=$!
  OK=""
  for t in $(seq 1 90); do
    sleep 5
    curl -s -m 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q ok && { OK=yes; break; }
    kill -0 "$PID" 2>/dev/null || break
  done
  if [ -z "$OK" ]; then
    E=$(grep -aoiE "out of memory|failed to allocate|cudaMalloc failed|ggml_abort" "$LOG" | head -1)
    echo "=== $Q (вес $SZ): НЕ ПОДНЯЛСЯ на 262144 — ${E:-причина не распознана} ===" >> "$OUT"
    kill "$PID" 2>/dev/null; sleep 6; continue
  fi
  curl -s -m 600 "http://127.0.0.1:$PORT/completion" -H 'Content-Type: application/json' \
    -d "{\"prompt\":\"$PROMPT\",\"n_predict\":200,\"temperature\":0,\"cache_prompt\":false}" > /dev/null
  M0=$(wc -l < "$LOG")
  V=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader)
  U=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader)
  curl -s -m 600 "http://127.0.0.1:$PORT/completion" -H 'Content-Type: application/json' \
    -d "{\"prompt\":\"$PROMPT\",\"n_predict\":200,\"temperature\":0,\"cache_prompt\":false}" > /dev/null
  RSS=$(ps -o rss= -p "$PID" | tr -d ' ')
  echo "=== $Q (вес $SZ) | vram=$V | rss=$((RSS/1024)) MiB ===" >> "$OUT"
  tail -n "+$((M0+1))" "$LOG" | grep -aoE "eval time = *[0-9.]+ ms / *[0-9]+ tokens \([^)]*\)|draft acceptance = [0-9.]+" >> "$OUT"
  kill "$PID" 2>/dev/null
  sleep 8
done
echo "ЗАВЕРШЕНО" >> "$OUT"
