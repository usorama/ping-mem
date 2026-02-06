#!/usr/bin/env bash
#
# ping-mem Project Ingestion Script
#
# Ingests a codebase into ping-mem:
# - Scans all code files
# - Extracts git history
# - Indexes into Neo4j + Qdrant
# - Creates deterministic manifest
#
# Usage:
#   ./scripts/ingest-project.sh [PROJECT_DIR]
#
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Target project directory
PROJECT_DIR="${1:-$(pwd)}"
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"  # Absolute path

PING_MEM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${PING_MEM_API_URL:-http://localhost:3001}"
API_KEY="${PING_MEM_API_KEY:-}"

# Build auth header if API key provided
if [[ -n "$API_KEY" ]]; then
  AUTH_HEADER=("-H" "X-API-Key: $API_KEY")
else
  AUTH_HEADER=()
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}ping-mem Project Ingestion${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Project: $PROJECT_DIR"
echo ""

# ============================================================================
# Step 1: Verify ping-mem is Running
# ============================================================================

echo -e "${YELLOW}[1/5] Verifying ping-mem service...${NC}"

if ! curl -sf ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} "$API_URL/api/v1/status" > /dev/null 2>&1; then
  echo -e "${RED}✗ ping-mem service not responding${NC}"
  echo ""
  echo "Start ping-mem first:"
  echo "  cd $PING_MEM_ROOT"
  echo "  ./scripts/setup.sh"
  exit 1
fi

echo -e "  ${GREEN}✓${NC} ping-mem service is running"
echo ""

# ============================================================================
# Step 2: Check if Project is Git Repository
# ============================================================================

echo -e "${YELLOW}[2/5] Checking git repository...${NC}"

if [[ ! -d "$PROJECT_DIR/.git" ]]; then
  echo -e "  ${YELLOW}⚠${NC} Not a git repository (git history will be skipped)"
  HAS_GIT=false
else
  COMMIT_COUNT=$(cd "$PROJECT_DIR" && git rev-list --count HEAD 2>/dev/null || echo "0")
  echo -e "  ${GREEN}✓${NC} Git repository with $COMMIT_COUNT commits"
  HAS_GIT=true
fi

echo ""

# ============================================================================
# Step 3: Start Ingestion Session
# ============================================================================

echo -e "${YELLOW}[3/5] Starting ingestion session...${NC}"

SESSION_RESPONSE=$(curl -sf -X POST "$API_URL/api/v1/session/start" \
  -H "Content-Type: application/json" \
  ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} \
  -d "{\"name\":\"ingest-$(basename "$PROJECT_DIR")\",\"projectDir\":\"$PROJECT_DIR\"}" \
  || echo "FAILED")

if [[ "$SESSION_RESPONSE" == "FAILED" ]]; then
  echo -e "${RED}✗ Failed to start session${NC}"
  exit 1
fi

SESSION_ID=$(echo "$SESSION_RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || echo "")
if [[ -z "$SESSION_ID" ]]; then
  echo -e "${RED}✗ Could not extract session ID${NC}"
  exit 1
fi

echo -e "  ${GREEN}✓${NC} Session started: $SESSION_ID"
echo ""

# ============================================================================
# Step 4: Ingest Codebase
# ============================================================================

echo -e "${YELLOW}[4/5] Ingesting codebase (this may take several minutes)...${NC}"
echo "  Scanning files..."
echo "  Parsing code and comments..."
echo "  Extracting git history..."
echo "  Indexing into Neo4j and Qdrant..."
echo ""

INGEST_START=$(date +%s)

INGEST_RESPONSE=$(curl -sf -X POST "$API_URL/api/v1/codebase/ingest" \
  -H "Content-Type: application/json" \
  ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} \
  -H "X-Session-ID: $SESSION_ID" \
  -d "{\"projectDir\":\"$PROJECT_DIR\",\"forceReingest\":false}" \
  || echo "FAILED")

INGEST_END=$(date +%s)
INGEST_DURATION=$((INGEST_END - INGEST_START))

if [[ "$INGEST_RESPONSE" == "FAILED" ]]; then
  echo -e "${RED}✗ Ingestion failed${NC}"
  echo ""
  echo "Check logs:"
  echo "  docker compose logs ping-mem"
  exit 1
fi

# Check if no changes detected
if echo "$INGEST_RESPONSE" | grep -q '"hadChanges":false'; then
  echo -e "  ${GREEN}✓${NC} No changes detected (manifest is current)"
else
  # Extract stats
  FILES_INDEXED=$(echo "$INGEST_RESPONSE" | grep -o '"filesIndexed":[0-9]*' | cut -d':' -f2 || echo "?")
  CHUNKS_INDEXED=$(echo "$INGEST_RESPONSE" | grep -o '"chunksIndexed":[0-9]*' | cut -d':' -f2 || echo "?")
  COMMITS_INDEXED=$(echo "$INGEST_RESPONSE" | grep -o '"commitsIndexed":[0-9]*' | cut -d':' -f2 || echo "?")
  
  echo -e "  ${GREEN}✓${NC} Ingestion complete in ${INGEST_DURATION}s"
  echo "    Files indexed: $FILES_INDEXED"
  echo "    Chunks indexed: $CHUNKS_INDEXED"
  echo "    Commits indexed: $COMMITS_INDEXED"
fi

echo ""

# ============================================================================
# Step 5: Verify Ingestion
# ============================================================================

echo -e "${YELLOW}[5/5] Verifying ingestion...${NC}"

VERIFY_RESPONSE=$(curl -sf -X POST "$API_URL/api/v1/codebase/verify" \
  -H "Content-Type: application/json" \
  ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} \
  -H "X-Session-ID: $SESSION_ID" \
  -d "{\"projectDir\":\"$PROJECT_DIR\"}" \
  || echo "FAILED")

if [[ "$VERIFY_RESPONSE" == "FAILED" ]]; then
  echo -e "  ${YELLOW}⚠${NC} Verification failed (ingestion may still be valid)"
else
  if echo "$VERIFY_RESPONSE" | grep -q '"valid":true'; then
    echo -e "  ${GREEN}✓${NC} Manifest verified"
  else
    echo -e "  ${YELLOW}⚠${NC} Manifest verification failed"
  fi
fi

# Test search
echo "  Testing search..."
SEARCH_TEST=$(curl -sf "$API_URL/api/v1/codebase/search?query=function&limit=1" \
  ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} \
  -H "X-Session-ID: $SESSION_ID" || echo "FAILED")

if [[ "$SEARCH_TEST" != "FAILED" ]]; then
  RESULT_COUNT=$(echo "$SEARCH_TEST" | grep -o '"count":[0-9]*' | cut -d':' -f2 || echo "0")
  if [[ "$RESULT_COUNT" -gt 0 ]]; then
    echo -e "  ${GREEN}✓${NC} Search is working ($RESULT_COUNT results for test query)"
  else
    echo -e "  ${YELLOW}⚠${NC} Search returned 0 results"
  fi
fi

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Ingestion complete!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Your project is now indexed in ping-mem."
echo ""
echo "Try these commands:"
echo ""
echo "  # Search code"
echo "  curl '$API_URL/api/v1/codebase/search?query=authentication' \\"
echo "    -H 'X-Session-ID: $SESSION_ID'"
echo ""
echo "  # Query timeline"
echo "  curl '$API_URL/api/v1/codebase/timeline?projectId=...' \\"
echo "    -H 'X-Session-ID: $SESSION_ID'"
echo ""
echo "Or use MCP tools in your IDE!"
echo ""
