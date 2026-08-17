#!/usr/bin/env bash
# Голый llama-server с Muse-Glimmer на РАСТЯНУТОМ окне 262144 (YaRN ×2) — обход двух потолков
# стека [[17.08.2026]]: прослойка Unsloth Studio валидирует промпты по родному окну из метаданных
# GGUF, а сам llama-server капит слот до n_ctx_train — снимается ТОЛЬКО --override-kv.
# Проверено иглами: 8/8 на промптах 147k и 180k токенов (180k за 212 с prefill+ответ).
# Запускать НА gaming-pc (CachyOS). VRAM ~23.9 ГБ — с рабочим столом впритык, лучше gui-off.
# Порт 8080, без аутентификации (LAN-only, как прежний llama-server-провайдер omp).
# Перед запуском выгрузить большую модель из Studio (переключением на Qwen3-0.6B).
set -u
M=/mnt/4tb/.cache/huggingface/hub/models--unsloth--Muse-Glimmer-30B-GGUF/snapshots/faa5b025c584459c13febfa5c59883516710ae39/Muse-Glimmer-30B-UD-Q4_K_XL.gguf
D=/mnt/4tb/.cache/huggingface/hub/models--unsloth--Muse-Glimmer-30B-GGUF/blobs/27d9a805fa29b943cfb6ad4843367cd4eaaaf06bd452d8cc3e00a2cd18a677bc
exec /mnt/4tb/llm/unsloth-studio/llama.cpp/llama-server \
  -m "$M" \
  --model-draft "$D" --spec-type draft-dflash --spec-draft-n-max 2 \
  --host 0.0.0.0 --port 8080 \
  -c 262144 \
  --rope-scaling yarn --rope-scale 2 --yarn-orig-ctx 131072 \
  --override-kv muse-glimmer.context_length=int:262144 \
  --cache-type-k q4_0 --cache-type-v q4_0 \
  --flash-attn on --jinja -ngl -1 --kv-unified \
  --parallel 1
# --parallel 1: пул KV (262144 ячеек) един для ВСЕХ слотов; при 4 слотах кэши длинных промптов
# вытесняют друг друга («failed to find N available cells in kv cache» → полный re-prefill
# ~3 мин на 200k). Одному пользователю с промптами под самое окно нужен один слот со всем пулом.
