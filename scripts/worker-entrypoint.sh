#!/bin/sh
# Worker entrypoint: rotate INSTANCE_TOKEN on every startup so the in-container
# value never drifts from the DB after a reset.
#
# Requires:
#   API_BASE_URL          — internal URL of the Central API (e.g. http://api:3000)
#   INSTANCE_ID           — bot instance id (e.g. bot-52f42f3f)
#   WORKER_BOOTSTRAP_SECRET — shared secret configured on the API side
#
# When bootstrap succeeds the refreshed INSTANCE_TOKEN is exported and the
# worker process replaces this shell.  On failure the script falls through and
# the original INSTANCE_TOKEN (from .env / compose) is used as-is.

set -e

if [ -z "$WORKER_BOOTSTRAP_SECRET" ]; then
  echo "[entrypoint] WORKER_BOOTSTRAP_SECRET not set — skipping bootstrap, using existing INSTANCE_TOKEN"
  exec bun run src/index.ts "$@"
fi

if [ -z "$INSTANCE_ID" ]; then
  echo "[entrypoint] INSTANCE_ID not set — cannot bootstrap"
  exec bun run src/index.ts "$@"
fi

API_URL="${API_BASE_URL:-http://api:3000}"
BOOTSTRAP_URL="${API_URL}/auth/worker-bootstrap"

echo "[entrypoint] Waiting for API at ${API_URL}/health ..."
for i in $(seq 1 30); do
  if curl -sf -o /dev/null "${API_URL}/health"; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[entrypoint] API did not become ready — using existing INSTANCE_TOKEN"
    exec bun run src/index.ts "$@"
  fi
  sleep 2
done

echo "[entrypoint] Rotating INSTANCE_TOKEN for ${INSTANCE_ID} ..."
RESPONSE=$(curl -sf \
  -H "Content-Type: application/json" \
  -d "{\"instanceId\":\"${INSTANCE_ID}\",\"bootstrapSecret\":\"${WORKER_BOOTSTRAP_SECRET}\"}" \
  "${BOOTSTRAP_URL}" 2>/dev/null) || true

if [ -z "$RESPONSE" ]; then
  echo "[entrypoint] Bootstrap request failed — using existing INSTANCE_TOKEN"
  exec bun run src/index.ts "$@"
fi

# Parse token from JSON: {"instanceId":"...","instanceToken":"<TOKEN>"}
NEW_TOKEN=$(echo "$RESPONSE" | sed -n 's/.*"instanceToken":"\([^"]*\)".*/\1/p')

if [ -z "$NEW_TOKEN" ]; then
  ERROR=$(echo "$RESPONSE" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')
  echo "[entrypoint] Bootstrap failed: ${ERROR:-unknown error} — using existing INSTANCE_TOKEN"
  exec bun run src/index.ts "$@"
fi

export INSTANCE_TOKEN="$NEW_TOKEN"
echo "[entrypoint] INSTANCE_TOKEN refreshed (len=${#NEW_TOKEN})"

exec bun run src/index.ts "$@"
