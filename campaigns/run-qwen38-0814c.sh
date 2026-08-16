#!/usr/bin/env bash
# Кампания qwen38-0814c [[14.08.2026]] — Qwen3.8-27B UD-Q4_K_XL, ПЕРЕЗАПУСК после находки:
# на окне 32768 гибрид-мыслитель сжигает ВСЁ ОКНО на размышления (finish=length при
# tokOut≈32350, ответ пустой) — первая попытка (архив results-ARCHIVE-qwen38-hard-w32k.json:
# 6/22) мерила не способности, а удушение мышления окном. Лестница показала: 65536 влезает
# ЦЕЛИКОМ (selected: [0], 62 т/с; отпечаток в NOTES) — это и есть рабочая конфигурация.
# Идея младшего кванта ради KV (владелец) — фаза 6: UD-Q3_K_XL @ 131072 (edit-long!).
set -u
cd "$(dirname "$0")/.."
export LLAMA_SERVER_BASE=http://gaming-pc.lan:8888/v1
export LLAMA_SERVER_KEY_FILE=/tmp/.unsloth-gp
TOKEN=$(cat /tmp/.unsloth-gp)
REPO="unsloth/Qwen3.8-27B-GGUF"
REC="unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL"
Q3="unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL"
LOG=results/qwen38-0814c.log
: > "$LOG"

echo "=== ФАЗА 1: hard, контроль t=0.2 @65536 ===" >> "$LOG"
MAX_TOKENS=40000 LLM_DEADLINE_MS=2400000 \
OUT=results-hard-qwen38.json node runners/run-hard.mjs "$REPO" >> "$LOG" 2>&1

echo "=== ФАЗА 2: hard, рекомендованные (t=1.0 p=0.95 k=20) @65536 ===" >> "$LOG"
LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20 MAX_TOKENS=40000 LLM_DEADLINE_MS=2400000 \
OUT=results-hard-qwen38-rec.json node runners/run-hard.mjs "$REC" >> "$LOG" 2>&1

echo "=== ФАЗА 3: стандартные, контроль t=0.2 ===" >> "$LOG"
OUT=results-qwen38-rust.json      node runners/run-rust.mjs      "$REPO" >> "$LOG" 2>&1
OUT=results-qwen38-ts.json        node runners/run-ts.mjs        "$REPO" >> "$LOG" 2>&1
OUT=results-qwen38-knowledge.json node runners/run-knowledge.mjs "$REPO" >> "$LOG" 2>&1

echo "=== ФАЗА 4: стандартные, рекомендованные ===" >> "$LOG"
LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20 \
OUT=results-qwen38rec-rust.json      node runners/run-rust.mjs      "$REC" >> "$LOG" 2>&1
LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20 \
OUT=results-qwen38rec-ts.json        node runners/run-ts.mjs        "$REC" >> "$LOG" 2>&1
LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20 \
OUT=results-qwen38rec-knowledge.json node runners/run-knowledge.mjs "$REC" >> "$LOG" 2>&1

echo "=== ФАЗА 5: tool-use (контроль) ===" >> "$LOG"
OUT=results-qwen38-tooluse.json      node runners/run-tooluse.mjs      "$REPO" >> "$LOG" 2>&1
OUT=results-qwen38-tooluse-hard.json node runners/run-tooluse-hard.mjs "$REPO" >> "$LOG" 2>&1

echo "=== ФАЗА 6: UD-Q3_K_XL @ 131072 (младший квант ради KV/edit-long) ===" >> "$LOG"
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"model_id\":\"$Q3\",\"custom_context_length\":131072,\"kv_cache_dtype\":\"q4_0\"}" \
  "$LLAMA_SERVER_BASE/../api/settings/openai-auto-switch/overrides" > /dev/null
# первый вызов скачает квант (~14 ГБ) и применит override
SPEED=$(node -e "
const { chat } = await import('./clients/llama-server-client.mjs');
for (let i=0;i<20;i++) {
  const r = await chat({ model: '$Q3', max_tokens: 300, stream: true,
    messages: [{ role: 'user', content: 'Напиши стихотворение о поле, 12 строк.' }] });
  if (r.ok && r.tokps > 0) { console.log(r.tokps); process.exit(0); }
  if (r.error && String(r.error).includes('Downloading')) { await new Promise(s=>setTimeout(s,60000)); continue; }
  if (!r.ok) { console.log(0); process.exit(0); }
}
console.log(0);
" --input-type=module)
echo "Q3@131072: tok/s=$SPEED" >> "$LOG"
ssh gaming-pc "bash -c 'sudo journalctl -u unsloth-studio --since \"-30 min\" --no-pager | grep -oE \"GGUF size:.*fit: (on|off)\" | tail -1'" >> "$LOG" 2>/dev/null
if [ "${SPEED%.*}" -ge 25 ] 2>/dev/null; then
  MAX_TOKENS=40000 LLM_DEADLINE_MS=2400000 \
  OUT=results-hard-qwen38-q3.json node runners/run-hard.mjs "$Q3" >> "$LOG" 2>&1
else
  echo "Q3: offload/медленно — точка не бенчится" >> "$LOG"
fi

echo "=== qwen38-0814c: завершено ===" >> "$LOG"
ssh gaming-pc gui-on >> "$LOG" 2>&1 || true
