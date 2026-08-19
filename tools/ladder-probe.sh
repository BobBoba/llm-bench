#!/usr/bin/env bash
# Помощник лестницы «квант ↔ окно»: ставит override Studio, выгружает модель, грузит заново,
# печатает отпечаток размещения и замеренную скорость. Нужен потому, что арифметика по
# метаданным систематически врёт: фиттер отказывается от конфигурации, которая «по бумаге»
# влезает, — ему нужен запас под compute-буферы, а их размер зависит от батча prefill.
#
# Использование: ladder-probe.sh <repo:QUANT> <окно> [дополнительные llama_extra_args JSON]
# Пример:        ladder-probe.sh unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL 131072
# Печатает: "<квант> <окно> tok/s=<N> vram=<M> fit=<on|off> selected=<...>"
set -u
MODEL_ID="$1"
CTX="$2"
EXTRA="${3:-}"
BASE="${LLAMA_SERVER_BASE:-http://gaming-pc.lan:8888/v1}"
KEYF="${LLAMA_SERVER_KEY_FILE:-/tmp/.unsloth-gp}"
TOKEN=$(cat "$KEYF")
HOST=$(echo "$BASE" | sed -E 's|https?://([^:/]+).*|\1|')
API="http://$HOST:8888/api/settings/openai-auto-switch/overrides"

# ! Усилие рассуждения ЗАШИВАЕТСЯ ФЛАГОМ ЗАПУСКА: прослойка Studio отбрасывает
#   chat_template_kwargs из тела запроса (находка [[14.08.2026]]).
if [ -n "$EXTRA" ]; then
  BODY="{\"model_id\":\"$MODEL_ID\",\"custom_context_length\":$CTX,\"kv_cache_dtype\":\"q4_0\",\"llama_extra_args\":$EXTRA}"
else
  BODY="{\"model_id\":\"$MODEL_ID\",\"custom_context_length\":$CTX,\"kv_cache_dtype\":\"q4_0\",\"llama_extra_args\":[\"--chat-template-kwargs\",\"{\\\"reasoning_effort\\\":\\\"medium\\\"}\"]}"
fi
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$BODY" "$API" > /dev/null

# выгрузка: переключение на крошечную модель (override применяется только при ЗАГРУЗКЕ)
curl -s -m 300 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"unsloth/Qwen3-0.6B-GGUF","max_tokens":3,"messages":[{"role":"user","content":"hi"}]}' \
  "$BASE/chat/completions" -o /dev/null

cd "$(dirname "$0")/.."
SPEED=$(LLM_DEADLINE_MS=1200000 node -e "
const { chat } = await import('./clients/llama-server-client.mjs');
for (let i = 0; i < 15; i++) {
  const r = await chat({ model: '$MODEL_ID', max_tokens: 250, stream: true, temperature: 1.0,
    messages: [{ role: 'user', content: 'Напиши стихотворение о городе, 12 строк.' }] });
  if (r.ok && r.tokps > 0) { console.log(r.tokps); process.exit(0); }
  if (!r.ok && String(r.error).includes('Downloading')) { await new Promise(s => setTimeout(s, 60000)); continue; }
  if (!r.ok) { console.log('ERR:' + String(r.error).slice(0, 60)); process.exit(0); }
}
console.log(0);
" --input-type=module 2>/dev/null | tail -1)

FP=$(ssh "$HOST" "bash -c 'sudo journalctl -u unsloth-studio --since \"-10 min\" --no-pager | grep -oE \"GGUF size:.*fit: (on|off)\" | tail -1'" 2>/dev/null)
VRAM=$(ssh "$HOST" "nvidia-smi --query-gpu=memory.used --format=csv,noheader" 2>/dev/null)
SEL=$(echo "$FP" | grep -oE "selected: [^,]*" || echo "selected: ?")

echo "QUANT=$MODEL_ID CTX=$CTX tok/s=$SPEED vram=$VRAM $SEL"
echo "  fingerprint: $FP"
