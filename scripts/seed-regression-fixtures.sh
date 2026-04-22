#!/usr/bin/env bash
set -euo pipefail

PING_MEM_URL="${PING_MEM_URL:-http://localhost:3003}"
SESSION_NAME="${REGRESSION_SESSION_NAME:-regression-canaries}"
ADMIN_USER="${PING_MEM_ADMIN_USER:-admin}"
ADMIN_PASS="${PING_MEM_ADMIN_PASS:-ping-mem-dev-local}"

for bin in curl jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: $bin not found on PATH" >&2; exit 2; }
done

AUTH_HEADER="Authorization: Basic $(printf '%s:%s' "$ADMIN_USER" "$ADMIN_PASS" | base64 | tr -d '\n')"

SESSION_RESPONSE=$(curl -sf --max-time 20 \
  -X POST "${PING_MEM_URL}/api/v1/session/start" \
  -H "Content-Type: application/json" \
  -H "${AUTH_HEADER}" \
  -d "{\"name\":\"${SESSION_NAME}\",\"agentId\":\"${SESSION_NAME}\"}")

SESSION_ID=$(printf '%s' "$SESSION_RESPONSE" | jq -r '.data.sessionId // .data.id // empty')
if [ -z "$SESSION_ID" ]; then
  echo "ERROR: failed to acquire session id: $SESSION_RESPONSE" >&2
  exit 1
fi

FIXTURES=$(cat <<'EOF'
native/pinglearn/fixture-1|CANARY_1: Pricing decision — ping-learn pricing research backed by research-zero; US $14.99/mo Scholar, India INR 499/mo.
native/pinglearn/fixture-2|CANARY_2: Mobile push — Firebase FCM pinglearn-c63a2 project number 712545717453, Android + iOS apps registered.
native/pinglearn/fixture-3|CANARY_3: Authenticated redesign — classroom redesign worktree at /private/tmp/pl-classroom-redesign on feat/classroom-redesign.
native/pinglearn/fixture-4|CANARY_4: Security — PR 236 JWT secret isolation merged; CONSENT_JWT_SECRET env var, alg:none attack prevention, rate limit fail-closed.
native/pinglearn/fixture-5|CANARY_5: Compliance — DPDP consent age 18 raised from 17; PR #273 with follow-up issues #274 #275 #276.
native/pinglearn/fixture-6|CANARY_6: Voice stack — PingLearn voice tutor LiveKit uses WebRTC rooms, realtime agent orchestration, and live classroom audio.
native/pinglearn/fixture-7|CANARY_7: Data migration — Supabase migration consent tokens backfill, verification, and rollback notes for protected student consent flows.
native/ping-mem/fixture-8|CANARY_8: Recovery — Ollama qwen3:8b recovery brain restored doctor health and warm-path reliability after degraded runtime.
native/ping-mem/fixture-9|CANARY_9: Observability — ping-mem-doctor gates 29 became the baseline operator target during remediation.
native/ping-mem/fixture-10|CANARY_10: Sync — native-sync hook truncation fix preserved complete memory payloads during file-backed sync.
EOF
)

while IFS='|' read -r KEY VALUE; do
  [ -n "$KEY" ] || continue

  PAYLOAD=$(jq -n \
    --arg key "$KEY" \
    --arg value "$VALUE" \
    '{
      key: $key,
      value: $value,
      category: "regression-fixture",
      priority: "low",
      channel: "regression-fixture",
      agentScope: "public",
      metadata: {
        source: "seed-regression-fixtures.sh"
      }
    }')

  curl -sf --max-time 20 \
    -X POST "${PING_MEM_URL}/api/v1/context" \
    -H "Content-Type: application/json" \
    -H "${AUTH_HEADER}" \
    -H "X-Session-ID: ${SESSION_ID}" \
    -d "$PAYLOAD" >/dev/null

  echo "seeded ${KEY}"
done <<EOF
$FIXTURES
EOF

QUERIES=$(cat <<'EOF'
ping-learn pricing research
Firebase FCM pinglearn-c63a2
classroom redesign worktree
PR 236 JWT secret isolation
DPDP consent age 18
PingLearn voice tutor LiveKit
Supabase migration consent tokens
Ollama qwen3:8b recovery brain
ping-mem-doctor gates 29
native-sync hook truncation fix
EOF
)

FAIL=0
while IFS= read -r QUERY; do
  [ -n "$QUERY" ] || continue
  RESPONSE=$(curl -sf --max-time 20 \
    -H "${AUTH_HEADER}" \
    -H "X-Session-ID: ${SESSION_ID}" \
    "${PING_MEM_URL}/api/v1/search?query=$(printf '%s' "$QUERY" | jq -sRr @uri)&limit=5")
  HITS=$(printf '%s' "$RESPONSE" | jq '.data | length')
  if [ "$HITS" -lt 1 ]; then
    echo "MISS ${QUERY}" >&2
    FAIL=1
  else
    echo "verified ${QUERY}: ${HITS} hit(s)"
  fi
done <<EOF
$QUERIES
EOF

if [ "$FAIL" -ne 0 ]; then
  echo "ERROR: one or more canonical regression queries still returned 0 hits" >&2
  exit 1
fi

echo "OK: seeded and verified all canonical regression fixtures"
