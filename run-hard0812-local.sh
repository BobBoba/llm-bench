#!/usr/bin/env bash
# Ночной hard-бенч [[12.08.2026]] — НОВАЯ установка Unsloth Studio на gaming-pc (CachyOS,
# 4-ТБ диск; та же машина 192.168.89.53, что и прежний «gpu-stand», но ДРУГАЯ система —
# двойная загрузка, своя база ключей). Ключ: KeePassXC «Unsloth Studio API (gaming-pc CachyOS)».
#
# Пять новых моделей, строго последовательно. Порядок осознанный: проверенные архитектуры
# первыми, экспериментальная diffusion-gemma — ПОСЛЕДНЕЙ (может не подняться в llama-server;
# раннер после трёх ошибок вызова подряд пропускает остаток юнитов модели).
#
# БЮДЖЕТ ТОКЕНОВ РАЗДЕЛЁН ПО СКОРОСТИ МОДЕЛИ (урок первого запуска: юнит плотной 27B сгорел
# по 20-минутному дедлайну, не дописав рассуждения):
#   MoE (A3B/A4B, ~100+ т/с)  — MAX_TOKENS=100000, дедлайн 30 мин;
#   плотные (~25 т/с на 3090) — MAX_TOKENS=40000,  дедлайн 40 мин (40k/25тс ≈ 27 мин + prefill).
# finish=length у плотных при 40k — честная находка «не укладывается в бюджет», как у Apriel.
# У Muse-Glimmer окно 131072 (родное), у остальных 262144; KV q4_0 задан overrides Studio.
set -u
cd /code/work/llm-bench
export LMSTUDIO_BASE=http://gaming-pc.lan:8888/v1
export LMSTUDIO_KEY_FILE=/tmp/.unsloth-gp
[ -s /tmp/.unsloth-gp ] || secret-tool lookup service unsloth-studio host gaming-pc purpose api-key > /tmp/.unsloth-gp
[ -s /tmp/.unsloth-gp ] || { echo "нет ключа Studio gaming-pc (KeePassXC заблокирован?)"; exit 1; }

LOG=results/hard0812-local.log
: > "$LOG"

# --- MoE: быстрые, широкий бюджет ---
MAX_TOKENS=100000 LLM_DEADLINE_MS=1800000 OUT="results-hard0812-local.json" node run-hard.mjs \
  "unsloth/Qwen3.6-35B-A3B-MTP-GGUF" \
  "unsloth/Ornith-1.0-35B-GGUF" \
  >> "$LOG" 2>&1

# --- плотные: окно 32768 (иначе offload и 1-8 т/с — проверено тремя пробами на 262k/131k/98k:
# фиттеру Studio нужен запас под compute-буферы, и 27B с mmproj+MTP не помещается ни на одном
# окне >= 63k). edit-long у плотных честно выпадает: 63k промпта не влезает в окно — это
# результат «длинный контекст на этой карте недоступен», как у Seed-OSS в unsloth0803b.
MAX_TOKENS=30000 LLM_DEADLINE_MS=2400000 OUT="results-hard0812-local.json" node run-hard.mjs \
  "unsloth/Qwen3.6-27B-MTP-GGUF" \
  "unsloth/Muse-Glimmer-30B-GGUF" \
  >> "$LOG" 2>&1

# --- экспериментальная диффузионная — последней ---
MAX_TOKENS=40000 LLM_DEADLINE_MS=2400000 OUT="results-hard0812-local.json" node run-hard.mjs \
  "unsloth/diffusiongemma-26B-A4B-it-GGUF" \
  >> "$LOG" 2>&1

echo "hard0812 local: завершено" >> "$LOG"
