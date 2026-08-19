#!/usr/bin/env bash
# Проверка обрыва 491520 -> 524288 с подробным журналом и ЧЕРЕДОВАНИЕМ точек.
# Чередование A/B/A/B — защита от помехи, меняющейся во времени (троттлинг, чужой процесс
# на карте): если провал повторится на обоих проходах B и ни разу на A, причина в конфигурации.
# -lv 3 нужен, чтобы увидеть строки размещения буферов (KV cache, compute buffer) — гипотеза:
# на 524288 остаток KV не влезает в видеопамять и уезжает в системную, отсюда цена токена.
set -u
BIN=/mnt/4tb/llm/unsloth-studio/llama.cpp/llama-server
M=$(ls /mnt/4tb/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/*/Qwen3.8-27B-UD-IQ2_XXS.gguf | head -1)
PORT=8086
OUT=/tmp/cliff-verify.txt
: > "$OUT"
PROMPT='Write a detailed technical description of how a modern turbofan jet engine works, covering the fan, compressor, combustor and turbine stages.'

i=0
for C in 491520 524288 491520 524288; do
  i=$((i+1))
  LOG="/tmp/cv-$i-$C.log"
  nohup "$BIN" -m "$M" --host 127.0.0.1 --port "$PORT" -c "$C" -lv 3 \
    --cache-type-k q4_0 --cache-type-v q4_0 --flash-attn on --jinja -ngl -1 --kv-unified \
    --parallel 1 --spec-type draft-mtp --spec-draft-n-max 2 > "$LOG" 2>&1 &
  PID=$!
  OK=""
  for t in $(seq 1 90); do
    sleep 5
    curl -s -m 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q ok && { OK=yes; break; }
    kill -0 "$PID" 2>/dev/null || break
  done
  if [ -z "$OK" ]; then echo "=== проход $i: -c $C НЕ ПОДНЯЛСЯ ===" >> "$OUT"; kill "$PID" 2>/dev/null; sleep 5; continue; fi
  V=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader)
  curl -s -m 600 "http://127.0.0.1:$PORT/completion" -H 'Content-Type: application/json' \
    -d "{\"prompt\":\"$PROMPT\",\"n_predict\":200,\"temperature\":0,\"cache_prompt\":false}" > /dev/null
  MARK=$(wc -l < "$LOG")
  # во время измерения снимаем загрузку GPU: при уходе буферов в системную память
  # утилизация проседает — карта ждёт данные по шине
  ( for k in 1 2 3 4 5 6; do nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader; sleep 1; done > "/tmp/cv-util-$i.txt" ) &
  SAMPLER=$!
  curl -s -m 600 "http://127.0.0.1:$PORT/completion" -H 'Content-Type: application/json' \
    -d "{\"prompt\":\"$PROMPT\",\"n_predict\":200,\"temperature\":0,\"cache_prompt\":false}" > /dev/null
  # ! именно $SAMPLER, а не голый wait: голый ждёт ВСЕХ детей, включая сам llama-server,
  #   и проход зависает уже после успешного измерения
  wait "$SAMPLER"
  RSS=$(ps -o rss= -p "$PID" | tr -d ' ')
  echo "=== проход $i | -c $C | vram=$V | rss=$((RSS/1024)) MiB ===" >> "$OUT"
  tail -n "+$((MARK+1))" "$LOG" | grep -aE "eval time|draft acceptance" >> "$OUT"
  echo "-- загрузка GPU во время генерации: $(paste -sd' ; ' /tmp/cv-util-$i.txt)" >> "$OUT"
  echo "-- размещение:" >> "$OUT"
  grep -aiE "KV cache|kv_cache|buffer size|compute buffer|CPU_Mapped|CUDA_Host|graph splits|offloaded" "$LOG" | head -10 >> "$OUT"
  kill "$PID" 2>/dev/null
  sleep 8
done
echo "ЗАВЕРШЕНО" >> "$OUT"
