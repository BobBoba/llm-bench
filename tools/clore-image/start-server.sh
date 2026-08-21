#!/bin/bash
# Generic llama-server launcher for public GGUF repositories.
#
# Required:
#   LLAMA_API_KEY or API_KEY  one or more comma-separated API keys
#
# Model selection:
#   MODEL_REPO            HF repository (default: unsloth/Qwen3.8-27B-GGUF)
#   MODEL_QUANT           replaces {quant} in MODEL_FILE_TEMPLATE
#   MODEL_FILE            exact file path in MODEL_REPO; overrides the template
#   MODEL_FILE_TEMPLATE   default: Qwen3.8-27B-UD-{quant}.gguf
#   MODEL_URL             optional direct public URL; overrides MODEL_REPO
#
# Common wrapper aliases (native LLAMA_ARG_* variables are also supported):
#   HOST, PORT, CONTEXT, KV_K, KV_V, NGL, PARALLEL, SPEC
#   EXTRA_ARGS            additional non-persistent llama-server arguments
#   HEALTH_TIMEOUT        model-load wait limit in seconds (default: 900)
#   DRY_RUN=1             print safe configuration and exit before download/start
#
# Runtime privacy policy:
#   - model download is always placed under /tmp/llama-server;
#   - the model is loaded with mmap disabled, then its file is unlinked;
#   - prompt/KV persistence, prompt logging, slots, metrics, UI and props are off;
#   - the private model directory is removed on startup and shutdown.
# This removes application-created files on normal operation. It cannot prevent a
# third-party host operator from inspecting live process memory, GPU VRAM, the
# container filesystem, or network traffic while the server is running.
set -euo pipefail
ulimit -c 0 2>/dev/null || true

DEFAULT_MODEL_REPO="unsloth/Qwen3.8-27B-GGUF"
DEFAULT_MODEL_FILE_TEMPLATE="Qwen3.8-27B-UD-{quant}.gguf"
DEFAULT_MODEL_QUANT="Q3_K_XL"
DEFAULT_REASONING_EFFORT="high"
MODEL_DIR="/tmp/llama-server"

MODEL_REPO="${MODEL_REPO:-${REPO:-$DEFAULT_MODEL_REPO}}"
MODEL_QUANT="${MODEL_QUANT:-$DEFAULT_MODEL_QUANT}"
MODEL_FILE_TEMPLATE="${MODEL_FILE_TEMPLATE:-$DEFAULT_MODEL_FILE_TEMPLATE}"
MODEL_FILE="${MODEL_FILE:-${MODEL_FILE_TEMPLATE//\{quant\}/$MODEL_QUANT}}"
MODEL_URL="${MODEL_URL:-}"

HOST="${HOST:-${LLAMA_ARG_HOST:-0.0.0.0}}"
PORT="${PORT:-${LLAMA_ARG_PORT:-8080}}"
CONTEXT="${CONTEXT:-${LLAMA_ARG_CTX_SIZE:-262144}}"
KV_K="${KV_K:-${LLAMA_ARG_CACHE_TYPE_K:-q4_0}}"
KV_V="${KV_V:-${LLAMA_ARG_CACHE_TYPE_V:-q4_0}}"
NGL="${NGL:-${LLAMA_ARG_N_GPU_LAYERS:--1}}"
PARALLEL="${PARALLEL:-${LLAMA_ARG_N_PARALLEL:-2}}"
SPEC="${SPEC:-on}"
EXTRA_ARGS="${EXTRA_ARGS:-}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-900}"
API_KEY="${LLAMA_API_KEY:-${API_KEY:-}}"

if [ -z "$API_KEY" ]; then
    echo "ERROR: LLAMA_API_KEY (or API_KEY) is required; refusing to start an unauthenticated server" >&2
    exit 64
fi

# Never accept an arbitrary persistent model path. This image owns and wipes its
# private temporary directory; use MODEL_REPO/MODEL_FILE for model selection.
MODEL_PATH="$MODEL_DIR/$(basename -- "$MODEL_FILE")"

# Native llama.cpp settings. Security-sensitive persistence settings are forced,
# not merely defaulted, so an order-form variable cannot turn them back on.
export LLAMA_API_KEY="$API_KEY"
export LLAMA_ARG_MODEL="$MODEL_PATH"
export LLAMA_ARG_HOST="$HOST"
export LLAMA_ARG_PORT="$PORT"
export LLAMA_ARG_CTX_SIZE="$CONTEXT"
export LLAMA_ARG_CACHE_TYPE_K="$KV_K"
export LLAMA_ARG_CACHE_TYPE_V="$KV_V"
export LLAMA_ARG_FLASH_ATTN="${LLAMA_ARG_FLASH_ATTN:-on}"
export LLAMA_ARG_JINJA="${LLAMA_ARG_JINJA:-1}"
export LLAMA_ARG_N_GPU_LAYERS="$NGL"
export LLAMA_ARG_N_PARALLEL="$PARALLEL"
export LLAMA_ARG_KV_UNIFIED="${LLAMA_ARG_KV_UNIFIED:-1}"
export LLAMA_ARG_REASONING_EFFORT="${LLAMA_ARG_REASONING_EFFORT:-${REASONING_EFFORT:-$DEFAULT_REASONING_EFFORT}}"
export LLAMA_ARG_CORS_ORIGINS="${LLAMA_ARG_CORS_ORIGINS:-localhost}"

