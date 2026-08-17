#!/usr/bin/env bash
# Добавочная точка кривой «усилие/качество»: reasoning_strength=medium (low 13/22@17с, high 19/22)
set -u
cd "$(dirname "$0")/.."
export LLAMA_SERVER_BASE=http://gaming-pc.lan:8888/v1
export LLAMA_SERVER_KEY_FILE=/tmp/.unsloth-gp
TOKEN=$(cat /tmp/.unsloth-gp)
M="unsloth/Muse-Glimmer-30B-GGUF:UD-Q4_K_XL"
LOG=results/muse-night0817.log
ssh gaming-pc "gui-off -y" >> "$LOG" 2>&1 || true
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"model_id\":\"$M\",\"custom_context_length\":131072,\"kv_cache_dtype\":\"q4_0\",\"llama_extra_args\":[\"--chat-template-kwargs\",\"{\\\"reasoning_strength\\\":\\\"medium\\\"}\"]}" \
  "http://gaming-pc.lan:8888/api/settings/openai-auto-switch/overrides" > /dev/null
curl -s -m 300 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"unsloth/Qwen3-0.6B-GGUF","max_tokens":3,"messages":[{"role":"user","content":"hi"}]}' \
  "$LLAMA_SERVER_BASE/chat/completions" -o /dev/null
echo "=== ДОБАВКА: reasoning_strength=medium ===" >> "$LOG"
env LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=64 MAX_TOKENS=30000 LLM_DEADLINE_MS=2400000 \
  OUT=results-EXP-muse-rsmed-hard.json node runners/run-hard.mjs "$M" >> "$LOG" 2>&1
# вернуть базовый override (дефолтная high, без extra args)
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"model_id\":\"$M\",\"custom_context_length\":131072,\"kv_cache_dtype\":\"q4_0\"}" \
  "http://gaming-pc.lan:8888/api/settings/openai-auto-switch/overrides" > /dev/null
echo "=== добавка medium: завершено ===" >> "$LOG"
ssh gaming-pc gui-on >> "$LOG" 2>&1 || true
