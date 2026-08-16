#!/usr/bin/env bash
# Кампания qwen38-0814d [[14.08.2026]] — продолжение qwen38-0814c с ДВУМЯ поправками владельца:
# (1) «мне очень нужен длинный контекст для тяжёлой работы» — точка UD-Q3_K_XL@131072 и
# сертификация multineedle идут ПЕРВЫМИ; (2) reasoning_effort=medium вместо дефолтного xhigh
# (дефолт думает >40k токенов и не сходится — находка фазы 1, см. NOTES).
# Фаза 1 (контроль t=0.2/xhigh @65k, 7/22) уже в results-hard-qwen38.json.
set -u
cd "$(dirname "$0")/.."
export LLAMA_SERVER_BASE=http://gaming-pc.lan:8888/v1
export LLAMA_SERVER_KEY_FILE=/tmp/.unsloth-gp
[ -s /tmp/.unsloth-gp ] || secret-tool lookup service unsloth-studio host gaming-pc purpose api-key > /tmp/.unsloth-gp
TOKEN=$(cat /tmp/.unsloth-gp)
REPO="unsloth/Qwen3.8-27B-GGUF"
Q4="unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL"
Q3="unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL"
VENDOR='LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20'
MEDIUM='{"reasoning_effort":"medium"}'
LOG=results/qwen38-0814d.log
: > "$LOG"

ssh gaming-pc "gui-off -y" >> "$LOG" 2>&1 || true

echo "=== ФАЗА A: hard @65k Q4, родной сэмплинг + effort medium ===" >> "$LOG"
env LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20 LLM_CHAT_TEMPLATE_KWARGS="$MEDIUM" \
  MAX_TOKENS=40000 LLM_DEADLINE_MS=2400000 \
  OUT=results-hard-qwen38-rec.json node runners/run-hard.mjs "$Q4" >> "$LOG" 2>&1

echo "=== ФАЗА B: UD-Q3_K_XL @ 131072 — длинный контекст (приоритет владельца) ===" >> "$LOG"
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"model_id\":\"$Q3\",\"custom_context_length\":131072,\"kv_cache_dtype\":\"q4_0\"}" \
  "http://gaming-pc.lan:8888/api/settings/openai-auto-switch/overrides" > /dev/null
SPEED=$(node -e "
const { chat } = await import('./clients/llama-server-client.mjs');
for (let i=0;i<25;i++) {
  const r = await chat({ model: '$Q3', max_tokens: 300, stream: true,
    messages: [{ role: 'user', content: 'Напиши стихотворение о поле, 12 строк.' }] });
  if (r.ok && r.tokps > 0) { console.log(r.tokps); process.exit(0); }
  if (!r.ok && String(r.error).includes('Downloading')) { await new Promise(s=>setTimeout(s,60000)); continue; }
  if (!r.ok) { console.log(0); process.exit(0); }
}
console.log(0);
" --input-type=module)
echo "Q3@131072: tok/s=$SPEED" >> "$LOG"
ssh gaming-pc "bash -c 'sudo journalctl -u unsloth-studio --since \"-40 min\" --no-pager | grep -oE \"GGUF size:.*fit: (on|off)\" | tail -1'" >> "$LOG" 2>/dev/null
if [ "${SPEED%.*}" -ge 25 ] 2>/dev/null; then
  echo "--- B1: hard (родной сэмплинг + medium) — edit-long впервые доступен ---" >> "$LOG"
  env LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20 LLM_CHAT_TEMPLATE_KWARGS="$MEDIUM" \
    MAX_TOKENS=40000 LLM_DEADLINE_MS=2400000 \
    OUT=results-hard-qwen38-q3.json node runners/run-hard.mjs "$Q3" >> "$LOG" 2>&1
  echo "--- B2: multineedle @131k (сертификация поиска по длинному контексту) ---" >> "$LOG"
  env LLM_CHAT_TEMPLATE_KWARGS="$MEDIUM" LLM_DEADLINE_MS=2400000 \
    OUT=results-qwen38-q3-multineedle.json node runners/run-multineedle.mjs "$Q3" >> "$LOG" 2>&1
else
  echo "Q3: offload/медленно ($SPEED т/с) — длинный контекст на этой карте закрыт и для Q3" >> "$LOG"
fi

echo "=== ФАЗА C: стандартные батареи @65k Q4 — контроль и родной+medium ===" >> "$LOG"
OUT=results-qwen38-rust.json      node runners/run-rust.mjs      "$REPO" >> "$LOG" 2>&1
OUT=results-qwen38-ts.json        node runners/run-ts.mjs        "$REPO" >> "$LOG" 2>&1
OUT=results-qwen38-knowledge.json node runners/run-knowledge.mjs "$REPO" >> "$LOG" 2>&1
env LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20 LLM_CHAT_TEMPLATE_KWARGS="$MEDIUM" \
  OUT=results-qwen38rec-rust.json node runners/run-rust.mjs "$Q4" >> "$LOG" 2>&1
env LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20 LLM_CHAT_TEMPLATE_KWARGS="$MEDIUM" \
  OUT=results-qwen38rec-ts.json node runners/run-ts.mjs "$Q4" >> "$LOG" 2>&1
env LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20 LLM_CHAT_TEMPLATE_KWARGS="$MEDIUM" \
  OUT=results-qwen38rec-knowledge.json node runners/run-knowledge.mjs "$Q4" >> "$LOG" 2>&1

echo "=== ФАЗА D: tool-use ===" >> "$LOG"
OUT=results-qwen38-tooluse.json      node runners/run-tooluse.mjs      "$REPO" >> "$LOG" 2>&1
OUT=results-qwen38-tooluse-hard.json node runners/run-tooluse-hard.mjs "$REPO" >> "$LOG" 2>&1

echo "=== qwen38-0814d: завершено ===" >> "$LOG"
ssh gaming-pc gui-on >> "$LOG" 2>&1 || true