# Do not retain prompts, KV state, metrics, slot state or model mmap files.
export LLAMA_ARG_MMAP=0
export LLAMA_ARG_CACHE_PROMPT=0
export LLAMA_ARG_ENDPOINT_METRICS=0
export LLAMA_ARG_ENDPOINT_PROPS=0
export LLAMA_ARG_ENDPOINT_SLOTS=0
export LLAMA_ARG_UI=0
unset LLAMA_ARG_LOG_FILE LLAMA_ARG_LOG_PROMPTS_DIR LLAMA_ARG_SLOT_SAVE_PATH

if [ -z "${LLAMA_ARG_SPEC_TYPE:-}" ]; then
    if [ "$SPEC" = "on" ]; then
        export LLAMA_ARG_SPEC_TYPE="draft-mtp"
    else
        export LLAMA_ARG_SPEC_TYPE="none"
    fi
fi
export LLAMA_ARG_SPEC_DRAFT_N_MAX="${LLAMA_ARG_SPEC_DRAFT_N_MAX:-2}"

read -r -a EXTRA <<< "$EXTRA_ARGS"
for arg in "${EXTRA[@]}"; do
    case "$arg" in
        --api-key|--api-key=*|--api-key-file|--api-key-file=*|\
        -m|--model|--model=*|--model-url|--model-url=*|--hf-repo|--hf-repo=*|\
        --hf-file|--hf-file=*|--docker-repo|--docker-repo=*|\
        --log-file|--log-file=*|--log-prompts-dir|--log-prompts-dir=*|\
        --slot-save-path|--slot-save-path=*|--cache-prompt|--metrics|--props|\
        --slots|--ui|--webui)
            echo "ERROR: EXTRA_ARGS contains a forbidden credential, model-path or persistence option: $arg" >&2
            exit 64
            ;;
    esac
done

if [ "${DRY_RUN:-0}" = "1" ]; then
    printf 'model_repo=%q model_file=%q model_quant=%q host=%q port=%q ctx=%q kv_k=%q kv_v=%q ngl=%q parallel=%q spec=%q\n' \
        "$MODEL_REPO" "$MODEL_FILE" "$MODEL_QUANT" "$LLAMA_ARG_HOST" "$LLAMA_ARG_PORT" \
        "$LLAMA_ARG_CTX_SIZE" "$LLAMA_ARG_CACHE_TYPE_K" "$LLAMA_ARG_CACHE_TYPE_V" \
        "$LLAMA_ARG_N_GPU_LAYERS" "$LLAMA_ARG_N_PARALLEL" "$LLAMA_ARG_SPEC_TYPE"
    exit 0
fi

# Remove leftovers from an interrupted prior run before creating a new download.
rm -rf -- "$MODEL_DIR"
mkdir -p -- "$MODEL_DIR"
MODEL_TMP="${MODEL_PATH}.part.$$"
cleanup() {
    status=$?
    rm -rf -- "$MODEL_DIR"
    exit "$status"
}
forward_signal() {
    if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill -TERM "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT
trap forward_signal INT TERM HUP

CURL_ARGS=(--fail --location --show-error --retry 3 --retry-delay 2 -o "$MODEL_TMP")
if [ -n "${HF_TOKEN:-}" ]; then
    echo "ERROR: HF_TOKEN is intentionally unsupported for this untrusted-host image; use a public model URL" >&2
    exit 64
fi
if [ -n "$MODEL_URL" ]; then
    curl "${CURL_ARGS[@]}" "$MODEL_URL"
else
    curl "${CURL_ARGS[@]}" \
        "https://huggingface.co/${MODEL_REPO}/resolve/main/${MODEL_FILE}"
fi
mv -f -- "$MODEL_TMP" "$MODEL_PATH"

CMD=(/opt/bin/llama-server)
[ "${#EXTRA[@]}" -gt 0 ] && CMD+=("${EXTRA[@]}")
"${CMD[@]}" &
SERVER_PID=$!

# Wait until llama-server has loaded the model. /health is intentionally public
# in llama.cpp and contains no prompt or model content.
healthy=0
end_time=$((SECONDS + HEALTH_TIMEOUT))
while kill -0 "$SERVER_PID" 2>/dev/null; do
    if curl --fail --silent --max-time 2 "http://127.0.0.1:${LLAMA_ARG_PORT}/health" >/dev/null 2>&1; then
        healthy=1
        break
    fi
    if [ "$SECONDS" -ge "$end_time" ]; then
        break
    fi
    sleep 2
done
if [ "$healthy" -ne 1 ]; then
    echo "ERROR: llama-server did not become healthy within ${HEALTH_TIMEOUT}s" >&2
    exit 1
fi

# --no-mmap means the model has been read into process memory; unlink its file
# so a normal live container has no model file left on its writable layer.
rm -f -- "$MODEL_PATH" "$MODEL_TMP"
unset HF_TOKEN MODEL_URL

wait "$SERVER_PID"
