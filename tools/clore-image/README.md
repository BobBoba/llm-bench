# Generic CUDA llama-server image

Image: `docker.io/bobboba/llama-server:cuda13`

A generic CUDA 13 `llama-server` image for x86-64 NVIDIA GPUs, including RTX 5090/Blackwell (`sm_120a`). It supports runtime model/quant selection and native llama.cpp configuration through Docker environment variables.

## Operating profiles

The default is **permissive**. This is intentional: UI, mmap, prompt cache, logs, metrics, and other llama.cpp features remain available for local development, debugging, profiling, and maximum performance tuning.

Authentication is still required by default because Clore normally exposes the server on a public port:

```text
LLAMA_API_KEY=<long-random-key>
```

To use the optional strict profile on an untrusted rental host:

```text
HARDEN=1
LLAMA_API_KEY=<long-random-key>
```

`HARDEN=1` sets `mmap=off`, disables prompt cache, metrics, props, slots and UI, limits CORS to localhost, suppresses llama-server output, and discards its stdout/stderr. It does not provide confidential computing: a third-party host operator can still inspect process memory, GPU VRAM, file descriptors, the container runtime, kernel activity, and network traffic. Never send passwords or other secrets to hardware you do not trust.

For a private trusted server, developers may explicitly disable endpoint authentication:

```text
REQUIRE_API_KEY=0
```

Do this only when the network boundary is already protected by a firewall, VPN, SSH tunnel or equivalent. An exposed unauthenticated server can be used by anyone who finds the port and can generate unexpected GPU costs.

## Clore deployment

- **Docker Image:** `bobboba/llama-server:cuda13`
- **Port:** `8080`
- **GPU:** enable NVIDIA GPU access
- **Recommended:** `LLAMA_API_KEY=<long-random-value>`
- **HF download:** set `HF_TOKEN=<read-only Hugging Face token>` when using the CLI downloader
- **Persistent model directory:** `/models` (mount persistent disk storage there)
- **Optional hardening:** `HARDEN=1`

The launcher uses the official Hugging Face CLI (`hf download`) and stores the model at `/models/<filename>` by default. On restart it reuses an existing non-empty file and does not download it again. Without a persistent `/models` mount, the directory persists only for the lifetime of the container.

The Clore environment field is not a secret store. Assume the host operator can read every environment variable, including API keys and Hugging Face tokens. Use a dedicated read-only token and revoke it after an untrusted rental.

Do not set `HF_TOKEN` unless you explicitly trust the host. It is visible to the host operator.

To start the container immediately and launch `llama-server` manually over SSH, set:

```text
START_SERVER=0
MODEL_DOWNLOAD=0
```

With `START_SERVER=0`, the launcher does not download a model and does not start `llama-server`; it keeps PID 1 alive for SSH administration. After connecting, use the existing model path or download one with `hf download`, then start `/opt/bin/llama-server` manually. This mode is intended for diagnosis and manual control, not for an unauthenticated public endpoint.

For manual model downloads over SSH, the image includes `/opt/download-model.sh`:

```bash
export HF_TOKEN='your-read-only-token'
MODEL_REPO=unsloth/Qwen3.8-27B-GGUF \
MODEL_FILE=Qwen3.8-27B-UD-Q3_K_XL.gguf \
MODEL_DIR=/models \
/opt/download-model.sh
unset HF_TOKEN
```

Typical configuration:

```text
LLAMA_API_KEY=<long-random-api-key>
MODEL_REPO=unsloth/Qwen3.8-27B-GGUF
MODEL_QUANT=Q3_K_XL
CONTEXT=262144
KV_K=q4_0
KV_V=q4_0
PARALLEL=2
SPEC=on
```

## SSH access on Clore

The image intentionally does not contain `sshd`; Clore must provide it through its deployment entrypoint. In the Clore order configuration use:

```text
autossh_entrypoint=true
Port 22: TCP
Port 8080: HTTP
```

Provide either `ssh_key` or a temporary `ssh_password`. Do not expose port 22 as HTTP. The Clore entrypoint adds SSH and runs the image startup command; `llama-server` remains the service on port 8080.

If `autossh_entrypoint=true` is already enabled but port 22 resets, the problem is on the Clore startup/entrypoint path rather than the llama-server binary. Check that the order has a non-empty `ssh_key` or `ssh_password`, that port 22 is TCP, and that the container is Active rather than Creating.

The official upstream `ghcr.io/ggml-org/llama.cpp:server-cuda13` image is also SSH-free, so switching to it does not remove the need for Clore's SSH entrypoint.

## Model and quantization selection

Default repository: [`unsloth/Qwen3.8-27B-GGUF`](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF).

Default file template:

```text
Qwen3.8-27B-UD-{MODEL_QUANT}.gguf
```

Available quantizations include:

