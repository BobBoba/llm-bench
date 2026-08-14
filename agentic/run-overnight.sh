#!/usr/bin/env bash
# Overnight agentic app-building matrix: 3 tasks x 3 models.
# Local qwen (stand) + cloud DS-v3.2 / DS-v4-pro (OpenRouter, cost-capped).
# Each result -> results/<task>__<model>.json (incremental, survives interruption).
set -uo pipefail
cd /code/work/llm-bench/agentic
export LLAMA_SERVER_BASE="http://192.168.89.53:8080/v1" MAX_STEPS=30 WALL_CAP_MIN=30 RUN_TIMEOUT_S=90

# OpenRouter inference key for cloud runs (removed at the end).
secret-tool lookup Title "OpenRouter API key" > /tmp/.orkey 2>/dev/null; chmod 600 /tmp/.orkey

run() { # task model client costcap
  local t="$1" m="$2" c="$3" cap="${4:-6}"
  echo "############ $(date '+%H:%M:%S')  $t / $m  (cap \$$cap) ############"
  timeout 2400 node agentic-app-bench.mjs "$t" "$m" "$c" "$cap" 2>&1 \
    | grep -E "^DONE |aborted|step (5|10|15|20|25|30):" | tail -8
}

TASKS=(calc kvstore todo-api)

# 1) LOCAL qwen (calc already done by pilot -> skip if result exists)
for t in "${TASKS[@]}"; do
  [ -f "results/${t}__qwen3-coder-next.json" ] && { echo "skip $t/qwen (done)"; continue; }
  run "$t" qwen3-coder-next local
done

# 2) CLOUD DeepSeek-v3.2 (cheap)
for t in "${TASKS[@]}"; do run "$t" deepseek/deepseek-v3.2 openrouter 2.5; done

# 3) CLOUD DeepSeek-v4-pro (heavy reasoner -> tighter per-task cap)
for t in "${TASKS[@]}"; do run "$t" deepseek/deepseek-v4-pro openrouter 4; done

rm -f /tmp/.orkey
echo "============ ALL_DONE $(date '+%H:%M:%S') ============"
# Aggregate
node -e '
const fs=require("fs"),d="results";
const rows=fs.readdirSync(d).filter(f=>/__/.test(f)&&f.endsWith(".json")).map(f=>JSON.parse(fs.readFileSync(d+"/"+f,"utf8")));
rows.sort((a,b)=>(a.task+a.model).localeCompare(b.task+b.model));
console.log("\ntask\tmodel\toutcome\tsteps\twall_s\tcost$\tfinished");
for(const r of rows) console.log([r.task,r.model,r.outcome_pct+"%",r.steps,r.wall_s,r.cost_usd,r.finished].join("\t"));
const cloud=rows.filter(r=>r.client==="openrouter"); const tot=cloud.reduce((s,r)=>s+(r.cost_usd||0),0);
console.log("\nTOTAL cloud cost: $"+tot.toFixed(2));
'
