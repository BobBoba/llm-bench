#!/usr/bin/env python3
"""
Add a single model to pi-agent models.json quickly.

Usage:
  python3 add-model.py <provider> <model-id> [--name "Custom Name"] [--reasoning] [--vision]

Examples:
  python3 add-model.py lmstudio qwen/qwen3.6-27b
  python3 add-model.py ollama gemma4:31b --reasoning --vision
  python3 add-model.py openrouter z-ai/glm-5.3 --reasoning --name "GLM 5.3 — new release"
"""

import argparse
import json
import os
import sys
from pathlib import Path

MODELS_JSON = str(Path.home() / ".pi" / "agent" / "models.json")

PROVIDER_DEFAULTS = {
    "openai":     {"api": "openai-completions", "baseUrl": "https://api.openai.com/v1"},
    "google":     {"api": "google-generative-ai", "baseUrl": "https://generativelanguage.googleapis.com/v1beta"},
    "anthropic":  {"api": "anthropic-messages", "baseUrl": "https://api.anthropic.com"},
    "xiaomi":     {"api": "openai-completions", "baseUrl": "https://token-plan-ams.xiaomimimo.com/v1"},
    "openrouter": {"api": "openai-completions", "baseUrl": "https://openrouter.ai/api/v1"},
    "ollama":     {"api": "openai-completions", "baseUrl": "http://gaming-pc.lan:11434/v1"},
    "lmstudio":   {"api": "openai-completions", "baseUrl": "http://gaming-pc.lan:1234/v1"},
}

PROV_TAG = {"openai": "OP", "google": "GO", "anthropic": "AN",
            "xiaomi": "XM", "openrouter": "OR", "ollama": "OL", "lmstudio": "LM"}

def categorize(mid: str, reasoning: bool, vision: bool) -> str:
    mid = mid.lower()
    if "embed" in mid:
        return "EM"
    if any(x in mid for x in ("coder", "-code")):
        return "CD"
    if reasoning and vision:
        return "RV"
    if reasoning:
        return "RN"
    if vision:
        return "VM"
    return "GP"

def main():
    parser = argparse.ArgumentParser(description="Add a model to pi-agent models.json")
    parser.add_argument("provider", help="Provider name (openai, lmstudio, ollama, openrouter, ...)")
    parser.add_argument("model_id", help="Model ID (e.g. qwen/qwen3.6-27b)")
    parser.add_argument("--name", help="Custom display name")
    parser.add_argument("--reasoning", action="store_true", help="Model supports reasoning")
    parser.add_argument("--vision", action="store_true", help="Model supports vision/image input")
    parser.add_argument("--context", type=int, default=262144, help="Context window size (default: 262144)")
    parser.add_argument("--models-json", default=MODELS_JSON, help="Path to models.json")
    parser.add_argument("--no-launch", action="store_true", help="Don't auto-launch this model")
    args = parser.parse_args()

    if args.provider not in PROVIDER_DEFAULTS:
        print(f"ERROR: Unknown provider '{args.provider}'. Known: {list(PROVIDER_DEFAULTS)}", file=sys.stderr)
        sys.exit(1)

    # Load config
    with open(args.models_json) as f:
        config = json.load(f)

    if args.provider not in config["providers"]:
        print(f"ERROR: Provider '{args.provider}' not found in models.json", file=sys.stderr)
        print(f"  Available: {list(config['providers'])}", file=sys.stderr)
        sys.exit(1)

    prov = config["providers"][args.provider]

    # Check for duplicates
    for m in prov.get("models", []):
        if m["id"] == args.model_id:
            print(f"Model '{args.model_id}' already exists in {args.provider}. Skipping.")
            return

    # Build model entry
    pfx = PROV_TAG.get(args.provider, args.provider[:2].upper())
    tag = categorize(args.model_id, args.reasoning, args.vision)
    short_id = args.model_id.split("/")[-1] if "/" in args.model_id else args.model_id

    if args.name:
        display_name = args.name
    else:
        display_name = f"{short_id} — auto-added to {args.provider}"

    full_name = f"[{pfx}-{tag}] {display_name}"

    entry = {
        "_launch": not args.no_launch,
        "contextWindow": args.context,
        "id": args.model_id,
        "name": full_name,
    }

    if args.vision or args.reasoning:
        entry["input"] = ["text"]
        if args.vision:
            entry["input"].append("image")
    if args.reasoning:
        entry["reasoning"] = True

    prov["models"].append(entry)

    with open(args.models_json, "w") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

    print(f"Added to {args.provider}: {full_name}")
    print(f"  ID:  {args.model_id}")
    print(f"  ctx: {args.context:,}")
    if args.reasoning:
        print(f"  reasoning: ✓")
    if args.vision:
        print(f"  vision: ✓")

if __name__ == "__main__":
    main()
