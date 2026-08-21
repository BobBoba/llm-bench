#!/usr/bin/env bash
set -euo pipefail

MODEL_REPO="${MODEL_REPO:-unsloth/Qwen3.8-27B-GGUF}"
MODEL_FILE="${MODEL_FILE:-Qwen3.8-27B-UD-Q3_K_XL.gguf}"
MODEL_DIR="${MODEL_DIR:-/models}"

: "${HF_TOKEN:?Set HF_TOKEN in the environment; it is never printed}"

mkdir -p -- "$MODEL_DIR"
echo "Downloading ${MODEL_REPO}/${MODEL_FILE} into ${MODEL_DIR}" >&2

HF_TOKEN="$HF_TOKEN" hf download \
  "$MODEL_REPO" \
  "$MODEL_FILE" \
  --repo-type model \
  --local-dir "$MODEL_DIR"

echo "Model is available at ${MODEL_DIR}/${MODEL_FILE}" >&2
