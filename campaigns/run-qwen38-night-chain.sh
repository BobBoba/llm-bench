#!/usr/bin/env bash
# Цепочка ночи [[19.08.2026]]: дождаться конца лестницы квантов, затем бисекция обрыва поиска,
# затем контрольное сравнение на общем окне. Раннеры делят одну видеокарту, поэтому строго
# последовательно; ждём именно исчезновения процессов раннера, а не оркестратора.
set -u
cd "$(dirname "$0")/.."
LOG=results/qwen38-night-chain.log
: > "$LOG"

echo "ожидание конца лестницы квантов..." >> "$LOG"
while pgrep -f "run-qwen38-quants0818.sh" > /dev/null; do sleep 60; done
echo "лестница завершена $(date +%H:%M)" >> "$LOG"

echo "старт бисекции обрыва $(date +%H:%M)" >> "$LOG"
bash campaigns/run-qwen38-cliff0819.sh
echo "бисекция завершена $(date +%H:%M)" >> "$LOG"

echo "старт контрольного сравнения $(date +%H:%M)" >> "$LOG"
bash campaigns/run-qwen38-ctrl0819.sh
echo "контроль завершён $(date +%H:%M)" >> "$LOG"
echo "=== цепочка ночи завершена ===" >> "$LOG"
