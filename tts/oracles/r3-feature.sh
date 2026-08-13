#!/usr/bin/env bash
# * r3-feature: drop in a hidden test the agent never saw, then require the
# * whole suite (including it) to pass. No negative assertions here besides
# * cargo test's own exit code, which set -e already propagates correctly
# * since it is the script's last command.
set -euo pipefail
D="$1"
HID="$(dirname "$0")/hidden/r3-palindrome.rs"

mkdir -p "$D/tests"
cp "$HID" "$D/tests/palindrome_hidden.rs"

cd "$D"
cargo test --quiet
