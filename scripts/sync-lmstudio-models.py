#!/usr/bin/env python3
"""
Fetch all models from LM Studio API on gaming-pc.lan:1234 and update
the pi-agent models.json with any newly discovered models.

Usage:
  python3 sync-lmstudio-models.py [--dry-run] [--models-json PATH]

Defaults:
  LM Studio URL: http://gaming-pc.lan:1234/v1/models
  models.json:   ~/.pi/agent/models.json

Only ADDS new models; never removes or reorders existing ones.
New models get auto-categorized with prefix tags like [LM-CD], [LM-RN], etc.
"""

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

# ── Defaults ───────────────────────────────────────────────────────────────
LMSTUDIO_API = "http://gaming-pc.lan:1234/v1/models"
MODELS_JSON  = str(Path.home() / ".pi" / "agent" / "models.json")

# ── Category logic (same as used for all providers) ─────────────────────────
PROVIDER_TAGS = {
    "openai": "OP", "google": "GO", "anthropic": "AN",
    "xiaomi": "XM", "openrouter": "OR", "ollama": "OL", "lmstudio": "LM",
}

def categorize(model_id: str, reasoning: bool = False, vision: bool = False) -> str:
    mid = model_id.lower()
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

def make_name(model_id: str) -> str:
    """Generate a human-readable prefixed name for a model."""
    # Heuristic: try to detect reasoning/vision from the model ID
    reasoning = any(x in model_id.lower() for x in
                    ("reasoning", "r1", "think", "flash", "qwq", "olmo"))
    vision = any(x in model_id.lower() for x in
                 ("vl", "vision", "gemma-4", "lfm", "devstral"))
    tag = categorize(model_id, reasoning, vision)
    return f"[LM-{tag}] {model_id} — auto-synced from LM Studio"

# ── Main ────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Sync pi-agent models.json with LM Studio API")
    parser.add_argument("--dry-run", action="store_true", help="Show changes without writing")
    parser.add_argument("--models-json", default=MODELS_JSON, help="Path to models.json")
    parser.add_argument("--prune", action="store_true", help="Remove models from config that are no longer in LM Studio API")
    args = parser.parse_args()

    # 1. Fetch LM Studio models
    print(f"Fetching models from {LMSTUDIO_API} …")
    try:
        with urllib.request.urlopen(LMSTUDIO_API, timeout=10) as resp:
            api_data = json.loads(resp.read())
    except Exception as e:
        print(f"ERROR: Cannot reach LM Studio API: {e}", file=sys.stderr)
        sys.exit(1)

    lm_models = [m["id"] for m in api_data.get("data", [])]
    print(f"  Found {len(lm_models)} models in LM Studio API")

    # 2. Load current models.json
    with open(args.models_json) as f:
        config = json.load(f)
    existing_ids = {m["id"] for m in config["providers"]["lmstudio"].get("models", [])}
    new_models = [mid for mid in lm_models if mid not in existing_ids]
    removed_models = [mid for mid in existing_ids if mid not in set(lm_models) and args.prune]

    if not new_models and not removed_models:
        print("  All models already in sync. Nothing to do.")
        return

    if removed_models:
        print(f"  Models to REMOVE from config (--prune): {len(removed_models)}")
        for mid in removed_models:
            print(f"    - {mid}")

    if new_models:
        print(f"  New models to add: {len(new_models)}")
        for mid in new_models:
            print(f"    + {mid}")

    if args.dry_run:
        print("\n[Dry run — no changes written]")
        return

    # 3. Remove pruned models from config
    if removed_models:
        config["providers"]["lmstudio"]["models"] = [
            m for m in config["providers"]["lmstudio"]["models"]
            if m["id"] not in removed_models
        ]

    # 4. Append new models
    for mid in new_models:
        config["providers"]["lmstudio"]["models"].append({
            "_launch": True,
            "contextWindow": 262144,
            "id": mid,
            "name": make_name(mid),
        })

    with open(args.models_json, "w") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

    summary = []
    if new_models:
        summary.append(f"added {len(new_models)}")
    if removed_models:
        summary.append(f"removed {len(removed_models)}")
    print(f"\n  {', '.join(summary)} → {args.models_json}")
    print(f"  Total LM Studio models: {len(config['providers']['lmstudio']['models'])}")

if __name__ == "__main__":
    main()
