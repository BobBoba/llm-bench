#!/usr/bin/env bash
# Скорость генерации против ёмкости KV-пула для Qwen3.8-27B UD-IQ2_XXS.
#
# ЗАЧЕМ. Ночью пул подбирался по ёмкости («влезает + иглы находит»), скорость на этих точках
# не мерилась. Живая проба на -c 524288 дала 21-27 т/с против 63 т/с, замеренных лестницей
# на -c 262144 через Studio. Надо отделить три возможных причины: (1) размер пула,
# (2) наличие MTP-спекуляции, (3) прослойка Studio (--parallel 4 и её флаги).
#
# МЕТОДИКА. Эндпоинт /completion, а не /chat/completions: сырой промпт без шаблона и без
# рассуждений даёт ФИКСИРОВАННУЮ длину ответа (n_predict) и одинаковый поток токенов при
# temperature 0 — значит принятие MTP-черновиков сравнимо между точками. Первый запрос
# прогревочный (аллокации, прогрев кэшей), меряется второй.
set -u
BIN=/mnt/4tb/llm/unsloth-studio/llama.cpp/llama-server
M=$(ls /mnt/4tb/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/*/Qwen3.8-27B-UD-IQ2_XXS.gguf 2>/dev/null | head -1)
PORT=8085
OUT=/tmp/speed-vs-pool.txt
: > "$OUT"
[ -n "$M" ] || { echo "модель не найдена" >> "$OUT"; exit 1; }

PROMPT='Write a detailed technical description of how a modern turbofan jet engine works, covering the fan, compressor, combustor and turbine stages.'

measure() {
  local LABEL="$1"; shift
  local LOG="/tmp/sp-$(echo "$LABEL" | tr ' /' '__').log"
  nohup "$BIN" -m "$M" --host 127.0.0.1 --port "$PORT" \
    --cache-type-k q4_0 --cache-type-v q4_0 --flash-attn on --jinja -ngl -1 --kv-unified \
    "$@" > "$LOG" 2>&1 &
  local PID=$!
  local OK=""
  for i in $(seq 1 90); do
    sleep 5
    if curl -s -m 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q ok; then OK=yes; break; fi
    kill -0 "$PID" 2>/dev/null || break
  done
  if [ -z "$OK" ]; then
    echo "=== $LABEL: НЕ ПОДНЯЛСЯ ===" >> "$OUT"
    kill "$PID" 2>/dev/null; sleep 5; return
  fi
  local VRAM=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader)
  # прогрев
  curl -s -m 600 "http://127.0.0.1:$PORT/completion" -H 'Content-Type: application/json' \
    -d "{\"prompt\":\"$PROMPT\",\"n_predict\":300,\"temperature\":0,\"cache_prompt\":false}" > /dev/null
  local MARK=$(wc -l < "$LOG")
  # измерение
  curl -s -m 600 "http://127.0.0.1:$PORT/completion" -H 'Content-Type: application/json' \
    -d "{\"prompt\":\"$PROMPT\",\"n_predict\":300,\"temperature\":0,\"cache_prompt\":false}" > /dev/null
  echo "=== $LABEL | vram=$VRAM ===" >> "$OUT"
  tail -n "+$((MARK+1))" "$LOG" | grep -aiE "eval time|tokens per second|n_drafted|n_accept|draft acceptance|accept" >> "$OUT"
  grep -aoE "n_ctx_slot = [0-9]+" "$LOG" | head -1 >> "$OUT"
  kill "$PID" 2>/dev/null
  sleep 8
}

MTP="--spec-type draft-mtp --spec-draft-n-max 2"
measure "pool-32768-mtp"    -c 32768  --parallel 1 $MTP
measure "pool-262144-mtp"   -c 262144 --parallel 1 $MTP
measure "pool-393216-mtp"   -c 393216 --parallel 1 $MTP
measure "pool-524288-mtp"   -c 524288 --parallel 1 $MTP
measure "pool-262144-nomtp" -c 262144 --parallel 1
measure "pool-524288-nomtp" -c 524288 --parallel 1
echo "ЗАВЕРШЕНО" >> "$OUT"
