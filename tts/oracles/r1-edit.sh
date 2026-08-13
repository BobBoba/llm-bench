#!/usr/bin/env bash
# * r1-edit: agent must change greeting from "Hello, " to "Hi, " in src/lib.rs
# * and keep the crate's tests green.
set -euo pipefail
D="$1"
cd "$D"

if ! grep -q 'Hi, ' src/lib.rs; then
  echo "FAIL: 'Hi, ' greeting not found in src/lib.rs"
  exit 1
fi

# * Negative assertion made blocking: an explicit if/exit instead of bare
# * `! grep ...`, which under `set -e` would NOT abort the script (POSIX
# * exempts `!`-negated commands from errexit), silently letting a leftover
# * "Hello, " slip through.
if grep -q 'Hello, ' src/lib.rs; then
  echo "FAIL: old 'Hello, ' greeting still present in src/lib.rs"
  exit 1
fi

cargo test --quiet
