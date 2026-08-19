#!/usr/bin/env bash
# Ждёт готовности Unsloth Studio (HTTP 200 на /v1/models). Нужен потому, что Studio падает на
# тяжёлых длинноконтекстных запросах и перезапускается ~минуту; кампания без этой проверки
# записывает целый квант сплошными `network: fetch failed` и выглядит как «модель не работает»
# (поймано ночью [[19.08.2026]]: 45 пустых записей за один заход).
# Использование: wait-studio.sh [таймаут_секунд]
set -u
BASE="${LLAMA_SERVER_BASE:-http://gaming-pc.lan:8888/v1}"
TOKEN=$(cat "${LLAMA_SERVER_KEY_FILE:-/tmp/.unsloth-gp}")
DEADLINE=$(( $(date +%s) + ${1:-600} ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  CODE=$(curl -s -m 8 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "$BASE/models" 2>/dev/null)
  [ "$CODE" = "200" ] && { echo "studio: готова"; exit 0; }
  sleep 15
done
echo "studio: НЕ поднялась за ${1:-600}с"
exit 1
