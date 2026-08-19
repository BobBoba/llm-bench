#!/usr/bin/env bash
# Решающий эксперимент ночи [[19.08.2026]]: потолок длинного контекста — это модель или ПРОСЛОЙКА?
#
# Симптом: на глубине ~196k ВСЕ кванты дают recall 0/8, при этом content ПУСТОЙ, а usage.prompt
# показывает ~68k вместо фактических ~194k (журнал движка при этом честно пишет
# `n_tokens = 193992, truncated = 0`). Это подпись «пустого успеха» прослойки, а не отказа
# модели: на 164k та же IQ2_M выдаёт настоящий ответ с шестью кодами из восьми.
# Проверяем тот же промпт в обход Studio — голым llama-server (у Qwen3.8 родное окно 262144,
# поэтому ни YaRN, ни --override-kv не нужны).
set -u
cd "$(dirname "$0")/.."
LOG=results/qwen38-bare0819.log
: > "$LOG"
HOST=gaming-pc.lan

# освободить карту: Studio переключаем на крошечную модель
export LLAMA_SERVER_BASE=http://$HOST:8888/v1
export LLAMA_SERVER_KEY_FILE=/tmp/.unsloth-gp
TOKEN=$(cat /tmp/.unsloth-gp)
curl -s -m 300 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"unsloth/Qwen3-0.6B-GGUF","max_tokens":3,"messages":[{"role":"user","content":"hi"}]}' \
  "$LLAMA_SERVER_BASE/chat/completions" -o /dev/null
echo "Studio выгружена $(date +%H:%M)" >> "$LOG"

# поднять голый сервер на Q2_K_XL, полное родное окно
ssh $HOST 'bash -c "pkill -f \"llama-server.*port 8080\" 2>/dev/null; sleep 2; \
  M=\$(ls /mnt/4tb/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/*/Qwen3.8-27B-UD-Q2_K_XL.gguf | head -1); \
  nohup /mnt/4tb/llm/unsloth-studio/llama.cpp/llama-server -m \"\$M\" --host 0.0.0.0 --port 8080 \
    -c 262144 --cache-type-k q4_0 --cache-type-v q4_0 --flash-attn on --jinja -ngl -1 --kv-unified --parallel 1 \
    > /tmp/qwen38-bare-8080.log 2>&1 & echo pid=\$!"' >> "$LOG" 2>&1
sleep 60
curl -s -m 10 http://$HOST:8080/health >> "$LOG"; echo >> "$LOG"

# те же ступени, что валились через Studio
export LLAMA_SERVER_BASE=http://$HOST:8080/v1
env LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20 LLM_DEADLINE_MS=2400000 \
  CTX=262144 RUNGS="196608,229376" \
  OUT=results-EXP-qwen38q-bare-q2-cliff.json node runners/run-multineedle.mjs "qwen38-q2-bare" >> "$LOG" 2>&1

ssh $HOST 'bash -c "grep -oE \"n_tokens = [0-9]+|truncated = [01]\" /tmp/qwen38-bare-8080.log | tail -4"' >> "$LOG" 2>&1
echo "=== bare0819 завершено $(date +%H:%M) ===" >> "$LOG"
