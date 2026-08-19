#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
while pgrep -f "run-qwen38-cliff3-chain.sh" > /dev/null; do sleep 30; done
bash campaigns/run-qwen38-bare0819.sh
