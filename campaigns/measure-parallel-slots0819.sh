#!/usr/bin/env bash
# Что даёт --parallel 2 на Qwen3.8-27B UD-Q3_K_XL @ -c 262144?
#
# ТРИ ВОПРОСА, на которые нужен ответ цифрами:
#  1. Режется ли окно слота вдвое? (гипотеза: без --kv-unified режется, с ним — нет)
#  2. Сколько стоит второй слот по видеопамяти? (важно: Q3 уже занимает 20.4 из 24 ГиБ)
#  3. Даёт ли второй слот реальную пропускную способность при ДВУХ одновременных запросах,
#     или они просто делят одну и ту же скорость?
# Третий вопрос главный: если суммарная скорость двух параллельных запросов не выше скорости
# одного, второй слот бесполезен — видеокарта и так загружена на 95% одним потоком.
set -u
BIN=/mnt/4tb/llm/unsloth-studio/llama.cpp/llama-server
M=$(ls /mnt/4tb/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/*/Qwen3.8-27B-UD-Q3_K_XL.gguf | head -1)
PORT=8090
OUT=/tmp/parallel-slots.txt
: > "$OUT"
P='Write a detailed technical description of how a modern turbofan jet engine works, covering the fan, compressor, combustor and turbine stages.'

wait_gpu_free() {
  for t in $(seq 1 60); do
    V=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits)
    N=$(ps -eo args | grep -c "[l]lama-server")
    [ "$V" -lt 500 ] && [ "$N" -eq 0 ] && return 0
    sleep 5
  done
  echo "!! карта не освободилась: ${V} MiB, серверов $N" >> "$OUT"; return 1
}

run() {
  local LABEL="$1" NPAR="$2" KVU="$3"
  wait_gpu_free || return
  local LOG="/tmp/ps-$LABEL.log"
  nohup "$BIN" -m "$M" --host 127.0.0.1 --port "$PORT" -c 262144 \
    --cache-type-k q4_0 --cache-type-v q4_0 --flash-attn on --jinja -ngl -1 \
    --parallel "$NPAR" $KVU --spec-type draft-mtp --spec-draft-n-max 2 > "$LOG" 2>&1 &
  local PID=$!
  local OK=""
  for t in $(seq 1 90); do
    sleep 5
    curl -s -m 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q ok && { OK=yes; break; }
    kill -0 "$PID" 2>/dev/null || break
  done
  [ -n "$OK" ] || { echo "=== $LABEL: НЕ ПОДНЯЛСЯ ===" >> "$OUT"; kill "$PID" 2>/dev/null; sleep 6; return; }
  local V=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader)
  local SLOTS=$(grep -aoE "n_slots = [0-9]+, n_ctx_slot = [0-9]+" "$LOG" | head -1)
  echo "=== $LABEL (--parallel $NPAR $KVU) | vram=$V | $SLOTS ===" >> "$OUT"

  # прогрев
  curl -s -m 600 "http://127.0.0.1:$PORT/completion" -H 'Content-Type: application/json' \
    -d "{\"prompt\":\"$P\",\"n_predict\":100,\"temperature\":0,\"cache_prompt\":false}" > /dev/null

  # ОДИН запрос
  local M0=$(wc -l < "$LOG")
  local S=$(date +%s%N)
  curl -s -m 600 "http://127.0.0.1:$PORT/completion" -H 'Content-Type: application/json' \
    -d "{\"prompt\":\"$P\",\"n_predict\":200,\"temperature\":0,\"cache_prompt\":false}" > /dev/null
  local E=$(date +%s%N)
  echo "  один запрос: стенка $(( (E-S)/1000000 )) мс | $(tail -n "+$((M0+1))" "$LOG" | grep -aoE "eval time = *[0-9.]+ ms / *200 tokens \([^)]*\)" | head -1)" >> "$OUT"

  # ДВА одновременных запроса: промпты РАЗНЫЕ, иначе кэш промптов отдаст второй мгновенно
  M0=$(wc -l < "$LOG")
  S=$(date +%s%N)
  curl -s -m 600 "http://127.0.0.1:$PORT/completion" -H 'Content-Type: application/json' \
    -d "{\"prompt\":\"$P Explain also the bypass ratio.\",\"n_predict\":200,\"temperature\":0,\"cache_prompt\":false}" > /dev/null &
  local J1=$!
  curl -s -m 600 "http://127.0.0.1:$PORT/completion" -H 'Content-Type: application/json' \
    -d "{\"prompt\":\"$P Explain also the thrust reverser.\",\"n_predict\":200,\"temperature\":0,\"cache_prompt\":false}" > /dev/null &
  local J2=$!
  wait "$J1" "$J2"
  E=$(date +%s%N)
  local W=$(( (E-S)/1000000 ))
  echo "  два запроса разом: стенка $W мс -> суммарно $(python3 -c "print(round(400/($W/1000),1))") т/с" >> "$OUT"
  tail -n "+$((M0+1))" "$LOG" | grep -aoE "eval time = *[0-9.]+ ms / *200 tokens \([^)]*\)" | sed 's/^/    /' >> "$OUT"
  kill "$PID" 2>/dev/null
  sleep 8
}

run "par1-kvu"  1 "--kv-unified"
run "par2-kvu"  2 "--kv-unified"
run "par2-nokvu" 2 "--no-kv-unified"
echo "ЗАВЕРШЕНО" >> "$OUT"
