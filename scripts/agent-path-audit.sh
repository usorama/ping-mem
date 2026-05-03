#!/bin/bash
# agent-path-audit.sh — Tests every path a real agent uses
# Run after every deploy: ./scripts/agent-path-audit.sh
# Exit code 0 = all paths work, non-zero = failures found

BASE="${PING_MEM_URL:-http://localhost:3003}"
ADMIN_USER="${PING_MEM_ADMIN_USER:-admin}"
ADMIN_PASS="${PING_MEM_ADMIN_PASS:-ping-mem-dev-local}"
AUTH_HEADER="Authorization: Basic $(printf '%s:%s' "$ADMIN_USER" "$ADMIN_PASS" | base64 | tr -d '\n')"
FAILURES=0

fail() { echo "FAIL  $1"; FAILURES=$((FAILURES + 1)); }
pass() { echo "PASS  $1"; }

echo "=== Agent Path Integration Audit ==="
echo "Target: $BASE"
echo ""

# --- PATH 1: REST tool discovery ---
echo "--- REST TOOL DISCOVERY ---"
TOOL_COUNT=$(curl -sf "$BASE/api/v1/tools" | jq -r '.data.tools | length' 2>/dev/null || echo 0)
[ "${TOOL_COUNT:-0}" -ge 50 ] && pass "REST tools: $TOOL_COUNT tools" || fail "REST tools: ${TOOL_COUNT:-0} tools (expect ≥50)"

# Direct MCP remains available only for isolated offline/dev work. It is not an
# approved live-agent audit path because it can open local state outside REST.

# --- PATH 3: Write-then-search round-trip ---
echo ""
echo "--- WRITE-THEN-SEARCH ---"
SESSION=$(curl -sf -X POST "$BASE/api/v1/session/start" \
  -H "Content-Type: application/json" \
  -d '{"name":"audit","projectDir":"/Users/umasankr/Projects/ping-mem","autoIngest":false}' | jq -r '.data.sessionId // empty')

if [ -z "$SESSION" ]; then
  fail "Could not start session"
else
  TS=$(date +%s)
  # Save with unique key
  curl -sf -X POST "$BASE/api/v1/context" \
    -H "Content-Type: application/json" \
    -H "X-Session-ID: $SESSION" \
    -d "{\"key\":\"audit/wtr-$TS\",\"value\":\"Audit write-then-read verification with unique timestamp $TS for deterministic search\",\"category\":\"observation\"}" > /dev/null

  # Search by value content (not key)
  FOUND=$(curl -sf -X POST "$BASE/api/v1/memory/auto-recall" \
    -H "Content-Type: application/json" \
    -H "X-Session-ID: $SESSION" \
    -d "{\"query\":\"audit verification unique timestamp $TS\",\"limit\":5}" | jq -r ".data.memories[]? | select(.key == \"audit/wtr-$TS\") | .key")

  [ "$FOUND" = "audit/wtr-$TS" ] && pass "Write-then-search: found by value content" || fail "Write-then-search: memory not found after save"

  # End session
  curl -sf -X POST "$BASE/api/v1/session/end" \
    -H "Content-Type: application/json" \
    -H "X-Session-ID: $SESSION" \
  -d '{}' > /dev/null
fi

# --- PATH 4: Cross-session search ---
echo ""
echo "--- CROSS-SESSION SEARCH ---"
SESSION_A=$(curl -sf -X POST "$BASE/api/v1/session/start" \
  -H "Content-Type: application/json" \
  -d '{"name":"audit-A","projectDir":"/Users/umasankr/Projects/ping-mem","autoIngest":false}' | jq -r '.data.sessionId // empty')
TS2=$(date +%s)
curl -sf -X POST "$BASE/api/v1/context" \
  -H "Content-Type: application/json" \
  -H "X-Session-ID: $SESSION_A" \
  -d "{\"key\":\"audit/cross-$TS2\",\"value\":\"Cross-session test written at $TS2 for verification\",\"category\":\"fact\"}" > /dev/null
curl -sf -X POST "$BASE/api/v1/session/end" -H "Content-Type: application/json" -H "X-Session-ID: $SESSION_A" -d '{}' > /dev/null

SESSION_B=$(curl -sf -X POST "$BASE/api/v1/session/start" \
  -H "Content-Type: application/json" \
  -d '{"name":"audit-B","projectDir":"/Users/umasankr/Projects/ping-mem","autoIngest":false}' | jq -r '.data.sessionId // empty')
CROSS=$(curl -sf -X POST "$BASE/api/v1/memory/auto-recall" \
  -H "Content-Type: application/json" \
  -H "X-Session-ID: $SESSION_B" \
  -d "{\"query\":\"cross-session written $TS2 verification\",\"limit\":5}" | jq -r ".data.memories[]? | select(.key == \"audit/cross-$TS2\") | .key")
curl -sf -X POST "$BASE/api/v1/session/end" -H "Content-Type: application/json" -d "{\"sessionId\":\"$SESSION_B\"}" > /dev/null

[ "$CROSS" = "audit/cross-$TS2" ] && pass "Cross-session: B found A's memory" || fail "Cross-session: B could NOT find A's memory"

# --- PATH 5: New features present ---
echo ""
echo "--- NEW FEATURES ---"
curl -sf -H "$AUTH_HEADER" "$BASE/api/v1/mining/status" | jq -e '.data.total >= 0' > /dev/null 2>&1 && pass "Mining status endpoint" || fail "Mining status endpoint"
curl -sf -o /dev/null -w "%{http_code}" "$BASE/ui/mining" | grep -q 200 && pass "Mining UI page" || fail "Mining UI page"
curl -sf -o /dev/null -w "%{http_code}" "$BASE/ui/insights" | grep -q 200 && pass "Insights UI page" || fail "Insights UI page"
curl -sf -o /dev/null -w "%{http_code}" "$BASE/ui/profile" | grep -q 200 && pass "Profile UI page" || fail "Profile UI page"

# --- PATH 6: Health ---
echo ""
echo "--- HEALTH ---"
curl -sf "$BASE/health" | jq -e '.status == "ok"' > /dev/null 2>&1 && pass "Health endpoint" || fail "Health endpoint"

echo ""
echo "============================================================"
if [ $FAILURES -eq 0 ]; then
  echo "ALL PATHS PASS — $FAILURES failures"
  exit 0
else
  echo "FAILURES: $FAILURES path(s) broken"
  exit 1
fi
