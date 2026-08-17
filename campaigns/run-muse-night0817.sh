#!/usr/bin/env bash
# Ночная исследовательская кампания muse-night0817 [[17.08.2026]] — «взять максимум» от
# Muse-Glimmer-30B UD-Q4_K_XL (поручение владельца, вся ночь). Эксперименты НЕ идут в таблицу
# (у одной модели только два идентификатора, а конфигураций много) — результаты в
# results-EXP-muse-*.json (вне glob results-hard*), сводка в NOTES-ru.md; в таблицу/pi/omp
# попадает только конфигурация-победитель, если она побьёт базовые 19/22.
#
# База для сравнения: UD-Q4_K_XL @131072, KV q4_0, reasoning_strength=high (дефолт шаблона),
# родной сэмплинг t=1.0/p=0.95/k=64 -> hard 19/22, multineedle 8/8@64k, ~65 т/с.
#
# Эксперименты:
#   A. YaRN 262144 (rope-scaling yarn ×2): multineedle до ~200k + полный hard (деградация от растяжения?)
#   B. KV q8_0 @131072: полный hard (разрядность KV и качество)
#   C. reasoning_strength low @131072: полный hard + пробы скорости (кривая скорость/качество)
#   D. tool-use батареи на базовой конфигурации (для Muse ни разу не гонялись)
#   E. (если время) проба UD-Q5_K_XL: загрузка, отпечаток, скорость
set -u
cd "$(dirname "$0")/.."
export LLAMA_SERVER_BASE=http://gaming-pc.lan:8888/v1
export LLAMA_SERVER_KEY_FILE=/tmp/.unsloth-gp
[ -s /tmp/.unsloth-gp ] || secret-tool lookup service unsloth-studio host gaming-pc purpose api-key > /tmp/.unsloth-gp
TOKEN=$(cat /tmp/.unsloth-gp)
M="unsloth/Muse-Glimmer-30B-GGUF:UD-Q4_K_XL"
VENDOR_T=1.0; VENDOR_P=0.95; VENDOR_K=64
LOG=results/muse-night0817.log
: > "$LOG"

ovr() {  # $1 = json тела override
  curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "$1" "http://gaming-pc.lan:8888/api/settings/openai-auto-switch/overrides" > /dev/null
}
unload() {
  curl -s -m 300 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"model":"unsloth/Qwen3-0.6B-GGUF","max_tokens":3,"messages":[{"role":"user","content":"hi"}]}' \
    "$LLAMA_SERVER_BASE/chat/completions" -o /dev/null
}
fingerprint() {
  ssh gaming-pc "bash -c 'sudo journalctl -u unsloth-studio --since \"-20 min\" --no-pager | grep -oE \"GGUF size:.*fit: (on|off)\" | tail -1'" 2>/dev/null
}
probe() {
  node -e "
const { chat } = await import('./clients/llama-server-client.mjs');
const r = await chat({ model: '$M', max_tokens: 300, stream: true,
  messages: [{ role: 'user', content: 'Напиши стихотворение о звёздах, 12 строк.' }] });
console.log(r.ok ? r.tokps : 0);
" --input-type=module
}

ssh gaming-pc "gui-off -y" >> "$LOG" 2>&1 || true

echo "=== ЭКСПЕРИМЕНТ A: YaRN 262144 ===" >> "$LOG"
ovr "{\"model_id\":\"$M\",\"custom_context_length\":262144,\"kv_cache_dtype\":\"q4_0\",\"llama_extra_args\":[\"--rope-scaling\",\"yarn\",\"--rope-scale\",\"2\",\"--yarn-orig-ctx\",\"131072\"]}"
unload
echo "A probe: tok/s=$(probe)" >> "$LOG"; fingerprint >> "$LOG"
env LLM_TEMPERATURE=$VENDOR_T LLM_TOP_P=$VENDOR_P LLM_TOP_K=$VENDOR_K LLM_DEADLINE_MS=2400000 \
  CTX=262144 RUNGS="32000,131072,200000" \
  OUT=results-EXP-muse-yarn262-multineedle.json node runners/run-multineedle.mjs "$M" >> "$LOG" 2>&1
env LLM_TEMPERATURE=$VENDOR_T LLM_TOP_P=$VENDOR_P LLM_TOP_K=$VENDOR_K \
  MAX_TOKENS=30000 LLM_DEADLINE_MS=2400000 \
  OUT=results-EXP-muse-yarn262-hard.json node runners/run-hard.mjs "$M" >> "$LOG" 2>&1

