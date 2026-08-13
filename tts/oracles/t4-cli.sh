#!/usr/bin/env bash
# * t4-cli: a small bun/TypeScript CLI that counts lines/words/bytes in a file,
# * plus --lines and --words flags that each report a single count.
set -euo pipefail
D="$1"
cd "$D"

# * bun-types (the "Bun" global / types entry in tsconfig.json) only resolves
# * once installed from package.json - bunx auto-installs the CLI package
# * itself (typescript) on demand but NOT unrelated devDependencies like
# * bun-types, so an explicit bounded install is required before the
# * type-check or a correct reference solution would still fail tsc.
timeout 120 bun install

timeout 60 bunx tsc --noEmit --strict

printf 'alpha beta\ngamma\n' > sample.txt

OUT=$(bun run index.ts sample.txt)

# * These are positive assertions (grep -q as a standalone statement, not
# * negated, not inside if/while/&&/||) - under `set -e` a failing grep here
# * DOES abort the script correctly, so no `!`-pitfall applies. Still wrapped
# * in explicit if/exit so the log carries a diagnostic reason.
if ! echo "$OUT" | grep -qE '(^|[^0-9])2([^0-9]|$)'; then
  echo "FAIL: expected line count 2 not found in output: $OUT"
  exit 1
fi
if ! echo "$OUT" | grep -qE '(^|[^0-9])3([^0-9]|$)'; then
  echo "FAIL: expected word count 3 not found in output: $OUT"
  exit 1
fi
# * sample.txt ("alpha beta\ngamma\n") is exactly 17 bytes. Without this check
# * a fake solution could hardcode "2 3 <anything>" for the default output and
# * still pass, never actually computing the byte count TASK.md requires.
if ! echo "$OUT" | grep -qE '(^|[^0-9])17([^0-9]|$)'; then
  echo "FAIL: expected byte count 17 not found in default output: $OUT"
  exit 1
fi

LN=$(bun run index.ts --lines sample.txt)
if ! echo "$LN" | grep -qE '(^|[^0-9])2([^0-9]|$)'; then
  echo "FAIL: --lines flag did not report line count 2, got: $LN"
  exit 1
fi

# * --words was previously never invoked, so a solution that omitted the flag
# * entirely (or implemented it wrong) still passed. Exercise it explicitly.
W=$(bun run index.ts --words sample.txt)
if ! echo "$W" | grep -qE '(^|[^0-9])3([^0-9]|$)'; then
  echo "FAIL: --words flag did not report word count 3, got: $W"
  exit 1
fi
