#!/usr/bin/env python3
"""Run llama-server with a selectable public GGUF model.

The default profile is intentionally permissive for local development and
performance debugging: llama.cpp options, UI, mmap, prompt cache, logs and
metrics are not blocked. Set HARDEN=1 for the optional strict profile described
in README.md. API-key authentication remains required by default because the
usual Clore deployment exposes a public port.
"""

from __future__ import annotations

import os
import re
import shlex
import signal
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import NoReturn

DEFAULT_REPO = "unsloth/Qwen3.8-27B-GGUF"
DEFAULT_TEMPLATE = "Qwen3.8-27B-UD-{quant}.gguf"
DEFAULT_QUANT = "Q3_K_XL"
DEFAULT_REASONING_EFFORT = "high"
SERVER = "/opt/bin/llama-server"


def fail(message: str, code: int = 64) -> NoReturn:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(code)


def env_first(*names: str, default: str) -> str:
    for name in names:
        value = os.environ.get(name)
        if value is not None and value != "":
            return value
    return default


def bool_env(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    if value.lower() in {"1", "true", "yes", "on"}:
        return True
    if value.lower() in {"0", "false", "no", "off"}:
        return False
    fail(f"{name} must be 0/1, true/false, yes/no or on/off")


def validate_model_file(value: str) -> str:
    if not value or value.startswith("/") or "\\" in value or ".." in Path(value).parts:
        fail("MODEL_FILE must be a repository-relative path without '..'")
    return value


def resolve_model() -> tuple[str, str, str]:
    repo = env_first("MODEL_REPO", "REPO", default=DEFAULT_REPO)
    quant = env_first("MODEL_QUANT", default=DEFAULT_QUANT)
    template = env_first("MODEL_FILE_TEMPLATE", default=DEFAULT_TEMPLATE)
    if not re.fullmatch(r"[A-Za-z0-9_]+", quant):
        fail("MODEL_QUANT may contain only letters, digits and underscores")

    exact_file = os.environ.get("MODEL_FILE")
    model_file = exact_file if exact_file else template.replace("{quant}", quant)
    model_file = validate_model_file(model_file)

    direct_url = os.environ.get("MODEL_URL", "")
    if direct_url:
        parsed = urllib.parse.urlparse(direct_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            fail("MODEL_URL must be an absolute HTTP(S) URL")
        return repo, model_file, direct_url

    repo_path = urllib.parse.quote(repo, safe="/")
    file_path = urllib.parse.quote(model_file, safe="/")
    return repo, model_file, f"https://huggingface.co/{repo_path}/resolve/main/{file_path}"


def parse_extra() -> list[str]:
    try:
        return shlex.split(os.environ.get("EXTRA_ARGS", ""))
    except ValueError as exc:
        fail(f"EXTRA_ARGS is not valid shell-style quoting: {exc}")


def configure_environment(model_path: str | None, harden: bool) -> dict[str, str]:
    api_key = env_first("LLAMA_API_KEY", "API_KEY", default="")
    if bool_env("REQUIRE_API_KEY", True) and not api_key:
        fail("LLAMA_API_KEY (or API_KEY) is required; refusing to start an unauthenticated server")
    if not api_key:
        print("WARNING: API-key authentication is disabled; protect the listening port yourself", file=sys.stderr)

    env = dict(os.environ)
    env.pop("API_KEY", None)
    if api_key:
        env["LLAMA_API_KEY"] = api_key
    else:
        env.pop("LLAMA_API_KEY", None)
    if model_path is not None:
        env["LLAMA_ARG_MODEL"] = model_path

    # Native LLAMA_ARG_* variables win; aliases are only defaults.
    # Keep this a scalar. Clore's environment editor treats JSON braces as
    # template syntax and rejects values such as {"reasoning_effort":"high"}.
    # llama.cpp exposes the same setting through the dedicated scalar option.
    defaults = {
        "LLAMA_ARG_HOST": env_first("HOST", default="0.0.0.0"),
        "LLAMA_ARG_PORT": env_first("PORT", default="8080"),
        "LLAMA_ARG_CTX_SIZE": env_first("CONTEXT", default="262144"),
        "LLAMA_ARG_CACHE_TYPE_K": env_first("KV_K", default="q4_0"),
        "LLAMA_ARG_CACHE_TYPE_V": env_first("KV_V", default="q4_0"),
        "LLAMA_ARG_N_GPU_LAYERS": env_first("NGL", default="-1"),
        "LLAMA_ARG_N_PARALLEL": env_first("PARALLEL", default="2"),
        "LLAMA_ARG_FLASH_ATTN": "on",
        "LLAMA_ARG_JINJA": "1",
        "LLAMA_ARG_KV_UNIFIED": "1",
        "LLAMA_ARG_CORS_ORIGINS": "*",
        "LLAMA_ARG_REASONING_EFFORT": env_first("REASONING_EFFORT", default=DEFAULT_REASONING_EFFORT),
    }
    for name, value in defaults.items():
        env.setdefault(name, value)
    # Do not set LLAMA_ARG_CHAT_TEMPLATE_KWARGS by default. It is still
    # available for model-specific JSON values when the deployment UI accepts
    # them, but reasoning_effort must use LLAMA_ARG_REASONING_EFFORT here.

    if harden:
        # Optional strict profile for untrusted rented hosts. It is deliberately
        # opt-in because these settings hinder local debugging and performance work.
        env["LLAMA_ARG_MMAP"] = "0"
        env["LLAMA_ARG_CACHE_PROMPT"] = "0"
        env["LLAMA_ARG_ENDPOINT_METRICS"] = "0"
        env["LLAMA_ARG_ENDPOINT_PROPS"] = "0"
        env["LLAMA_ARG_ENDPOINT_SLOTS"] = "0"
        env["LLAMA_ARG_UI"] = "0"
        env["LLAMA_ARG_CORS_ORIGINS"] = "localhost"
        env["LLAMA_ARG_LOG_VERBOSITY"] = "1"

    if "LLAMA_ARG_SPEC_TYPE" not in env:
        env["LLAMA_ARG_SPEC_TYPE"] = "draft-mtp" if env_first("SPEC", default="on") == "on" else "none"
    env.setdefault("LLAMA_ARG_SPEC_DRAFT_N_MAX", "2")
    return env


def ensure_model_with_hf_cli(repo: str, model_file: str, token: str) -> str:
    """Download once into persistent storage and return the local model path."""
    model_dir = Path(os.environ.get("MODEL_DIR", "/models"))
    model_dir.mkdir(parents=True, exist_ok=True)
    model_path = model_dir / model_file
    if model_path.exists() and model_path.stat().st_size > 0:
        print(f"Using persisted model {model_path}", flush=True)
        return str(model_path)

    command = [
        "hf", "download", repo, model_file,
        "--repo-type", "model",
        "--local-dir", str(model_dir),
    ]
    env = dict(os.environ)
    if token:
        env["HF_TOKEN"] = token
    print(f"Downloading {repo}/{model_file} with Hugging Face CLI into {model_dir}", flush=True)
    try:
        subprocess.run(command, env=env, check=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        fail(f"Hugging Face CLI download failed: {exc}", 1)
    if not model_path.exists() or model_path.stat().st_size == 0:
        fail(f"Hugging Face CLI did not create {model_path}", 1)
    return str(model_path)



def wait_healthy(process: subprocess.Popen[bytes], port: str, timeout: int) -> None:
    deadline = time.monotonic() + timeout
    health_url = f"http://127.0.0.1:{port}/health"
    while process.poll() is None and time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(health_url, timeout=2) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(2)
    if process.poll() is not None:
        fail(f"llama-server exited before becoming healthy (status {process.returncode})", 1)
    fail(f"llama-server did not become healthy within {timeout}s", 1)


def stop_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=15)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def print_dry_run() -> int:
    repo, model_file, _ = resolve_model()
    api_key = env_first("LLAMA_API_KEY", "API_KEY", default="")
    if bool_env("REQUIRE_API_KEY", True) and not api_key:
        fail("LLAMA_API_KEY (or API_KEY) is required")
    parse_extra()
    print(
        "mode=%s require_api_key=%s model_repo=%s model_file=%s quant=%s host=%s port=%s ctx=%s kv_k=%s kv_v=%s parallel=%s spec=%s"
        % (
            "hardened" if bool_env("HARDEN", False) else "permissive",
            bool_env("REQUIRE_API_KEY", True),
            repo,
            model_file,
            env_first("MODEL_QUANT", default=DEFAULT_QUANT),
            env_first("HOST", "LLAMA_ARG_HOST", default="0.0.0.0"),
            env_first("PORT", "LLAMA_ARG_PORT", default="8080"),
            env_first("CONTEXT", "LLAMA_ARG_CTX_SIZE", default="262144"),
            env_first("KV_K", "LLAMA_ARG_CACHE_TYPE_K", default="q4_0"),
            env_first("KV_V", "LLAMA_ARG_CACHE_TYPE_V", default="q4_0"),
            env_first("PARALLEL", "LLAMA_ARG_N_PARALLEL", default="2"),
            env_first("SPEC", default="on"),
        )
    )
    return 0


def main() -> int:
    if os.environ.get("DRY_RUN") == "1":
        return print_dry_run()

    if not bool_env("START_SERVER", True):
        print("START_SERVER=0: llama-server is not started; container remains active for SSH administration", flush=True)
        while True:
            signal.pause()
        return 0

    harden = bool_env("HARDEN", False)
    download_model = bool_env("MODEL_DOWNLOAD", True)
    repo = model_file = ""
    process: subprocess.Popen[bytes] | None = None

    if download_model:
        repo, model_file, _ = resolve_model()
    extra = parse_extra()
    if not download_model and not os.environ.get("LLAMA_ARG_MODEL") and not os.environ.get("MODEL_PATH"):
        fail("MODEL_DOWNLOAD=0 requires LLAMA_ARG_MODEL or MODEL_PATH")

    token = os.environ.get("HF_TOKEN", "")
    try:
        if download_model:
            model_path = ensure_model_with_hf_cli(repo, model_file, token)
        else:
            model_path = os.environ.get("LLAMA_ARG_MODEL") or os.environ["MODEL_PATH"]

        env = configure_environment(model_path, harden)
        port = env["LLAMA_ARG_PORT"]
        timeout = int(os.environ.get("HEALTH_TIMEOUT", "1800"))
        command = [SERVER, *extra]
        if harden:
            command.append("--log-disable")
        child_output = subprocess.DEVNULL if harden else None
        process = subprocess.Popen(
            command,
            env=env,
            start_new_session=True,
            stdout=child_output,
            stderr=child_output,
        )

        def handle_signal(signum: int, _frame: object) -> None:
            if process is not None:
                stop_process(process)
            raise SystemExit(128 + signum)

        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(signum, handle_signal)

        wait_healthy(process, port, timeout)
        print(
            "llama-server is healthy (%s mode); model persists at %s"
            % ("hardened" if harden else "permissive", model_path),
            flush=True,
        )
        return process.wait()
    finally:
        if process is not None:
            stop_process(process)


if __name__ == "__main__":
    main()
