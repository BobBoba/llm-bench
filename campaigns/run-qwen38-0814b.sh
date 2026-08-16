#!/usr/bin/env bash
# Кампания qwen38-0814b [[14.08.2026]] — лестница «квант ↔ окно» для Qwen3.8-27B (идея владельца:
# младший квант освобождает VRAM под KV => большее окно без offload => edit-long становится
# доступен). Запускается ПОСЛЕ основных фаз qwen38-0814 (менять окно посреди пары контроль/реком.
# нельзя — сломает сопоставимость).
#
# Точки:
#   UD-Q4_K_XL @ 65536  — тот же квант, вдвое большее окно (расчёт: 17+KV 2.7+резервы ≈ 22 ГБ);
#   UD-Q3_K_XL @ 131072 — младший квант ради длинного контекста (14+KV 5.5+резервы ≈ 22.4 ГБ);
#     риск: у Qwen3-Coder-Next Q4 был порогом качества кода — здесь проверяем плотную 27B.
# Перед каждой точкой: override -> выгрузка -> проверка фактического -c -> проба скорости.
# Точка идёт в hard только при полном размещении (selected: [0]) и здоровой скорости.
set -u
cd "$(dirname "$0")/.."
export LLAMA_SERVER_BASE=http://gaming-pc.lan:8888/v1
export LLAMA_SERVER_KEY_FILE=/tmp/.unsloth-gp
TOKEN=$(cat /tmp/.unsloth-gp)
LOG=results/qwen38-0814b.log
: > "$LOG"

set_ovr() {  # $1 = model_id (суффиксный), $2 = окно
  curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"model_id\":\"$1\",\"custom_context_length\":$2,\"kv_cache_dtype\":\"q4_0\"}" \
    "http://gaming-pc.lan:8888/api/settings/openai-auto-switch/overrides" > /dev/null
}
unload() {
  curl -s -m 300 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"model":"unsloth/Qwen3-0.6B-GGUF","max_tokens":3,"messages":[{"role":"user","content":"hi"}]}' \
    "$LLAMA_SERVER_BASE/chat/completions" -o /dev/null
}
probe() {  # $1 = model id; печатает tok/s
  node -e "
const { chat } = await import('./clients/llama-server-client.mjs');
const r = await chat({ model: '$1', max_tokens: 300, stream: true,
  messages: [{ role: 'user', content: 'Напиши стихотворение о реке, 12 строк.' }] });
console.log(r.ok ? r.tokps : 0);
" --input-type=module
}
fingerprint() {
  ssh gaming-pc "bash -c 'sudo journalctl -u unsloth-studio --since \"-15 min\" --no-pager | grep -oE \"GGUF size:.*fit: (on|off)\" | tail -1'" 2>/dev/null
}

echo "=== ТОЧКА A: UD-Q4_K_XL @ 65536 ===" >> "$LOG"
set_ovr "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL" 65536
unload
SPEED=$(probe "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL")
echo "A: tok/s=$SPEED" >> "$LOG"
fingerprint >> "$LOG"
if [ "${SPEED%.*}" -ge 25 ] 2>/dev/null; then
  MAX_TOKENS=40000 LLM_DEADLINE_MS=2400000 \
  OUT=results-hard-qwen38-w65k.json node runners/run-hard.mjs "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL" >> "$LOG" 2>&1
else
  echo "A: медленно ($SPEED т/с) — offload, точка не бенчится" >> "$LOG"
  set_ovr "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL" 32768   # вернуть рабочую конфигурацию
fi

echo "=== ТОЧКА B: UD-Q3_K_XL @ 131072 ===" >> "$LOG"
set_ovr "unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL" 131072
unload
SPEED=$(probe "unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL")
echo "B: tok/s=$SPEED" >> "$LOG"
fingerprint >> "$LOG"
if [ "${SPEED%.*}" -ge 25 ] 2>/dev/null; then
  MAX_TOKENS=40000 LLM_DEADLINE_MS=2400000 \
  OUT=results-hard-qwen38-q3.json node runners/run-hard.mjs "unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL" >> "$LOG" 2>&1
else
  echo "B: медленно ($SPEED т/с) — offload, точка не бенчится" >> "$LOG"
fi

echo "=== qwen38-0814b: завершено ===" >> "$LOG"
ssh gaming-pc gui-on >> "$LOG" 2>&1 || true
