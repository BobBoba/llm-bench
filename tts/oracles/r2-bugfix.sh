#!/usr/bin/env bash
# * r2-bugfix: agent must fix the bug WITHOUT touching the test file.
# * We diff the test file against the reference copy shipped alongside the
# * oracle (created in Task 5) to prove it was not tampered with.
set -euo pipefail
D="$1"
REF="$(dirname "$0")/refs/r2-median.rs"

# * Negative assertion made blocking: `diff -q` exits non-zero when the files
# * differ, and with `set -euo pipefail` (no `!`, no trailing `|| true`) that
# * non-zero status genuinely aborts the script here - the pitfall of wrapping
# * this in a bare `! diff ...` under errexit is avoided entirely.
if ! diff -q "$REF" "$D/tests/median.rs" > /dev/null; then
  echo "FAIL: tests/median.rs was modified (must diff clean against reference)"
  exit 1
fi

cd "$D"
cargo test --quiet
