#!/usr/bin/env python3
"""
Re-apply provider-type prefix tags to all model names in pi-agent models.json.

System:
  [PROVIDER-TYPE] id — description

  Provider tags:
    OP = OpenAI       GO = Google       AN = Anthropic
    XM = Xiaomi       OR = OpenRouter   OL = Ollama
    LM = LM Studio

  Type tags:
    CD = Coder/Agentic      RN = Reasoning/Math
    RV = Reasoning+Vision   GP = General Purpose
    EM = Embedding

Usage:
  python3 prefix-models.py [--dry-run] [--models-json PATH]

This is idempotent — re-running it on already-prefixed names is harmless.
"""

import argparse
import json
import os
import sys
from pathlib import Path

MODELS_JSON = str(Path.home() / ".pi" / "agent" / "models.json")

# ── Provider tags ───────────────────────────────────────────────────────────
PROV_TAG = {
    "openai": "OP", "google": "GO", "anthropic": "AN",
    "xiaomi": "XM", "openrouter": "OR", "ollama": "OL", "lmstudio": "LM",
}

# ── Category logic ──────────────────────────────────────────────────────────
def categorize(model_id: str, reasoning: bool = False, has_vision: bool = False) -> str:
    """Return a type tag (CD/RN/RV/GP/EM) based on model characteristics."""
    mid = str(model_id).lower()
    if "embed" in mid:
        return "EM"
    if any(x in mid for x in ("coder", "-code")):
        return "CD"
    if reasoning and has_vision:
        return "RV"
    if reasoning:
        return "RN"
    if has_vision:
        return "VM"
    return "GP"

