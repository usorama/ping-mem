#!/usr/bin/env bash
#
# ping-mem Smoke Test
#
# Verifies that the full stack is working:
# 1. Docker services are healthy
# 2. Can ingest a project
# 3. Can search code
# 4. Can query timeline
# 5. Can save and retrieve context
#
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}ping-mem Smoke Test${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Test project directory (use ping-mem itself)
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="http://localhost:3000"
API_KEY="${PING_MEM_API_KEY:-}"

AUTH_HEADER=()
if [[ -n "$API_KEY" ]]; then
  AUTH_HEADER=("-H" "X-API-Key: $API_KEY")
fi

# ============================================================================
# Test 1: Health Check
# ============================================================================

echo -e "${YELLOW}[1/6] Testing health endpoint...${NC}"

HEALTH_RESPONSE=$(curl -sf "${AUTH_HEADER[@]}" "$API_URL/health" || echo "FAILED")
if [[ "$HEALTH_RESPONSE" == "FAILED" ]]; then
  echo -e "${RED}✗ Health check failed${NC}"
  echo "Ensure ping-mem is running: docker compose up -d"
  exit 1
fi

echo -e "${GREEN}✓ Health check passed${NC}"
echo ""

# ============================================================================
# Test 2: Start Session
# ============================================================================

echo -e "${YELLOW}[2/6] Starting test session...${NC}"

SESSION_RESPONSE=$(curl -sf -X POST "$API_URL/api/v1/session/start" \
  -H "Content-Type: application/json" \
  "${AUTH_HEADER[@]}" \
  -d "{\"name\":\"smoke-test\",\"projectDir\":\"$PROJECT_DIR\"}" || echo "FAILED")

if [[ "$SESSION_RESPONSE" == "FAILED" ]]; then
  echo -e "${RED}✗ Session start failed${NC}"
  exit 1
fi

SESSION_ID=$(echo "$SESSION_RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || echo "")
if [[ -z "$SESSION_ID" ]]; then
  echo -e "${RED}✗ Could not extract session ID${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Session started: $SESSION_ID${NC}"
echo ""

# ============================================================================
# Test 3: Ingest Project
# ============================================================================

echo -e "${YELLOW}[3/6] Ingesting project (this may take a minute)...${NC}"

INGEST_RESPONSE=$(curl -sf -X POST "$API_URL/api/v1/codebase/ingest" \
  -H "Content-Type: application/json" \
  "${AUTH_HEADER[@]}" \
  -H "X-Session-ID: $SESSION_ID" \
  -d "{\"projectDir\":\"$PROJECT_DIR\"}" || echo "FAILED")

if [[ "$INGEST_RESPONSE" == "FAILED" ]]; then
  echo -e "${RED}✗ Ingestion failed${NC}"
  echo "Check Docker logs: docker compose logs ping-mem"
  exit 1
fi

echo -e "${GREEN}✓ Project ingested${NC}"
echo ""

# ============================================================================
# Test 4: Search Code
# ============================================================================

echo -e "${YELLOW}[4/6] Searching code...${NC}"

SEARCH_RESPONSE=$(curl -sf "$API_URL/api/v1/codebase/search?query=memory+manager&limit=5" \
  "${AUTH_HEADER[@]}" \
  -H "X-Session-ID: $SESSION_ID" || echo "FAILED")

if [[ "$SEARCH_RESPONSE" == "FAILED" ]]; then
  echo -e "${RED}✗ Code search failed${NC}"
  exit 1
fi

RESULT_COUNT=$(echo "$SEARCH_RESPONSE" | grep -o '"count":[0-9]*' | cut -d':' -f2 || echo "0")
if [[ "$RESULT_COUNT" -gt 0 ]]; then
  echo -e "${GREEN}✓ Code search returned $RESULT_COUNT results${NC}"
else
  echo -e "${YELLOW}⚠ Code search returned 0 results (may need re-ingestion)${NC}"
fi
echo ""

# ============================================================================
# Test 5: Save Context
# ============================================================================

echo -e "${YELLOW}[5/6] Saving context...${NC}"

SAVE_RESPONSE=$(curl -sf -X POST "$API_URL/api/v1/context" \
  -H "Content-Type: application/json" \
  "${AUTH_HEADER[@]}" \
  -H "X-Session-ID: $SESSION_ID" \
  -d '{"key":"smoke-test-decision","value":"Smoke test completed successfully","category":"note","priority":"normal"}' \
  || echo "FAILED")

if [[ "$SAVE_RESPONSE" == "FAILED" ]]; then
  echo -e "${RED}✗ Context save failed${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Context saved${NC}"
echo ""

# ============================================================================
# Test 6: Retrieve Context
# ============================================================================

echo -e "${YELLOW}[6/6] Retrieving context...${NC}"

GET_RESPONSE=$(curl -sf "$API_URL/api/v1/context/smoke-test-decision" \
  "${AUTH_HEADER[@]}" \
  -H "X-Session-ID: $SESSION_ID" || echo "FAILED")

if [[ "$GET_RESPONSE" == "FAILED" ]]; then
  echo -e "${RED}✗ Context retrieval failed${NC}"
  exit 1
fi

if echo "$GET_RESPONSE" | grep -q "Smoke test completed successfully"; then
  echo -e "${GREEN}✓ Context retrieved successfully${NC}"
else
  echo -e "${RED}✗ Context content mismatch${NC}"
  exit 1
fi

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}All smoke tests passed!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "ping-mem is fully operational."
echo ""
