#!/usr/bin/env bash
# Вторая половина ночи [[19.08.2026]]: контроль на общем окне -> бисекция обрыва.
set -u
cd "$(dirname "$0")/.."
LOG=results/qwen38-night-chain.log
echo "старт контроля (2-я попытка, со страховкой от перезапуска Studio) $(date +%H:%M)" >> "$LOG"
bash campaigns/run-qwen38-ctrl0819.sh
echo "контроль завершён $(date +%H:%M)" >> "$LOG"
bash campaigns/run-qwen38-cliff0819.sh
echo "бисекция завершена $(date +%H:%M)" >> "$LOG"
echo "=== цепочка 2 завершена ===" >> "$LOG"