echo "=== ЭКСПЕРИМЕНТ B: KV q8_0 @131072 ===" >> "$LOG"
ovr "{\"model_id\":\"$M\",\"custom_context_length\":131072,\"kv_cache_dtype\":\"q8_0\"}"
unload
echo "B probe: tok/s=$(probe)" >> "$LOG"; fingerprint >> "$LOG"
env LLM_TEMPERATURE=$VENDOR_T LLM_TOP_P=$VENDOR_P LLM_TOP_K=$VENDOR_K \
  MAX_TOKENS=30000 LLM_DEADLINE_MS=2400000 \
  OUT=results-EXP-muse-kv8-hard.json node runners/run-hard.mjs "$M" >> "$LOG" 2>&1

echo "=== ЭКСПЕРИМЕНТ C: reasoning_strength=low @131072 ===" >> "$LOG"
ovr "{\"model_id\":\"$M\",\"custom_context_length\":131072,\"kv_cache_dtype\":\"q4_0\",\"llama_extra_args\":[\"--chat-template-kwargs\",\"{\\\"reasoning_strength\\\":\\\"low\\\"}\"]}"
unload
echo "C probe: tok/s=$(probe)" >> "$LOG"; fingerprint >> "$LOG"
ssh gaming-pc "bash -c 'ps aux | grep llama-server | grep -v grep | grep -o -E \"reasoning_strength[^ ]*\" | head -1'" >> "$LOG" 2>/dev/null
env LLM_TEMPERATURE=$VENDOR_T LLM_TOP_P=$VENDOR_P LLM_TOP_K=$VENDOR_K \
  MAX_TOKENS=30000 LLM_DEADLINE_MS=2400000 \
  OUT=results-EXP-muse-rslow-hard.json node runners/run-hard.mjs "$M" >> "$LOG" 2>&1

echo "=== ЭКСПЕРИМЕНТ D: tool-use на базовой конфигурации ===" >> "$LOG"
ovr "{\"model_id\":\"$M\",\"custom_context_length\":131072,\"kv_cache_dtype\":\"q4_0\"}"
unload
echo "D probe: tok/s=$(probe)" >> "$LOG"
env LLM_TEMPERATURE=$VENDOR_T LLM_TOP_P=$VENDOR_P LLM_TOP_K=$VENDOR_K \
  OUT=results-muse-tooluse.json node runners/run-tooluse.mjs "$M" >> "$LOG" 2>&1
env LLM_TEMPERATURE=$VENDOR_T LLM_TOP_P=$VENDOR_P LLM_TOP_K=$VENDOR_K \
  OUT=results-muse-tooluse-hard.json node runners/run-tooluse-hard.mjs "$M" >> "$LOG" 2>&1

echo "=== ЭКСПЕРИМЕНТ E: проба UD-Q5_K_XL ===" >> "$LOG"
Q5="unsloth/Muse-Glimmer-30B-GGUF:UD-Q5_K_XL"
ovr "{\"model_id\":\"$Q5\",\"custom_context_length\":65536,\"kv_cache_dtype\":\"q4_0\"}"
node -e "
const { chat } = await import('./clients/llama-server-client.mjs');
for (let i=0;i<30;i++) {
  const r = await chat({ model: '$Q5', max_tokens: 300, stream: true,
    messages: [{ role: 'user', content: 'Напиши стихотворение о ветре, 12 строк.' }] });
  if (r.ok && r.tokps > 0) { console.log('Q5@65536: tok/s='+r.tokps); process.exit(0); }
  if (!r.ok && String(r.error).includes('Downloading')) { await new Promise(s=>setTimeout(s,60000)); continue; }
  console.log('Q5: '+(r.error||'пустой ответ')); process.exit(0);
}
" --input-type=module >> "$LOG" 2>&1
fingerprint >> "$LOG"

# вернуть базовую конфигурацию победителя ночей займётся утренний разбор; пока — база
ovr "{\"model_id\":\"$M\",\"custom_context_length\":131072,\"kv_cache_dtype\":\"q4_0\"}"
echo "=== muse-night0817: завершено ===" >> "$LOG"
ssh gaming-pc gui-on >> "$LOG" 2>&1 || true
