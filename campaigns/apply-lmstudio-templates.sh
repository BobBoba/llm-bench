#!/usr/bin/env bash
# Apply the official Qwen chat templates into LM Studio's per-model default configs on the
# LM Studio host (gaming-pc), so tool-calling works via the OpenAI-compat API.
#
# Method: pull each per-model config JSON, rewrite llm.load.promptTemplate with PYTHON
# (reliable JSON — Windows PowerShell 5.1 ConvertTo-Json bloats the string ~360x and hangs),
# push it back via scp. Then `lms unload --all` so the next load picks up the template.
#
# RESULT (see [[lmstudio-qwen-tool-templates]]):
#   * instruct (Hermes template) -> LM Studio parses tool calls NATIVELY (finish=tool_calls). Fixed.
#   * coder    (XML template)     -> template no longer doubles <tool_call> and output lands in
#                                    content, but LM Studio's parser still won't emit tool_calls
#                                    for the <function=...> XML -> the run-ts.mjs fallback covers it.
#
# Usage:  bash apply-lmstudio-templates.sh          (edit HOST / paths below if they move)
set -euo pipefail

HOST="gaming-pc"
BASE="C:/Users/vlad/.lmstudio/.internal/user-concrete-model-default-config"
TPLDIR="$(cd "$(dirname "$0")/templates" && pwd)"
CODER="$TPLDIR/qwen3-coder-chat-template.jinja"
HERMES="$TPLDIR/qwen3-instruct-hermes-chat-template.jinja"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# model-config-subpath   template-file
MAP=(
  "qwen/qwen3-coder-30b.json|$CODER"
  "rafw007/qwen36-a3b-claude-coder-llama.cpp-GGUF/qwen36-a3b-claude-coder-q4_K_M-llama.cpp.gguf.json|$CODER"
  "qwen/qwen3-30b-a3b-2507.json|$HERMES"
  "qwen/qwen3.6-27b.json|$HERMES"
  "llmfan46/Qwen3.6-35B-A3B-uncensored-heretic-Native-MTP-Preserved-NVFP4-Experts-Only-GGUF/Qwen3.6-35B-A3B-uncensored-heretic-Native-MTP-Preserved-NVFP4-Experts-Only-Q8_0.gguf.json|$HERMES"
)

for entry in "${MAP[@]}"; do
  sub="${entry%%|*}"; tpl="${entry##*|}"
  local_json="$TMP/$(echo "$sub" | tr '/' '_')"
  scp -q "$HOST:$BASE/$sub" "$local_json"
  python3 - "$local_json" "$tpl" <<'PY'
import json, sys
cfg, tplf = sys.argv[1], sys.argv[2]
d = json.load(open(cfg)); tpl = open(tplf).read()
found = False
for f in d["load"]["fields"]:
    if f["key"] == "llm.load.promptTemplate":
        f["value"] = {"type": "jinja", "jinjaPromptTemplate": {"template": tpl}}; found = True
if not found:
    d["load"]["fields"].append({"key": "llm.load.promptTemplate",
                                "value": {"type": "jinja", "jinjaPromptTemplate": {"template": tpl}}})
json.dump(d, open(cfg, "w"), ensure_ascii=False, indent=2)
print(f"  {sub_disp}: size={len(open(cfg).read())} tpl={len(tpl)}".replace("sub_disp", cfg.split('/')[-1]))
PY
  scp -q "$local_json" "$HOST:$BASE/$sub"
  echo "  pushed: $sub"
done

echo "unloading models so the new templates take effect on next load:"
ssh "$HOST" "lms unload --all"
echo "DONE."