| `MODEL_QUANT` | Approx. size | 32 GB / 256k KV |
|---|---:|---|
| `IQ1_M` | 6.7 GB | comfortable, low quality |
| `IQ1_S` | 6.2 GB | comfortable, low quality |
| `IQ2_S` | 8.4 GB | comfortable |
| `IQ2_XXS` | 7.3 GB | comfortable |
| `IQ3_S` | 12.0 GB | comfortable |
| `IQ3_XXS` | 10.9 GB | comfortable |
| `Q2_K_XL` | 9.8 GB | comfortable |
| `Q3_K_XL` | 13.1 GB | current configuration |
| `IQ4_XS` | 14.3 GB | comfortable |
| `Q4_K_S` | 15.4 GB | test VRAM before 256k |
| `Q4_K_M` | 16.5 GB | test VRAM before 256k |
| `Q4_K_XL` | 17.6 GB | limited KV headroom |
| `Q5_K_S` | 18.7 GB | limited KV headroom |
| `Q5_K_M` | 19.8 GB | limited KV headroom |
| `Q5_K_XL` | 20.9 GB | limited KV headroom |
| `Q6_K` | 22.0 GB | generally too large for 256k |
| `Q6_K_M` | 23.1 GB | generally too large for 256k |
| `Q6_K_L` | 24.2 GB | generally too large for 256k |
| `Q6_K_XL` | 25.3 GB | generally too large for 256k |
| `Q8_K_L` | 28.0 GB | not suitable |
| `Q8_K_XL` | 31.5 GB | not suitable |

Model weights and KV cache share VRAM. Test the selected quantization with the requested context; weight size alone is not enough.

For another public repository:

```text
MODEL_REPO=some-user/some-GGUF
MODEL_FILE=some-model-Q4_K_M.gguf
```

`MODEL_FILE` is a repository-relative filename. `MODEL_URL` may be a public HTTP(S) URL. Set `MODEL_DOWNLOAD=0` and `LLAMA_ARG_MODEL=/models/model.gguf` when the model is already mounted on a trusted server.

## llama.cpp configuration

The launcher passes all documented native `LLAMA_ARG_*` variables. Wrapper aliases are available for common settings:

```text
LLAMA_ARG_CTX_SIZE=262144
LLAMA_ARG_N_PARALLEL=2
LLAMA_ARG_CACHE_TYPE_K=q4_0
LLAMA_ARG_CACHE_TYPE_V=q4_0
LLAMA_ARG_N_GPU_LAYERS=-1
LLAMA_ARG_FLASH_ATTN=on
LLAMA_ARG_SPEC_TYPE=draft-mtp
LLAMA_ARG_SPEC_DRAFT_N_MAX=2
LLAMA_ARG_REASONING_EFFORT=high
LLAMA_ARG_UI=1
LLAMA_ARG_LOG_FILE=/tmp/llama.log
```

For reasoning control use the scalar variable. If it is omitted, this image uses `high` by default:

```text
LLAMA_ARG_REASONING_EFFORT=high
```

You may override it with `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `default`.

Do **not** enter this JSON value in the Clore environment editor:

```text
{"reasoning_effort":"high"}
```

Clore treats braces in saved order-template values as template syntax and may report `Invalid template data`. `LLAMA_ARG_REASONING_EFFORT` is the native llama.cpp equivalent.

`LLAMA_ARG_CHAT_TEMPLATE_KWARGS` remains available for other model-specific JSON settings, but the image no longer inserts it by default.

In permissive mode, `EXTRA_ARGS` can pass additional llama.cpp flags, for example:

```text
EXTRA_ARGS=--no-mmap --metrics --verbose
```

Do not put an API key in `EXTRA_ARGS`; use `LLAMA_API_KEY`.

## Hardening guide

For an untrusted third-party GPU host:

1. Set `HARDEN=1`.
2. Keep `LLAMA_API_KEY` enabled and rotate it after the rental.
3. Do not set `HF_TOKEN`; use a public model repository or public direct URL.
4. Do not enable `MODEL_DOWNLOAD=0` with a host-mounted private model unless the host is trusted.
5. Keep only port `8080` exposed; do not expose SSH, Jupyter, Docker or debugging ports.
6. Put the endpoint behind a VPN or TLS reverse proxy when possible. API keys alone do not encrypt traffic.
7. Do not send passwords, private tokens or confidential prompts. `HARDEN=1` reduces application-level persistence but cannot stop the host operator from reading live RAM/VRAM or traffic.
8. Delete the Clore rental and rotate all credentials immediately after use.

## Client request

```bash
curl http://<clore-host>:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <same-api-key>' \
  -d '{
    "model": "Qwen3.8-27B",
    "messages": [{"role":"user","content":"Hello"}],
    "max_tokens": 256
  }'
```

OpenAI-compatible clients use `api_key=<same-api-key>` and `http://<clore-host>:8080/v1`.

## Local dry run

```bash
docker run --rm \
  -e DRY_RUN=1 \
  -e LLAMA_API_KEY='test-only' \
  -e MODEL_QUANT=Q4_K_M \
  -e LLAMA_ARG_CTX_SIZE=32768 \
  bobboba/llama-server:cuda13
```

The dry run does not download a model or start a server.

## Rebuilding

The Dockerfile builds `ggml-org/llama.cpp` master with CUDA 13 and `86-real;120a-real` kernels. The image contains no model weights and no credentials. Pin the llama.cpp commit for reproducible production rebuilds.
