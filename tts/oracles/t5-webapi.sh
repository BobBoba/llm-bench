#!/usr/bin/env bash
# * t5-webapi: a small bun/TypeScript HTTP API for todos (POST/GET/DELETE).
# * We start the server as a background job on a fixed port, poll it with a
# * bounded retry loop, drive it with curl, and ALWAYS kill it on exit -
# * including when an assertion fails and set -e aborts the script, because
# * the EXIT trap fires unconditionally regardless of how the script exits.
set -euo pipefail
D="$1"
cd "$D"

# * Diagnostic trap: if set -e aborts on an unchecked command (e.g. tsc,
# * curl -f), print the failing line so the log fed back to the agent is
# * still informative, not just a bare non-zero exit.
trap 'echo "FAIL: command failed at line $LINENO"' ERR

# * bun-types (the "Bun" global / types entry in tsconfig.json) only resolves
# * once installed from package.json - bunx auto-installs the CLI package
# * itself (typescript) on demand but NOT unrelated devDependencies like
# * bun-types, so an explicit bounded install is required before the
# * type-check or a correct reference solution would still fail tsc.
timeout 120 bun install

timeout 60 bunx tsc --noEmit --strict

PORT=8977
bun run index.ts --port "$PORT" &
SRV=$!

cleanup() {
  kill "$SRV" 2>/dev/null || true
  wait "$SRV" 2>/dev/null || true
}
trap cleanup EXIT

READY=0
for i in $(seq 1 30); do
  if curl -sf --max-time 5 --connect-timeout 2 "http://localhost:$PORT/todos" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.3
done
# * Negative assertion made blocking: plain numeric comparison in an if,
# * exits explicitly with a diagnostic reason instead of relying on the
# * bounded loop silently falling through.
if [ "$READY" -ne 1 ]; then
  echo "FAIL: server on port $PORT did not respond to GET /todos within timeout"
  exit 1
fi

POST_BODY=$(curl -sf --max-time 5 --connect-timeout 2 -X POST "http://localhost:$PORT/todos" -H 'content-type: application/json' -d '{"title":"buy milk"}')
ID=$(printf '%s' "$POST_BODY" | node -e '
let d = "";
process.stdin.on("data", c => d += c).on("end", () => {
  try {
    const id = JSON.parse(d).id;
    if (id === undefined || id === null || id === "") process.exit(1);
    console.log(id);
  } catch (e) {
    process.exit(1);
  }
});
')
if [ -z "$ID" ]; then
  echo "FAIL: POST /todos did not return a parseable id, body: $POST_BODY"
  exit 1
fi

LIST_BODY=$(curl -sf --max-time 5 --connect-timeout 2 "http://localhost:$PORT/todos")
if ! echo "$LIST_BODY" | grep -q "buy milk"; then
  echo "FAIL: GET /todos does not contain created todo, body: $LIST_BODY"
  exit 1
fi

DELETE_CODE=$(curl -sf --max-time 5 --connect-timeout 2 -X DELETE "http://localhost:$PORT/todos/$ID" -o /dev/null -w '%{http_code}')
if ! echo "$DELETE_CODE" | grep -qE '^20(0|4)$'; then
  echo "FAIL: DELETE /todos/$ID returned unexpected status code $DELETE_CODE"
  exit 1
fi

FINAL_BODY=$(curl -sf --max-time 5 --connect-timeout 2 "http://localhost:$PORT/todos")
if [ "$FINAL_BODY" != "[]" ]; then
  echo "FAIL: GET /todos after delete expected [], got: $FINAL_BODY"
  exit 1
fi