# ── Description templates per provider ──────────────────────────────────────
# Maps model ID -> short description (without prefix tag)
DESCRIPTIONS = {
    # OpenAI
    "openai": {
        "gpt-5.4": "gpt-5.4 — frontier reasoning + vision, 1M ctx",
    },
    # Google
    "google": {
        "gemini-3.1-pro-preview": "gemini-3.1-pro — frontier reasoning + vision, 1M ctx",
    },
    # Anthropic
    "anthropic": {
        "claude-opus-4-8": "claude-opus-4-8 — самый сильный reasoning (2026)",
        "claude-opus-4-7": "claude-opus-4-7 — предыдущий флагман",
        "claude-haiku-4-5": "claude-haiku-4-5 — быстрый, дешёвый",
        "claude-sonnet-4-6": "claude-sonnet-4-6 — баланс скорости и качества",
    },
    # Xiaomi
    "xiaomi": {
        "mimo-v2.5-pro": "mimo-v2.5-pro — мультимодал, 1M ctx",
        "mimo-v2.5": "mimo-v2.5 — базовая без reasoning",
    },
    # OpenRouter
    "openrouter": {
        "xiaomi/mimo-v2.5-pro": "mimo-v2.5-pro — мультимодал, 1M ctx (OpenRouter)",
        "deepseek/deepseek-v3.2": "deepseek-v3.2 — ДЕФОЛТ value-king: бенч 96% @ $0.0014",
        "deepseek/deepseek-v4-pro": "deepseek-v4-pro — архитектура, 1M ctx (цена упала в 3x)",
        "deepseek/deepseek-v4-flash": "deepseek-v4-flash — дешёвый агентный (AA 46.5)",
        "qwen/qwen3-235b-a22b-2507": "qwen3-235b — бюджетный универсал ($0.10 blend)",
        "moonshotai/kimi-k2.6": "kimi-k2.6 — топ агентный / tool-use (200-300 вызовов)",
        "openai/gpt-oss-120b": "gpt-oss-120b — бюджет, чистая юрисдикция (США)",
        "qwen/qwen3-coder": "qwen3-coder-480b — агентный кодер (tool-loop 9с/$0.0008)",
        "z-ai/glm-5.2": "glm-5.2 — 1M ctx, топ open-weight (бенч [[10.06.2026]])",
        "z-ai/glm-5.1": "glm-5.1 — legacy (prefer 5.2)",
        "minimax/minimax-m3": "minimax-m3 — 1M ctx, vision (основная модель агентов)",
    },
    # Ollama
    "ollama": {
        "SimonPu/qwen3-coder:30B-Instruct_Q4_K_XL": "qwen3-coder-30b-q4 — основной локальный кодер",
        "glm-4.7-flash": "glm-4.7-flash — быстрый open-weight reasoning",
        "qwen3.5": "qwen3.5 — мультимодальная (LLM)",
        "qwen3.5:27b": "qwen3.5-27b — специализированная (LLM)",
        "devstral-small-2:24b": "devstral-small-2 — лёгкий мультимодал",
        "gpt-oss:20b": "gpt-oss-20b — open-source от OpenAI",
        "hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:UD-Q4_K_XL": "qwen3-coder-30b-a3b — MoE быстрый local",
        "llama3.1": "llama3.1 — базовый универсал",
        "michaelneale/deepseek-r1-goose": "deepseek-r1-goose — reasoning variant",
        "ministral-3:14b": "ministral-3-14b — малый reasoning + vision",
        "mistral": "mistral — базовый (LLM)",
        "nemotron-3-nano:30b": "nemotron-3-nano — лёгкий general + reasoning",
        "nemotron-cascade-2:30b": "nemotron-cascade-2 — reasoning agent",
        "nomic-embed-text": "nomic-embed-text — embedding (LLM)",
        "qwen2.5-coder:14b": "qwen2.5-coder-14b — старый кодер",
        "qwen3-coder:30b": "qwen3-coder-30b — основной кодер (LLM)",
        "qwen3-vl:32b": "qwen3-vl-32b — визуальная модель + reasoning",
        "robbiemu/qwen3-coder:30b-a3b-i-q4_K_XL": "qwen3-coder-30b-a3b (robziem) — MoE кодер",
        "gemma4:31b": "gemma4-31b — reasoning + vision",
        "lfm2:24b": "lfm2-24b — мультимодальная",
    },
    # LM Studio — auto-generated for unknown IDs
    "lmstudio": {
        "ornith-1.0-35b": "ornith-1.0-35b — MoE agentic coding, self-scaffolding RL",
        "vibethinker-3b": "vibethinker-3b — AIME 94.3 на 3B params",
        "ornith-1.0-9b": "ornith-1.0-9b — edge-friendly coding agent",
        "qwen/qwen3.6-27b": "qwen3.6-27b — best local coding/reasoning",
        "google/gemma-4-26b-a4b-qat": "gemma-4-26b-a4b — MoE A4B, vision + reasoning",
        "gemma-4-12b-coder-fable5-composer2.5-v1": "gemma-4-12b-coder — лёгкий кодер",
        "zai-org/glm-4.7-flash": "glm-4.7-flash — быстрый open-weight reasoning",
        "text-embedding-nomic-embed-text-v1.5": "nomic-embed-v1.5 — embedding (не chat)",
        "mistralai/devstral-small-2-2512": "devstral-small-2 — мультимодал, мультиязык",
        "allenai/olmo-3-32b-think": "olmo-3-32b — reasoning/thinking",
        "qwen/qwen3-coder-30b": "qwen3-coder-30b — code-focused",
        "mistralai/ministral-3-14b-reasoning": "ministral-3-14b — малый reasoning",
        "essentialai/rnj-1": "essentialai-rnj-1 — general purpose",
        "qwen/qwen3-30b-a3b-2507": "qwen3-30b-a3b — MoE быстрый decode",
        "bytedance/seed-oss-36b": "seed-oss-36b — general purpose",
        "qwen/qwq-32b": "qwq-32b — reasoning/thinking",
        "nvidia/nemotron-3-nano": "nemotron-3-nano — лёгкий general",
        "openai/gpt-oss-20b": "gpt-oss-20b — open-source от OpenAI",
        "qwen36-a3b-claude-coder-llama.cpp": "qwen3.6-claude-coder-a3b — MoE coding agent (llama.cpp quant)",
    },
}

# ── Main ────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Re-apply prefix tags to all model names")
    parser.add_argument("--dry-run", action="store_true", help="Show changes without writing")
    parser.add_argument("--models-json", default=MODELS_JSON, help="Path to models.json")
    args = parser.parse_args()

    with open(args.models_json) as f:
        config = json.load(f)

    changed = 0
    for prov_name, prov in config["providers"].items():
        pfx = PROV_TAG.get(prov_name, prov_name[:2].upper())
        desc_map = DESCRIPTIONS.get(prov_name, {})

        for model in prov.get("models", []):
            mid = model["id"]
            reasoning = bool(model.get("reasoning", False))
            vision = "image" in (model.get("input") or [])
            tag = categorize(mid, reasoning, vision)

            if mid in desc_map:
                desc = desc_map[mid]
            else:
                # Auto-generate description for unknown models
                desc = f"{mid.split('/')[-1]} — auto (LM Studio/Ollama)"

            new_name = f"[{pfx}-{tag}] {desc}"
            old_name = model.get("name", "")
            model["name"] = new_name

            if old_name != new_name:
                changed += 1
                if args.dry_run:
                    print(f"  {prov_name}/{mid}")
                    print(f"    - {old_name}")
                    print(f"    + {new_name}")

    if args.dry_run:
        print(f"\n[Dry run — {changed} names would change]")
        return

    with open(args.models_json, "w") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

    print(f"Updated {changed} model names in {args.models_json}")
    print(f"Total models: {sum(len(p.get('models',[])) for p in config['providers'].values())}")

if __name__ == "__main__":
    main()