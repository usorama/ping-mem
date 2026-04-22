#!/bin/bash
# =============================================================================
# ping-mem Comprehensive Capability Test
# Tests ALL 47 tools via REST API against a running local server
# =============================================================================

set -euo pipefail

BASE="http://localhost:3003"
PROJECT_DIR="${TARGET_PROJECT_DIR:-/projects/ping-mem}"
ADMIN_USER="${PING_MEM_ADMIN_USER:-admin}"
ADMIN_PASS="${PING_MEM_ADMIN_PASS:-ping-mem-dev-local}"
AUTH_HEADER="Authorization: Basic $(printf '%s:%s' "$ADMIN_USER" "$ADMIN_PASS" | base64 | tr -d '\n')"
PASS=0
FAIL=0
SKIP=0
SESSION_ID=""
PROJECT_ID=""
TREE_HASH=""
DIAG_PROJECT_ID="diag-capability-project"
DIAG_TREE_HASH="1111111111111111111111111111111111111111111111111111111111111111"
DIAG_CONFIG_HASH="2222222222222222222222222222222222222222222222222222222222222222"
RESULTS=()

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

test_endpoint() {
  local name="$1"
  local method="$2"
  local path="$3"
  local body="${4:-}"
  local expect_code="${5:-200}"

  : > /tmp/pm-test-body
  local args=(-sS -o /tmp/pm-test-body -w "%{http_code}" -X "$method")
  args+=(-H "Content-Type: application/json")
  args+=(-H "$AUTH_HEADER")
  if [[ -n "$SESSION_ID" ]]; then
    args+=(-H "X-Session-ID: $SESSION_ID")
  fi
  if [[ -n "$body" ]]; then
    args+=(-d "$body")
  fi

  local code
  code=$(curl "${args[@]}" "${BASE}${path}" 2>/dev/null || echo "000")
  local response
  response=$(cat /tmp/pm-test-body 2>/dev/null || echo "")

  if [[ "$code" == "$expect_code" ]]; then
    printf "${GREEN}  PASS${NC} %-45s [%s]\n" "$name" "$code"
    PASS=$((PASS + 1))
    RESULTS+=("PASS|$name|$code")
  elif [[ "$code" == "503" ]]; then
    printf "${YELLOW}  SKIP${NC} %-45s [%s] (service unavailable)\n" "$name" "$code"
    SKIP=$((SKIP + 1))
    RESULTS+=("SKIP|$name|$code")
  else
    printf "${RED}  FAIL${NC} %-45s [%s] expected %s\n" "$name" "$code" "$expect_code"
    if [[ -n "$response" ]]; then
      echo "       Response: ${response:0:200}"
    fi
    FAIL=$((FAIL + 1))
    RESULTS+=("FAIL|$name|$code")
  fi
}

echo ""
echo "=========================================="
echo " ping-mem Capability Test Suite"
echo " Server: $BASE"
echo "=========================================="
echo ""

# =============================================================================
# 0. INFRASTRUCTURE
# =============================================================================
printf "${CYAN}--- Infrastructure ---${NC}\n"
test_endpoint "health" GET "/health"
test_endpoint "openapi_spec" GET "/openapi.json"
test_endpoint "tool_list" GET "/api/v1/tools"
test_endpoint "tool_get_specific" GET "/api/v1/tools/context_save"

# =============================================================================
# 1. SESSION MANAGEMENT (context_session_*)
# =============================================================================
printf "\n${CYAN}--- Session Management ---${NC}\n"

# Start session
code=$(curl -sS -o /tmp/pm-test-body -w "%{http_code}" -X POST "${BASE}/api/v1/session/start" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d "{\"name\":\"capability-test-session\",\"projectDir\":\"${PROJECT_DIR}\"}")
SESSION_ID=$(python3 -c "import json; d=json.load(open('/tmp/pm-test-body')); print(d.get('data',{}).get('sessionId',''))" 2>/dev/null || echo "")
if [[ "$code" == "200" && -n "$SESSION_ID" ]]; then
  printf "${GREEN}  PASS${NC} %-45s [%s] sid=%s\n" "context_session_start" "$code" "${SESSION_ID:0:12}..."
  PASS=$((PASS + 1))
  RESULTS+=("PASS|context_session_start|$code")
else
  printf "${RED}  FAIL${NC} %-45s [%s]\n" "context_session_start" "$code"
  FAIL=$((FAIL + 1))
  RESULTS+=("FAIL|context_session_start|$code")
fi

test_endpoint "context_session_list" GET "/api/v1/session/list"
test_endpoint "context_status" GET "/api/v1/status"

# =============================================================================
# 2. CONTEXT MEMORY (context_save/get/search/delete/checkpoint)
# =============================================================================
printf "\n${CYAN}--- Context Memory ---${NC}\n"

test_endpoint "context_save" POST "/api/v1/context" \
  '{"key":"test-capability-1","value":"Testing ping-mem save capability","category":"note","priority":"high"}'

test_endpoint "context_save_decision" POST "/api/v1/context" \
  '{"key":"test-decision-1","value":"Use PostgreSQL for production database","category":"decision","priority":"high"}'

test_endpoint "context_save_task" POST "/api/v1/context" \
  '{"key":"test-task-1","value":"Implement authentication middleware","category":"task","priority":"normal"}'

test_endpoint "context_get" GET "/api/v1/context/test-capability-1"
test_endpoint "context_search" GET "/api/v1/search?query=PostgreSQL&limit=5"
test_endpoint "context_checkpoint" POST "/api/v1/checkpoint" '{"name":"test-checkpoint"}'

# =============================================================================
# 3. KNOWLEDGE BASE (knowledge_ingest/search)
# =============================================================================
printf "\n${CYAN}--- Knowledge Base ---${NC}\n"

test_endpoint "knowledge_ingest" POST "/api/v1/knowledge/ingest" \
  '{"projectId":"test-project-001","title":"Docker Volume Persistence","solution":"Use named volumes in docker-compose.yml to persist data across container restarts","symptoms":"data loss; container restart","tags":["docker","persistence","devops"]}'

test_endpoint "knowledge_ingest_2" POST "/api/v1/knowledge/ingest" \
  '{"projectId":"test-project-001","title":"FTS5 Multi-Word Search","solution":"Tokenize multi-word queries with OR joins: foo bar -> foo OR bar","symptoms":"empty results; search returns 0","tags":["sqlite","fts5","search"]}'

test_endpoint "knowledge_search_single" POST "/api/v1/knowledge/search" \
  '{"query":"Docker"}'

test_endpoint "knowledge_search_multi" POST "/api/v1/knowledge/search" \
  '{"query":"Docker volume persistence","limit":5}'

test_endpoint "knowledge_search_cross" POST "/api/v1/knowledge/search" \
  '{"query":"FTS5 search empty results","crossProject":true}'

# =============================================================================
# 4. CODEBASE INTELLIGENCE (codebase_*)
# =============================================================================
printf "\n${CYAN}--- Codebase Intelligence ---${NC}\n"

code=$(curl -sS -o /tmp/pm-test-body -w "%{http_code}" -X POST "${BASE}/api/v1/codebase/verify" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d "{\"projectDir\":\"${PROJECT_DIR}\"}")
if [[ "$code" == "200" ]]; then
  PROJECT_ID=$(python3 -c "import json; d=json.load(open('/tmp/pm-test-body')); print(d.get('data',{}).get('projectId',''))" 2>/dev/null || echo "")
  TREE_HASH=$(python3 -c "import json; d=json.load(open('/tmp/pm-test-body')); print(d.get('data',{}).get('currentTreeHash','') or d.get('data',{}).get('manifestTreeHash',''))" 2>/dev/null || echo "")
fi

test_endpoint "codebase_search" GET "/api/v1/codebase/search?query=MemoryManager&limit=3"
test_endpoint "codebase_list_projects" GET "/api/v1/codebase/projects"
test_endpoint "codebase_verify" POST "/api/v1/codebase/verify" \
  "{\"projectDir\":\"${PROJECT_DIR}\"}"

# Structural intelligence (from #29)
if [[ -n "$PROJECT_ID" ]]; then
  test_endpoint "codebase_impact" GET "/api/v1/codebase/impact?projectId=${PROJECT_ID}&filePath=src/memory/MemoryManager.ts"
  test_endpoint "codebase_blast_radius" GET "/api/v1/codebase/blast-radius?projectId=${PROJECT_ID}&filePath=src/memory/MemoryManager.ts"
  test_endpoint "codebase_dependency_map" GET "/api/v1/codebase/dependency-map?projectId=${PROJECT_ID}"
else
  printf "${YELLOW}  SKIP${NC} %-45s [%s]\n" "codebase_impact" "no-project-id"
  printf "${YELLOW}  SKIP${NC} %-45s [%s]\n" "codebase_blast_radius" "no-project-id"
  printf "${YELLOW}  SKIP${NC} %-45s [%s]\n" "codebase_dependency_map" "no-project-id"
  SKIP=$((SKIP + 3))
  RESULTS+=("SKIP|codebase_impact|no-project-id" "SKIP|codebase_blast_radius|no-project-id" "SKIP|codebase_dependency_map|no-project-id")
fi

# Timeline
if [[ -n "$PROJECT_ID" ]]; then
  test_endpoint "codebase_timeline" GET "/api/v1/codebase/timeline?projectId=${PROJECT_ID}&limit=5"
else
  printf "${YELLOW}  SKIP${NC} %-45s [%s]\n" "codebase_timeline" "no-project-id"
  SKIP=$((SKIP + 1))
  RESULTS+=("SKIP|codebase_timeline|no-project-id")
fi

# =============================================================================
# 5. AGENT MANAGEMENT (agent_*)
# =============================================================================
printf "\n${CYAN}--- Agent Management ---${NC}\n"

test_endpoint "agent_register" POST "/api/v1/agents/register" \
  '{"agentId":"test-agent-001","role":"reviewer","admin":false,"ttlMs":3600000}'

test_endpoint "agent_quota_status" GET "/api/v1/agents/quotas?agentId=test-agent-001"

# =============================================================================
# 6. WORKLOG (worklog_record/list)
# =============================================================================
printf "\n${CYAN}--- Worklog ---${NC}\n"

test_endpoint "worklog_record" POST "/api/v1/worklog" \
  "{\"sessionId\":\"${SESSION_ID}\",\"kind\":\"tool\",\"title\":\"Capability test run\",\"status\":\"success\",\"toolName\":\"test-suite\",\"durationMs\":1234}"

test_endpoint "worklog_record_diagnostics" POST "/api/v1/worklog" \
  "{\"sessionId\":\"${SESSION_ID}\",\"kind\":\"diagnostics\",\"title\":\"TypeScript type check\",\"status\":\"success\",\"toolName\":\"tsc\",\"durationMs\":2500}"

test_endpoint "worklog_list" GET "/api/v1/worklog?sessionId=${SESSION_ID}&limit=10"

# =============================================================================
# 7. MEMORY MANAGEMENT (memory_*)
# =============================================================================
printf "\n${CYAN}--- Memory Management ---${NC}\n"

test_endpoint "memory_stats" GET "/api/v1/memory/stats"
test_endpoint "memory_consolidate" POST "/api/v1/memory/consolidate" '{"maxItems":100}'
test_endpoint "memory_compress" POST "/api/v1/memory/compress" '{"strategy":"heuristic"}'

# =============================================================================
# 8. DIAGNOSTICS (diagnostics_*)
# =============================================================================
printf "\n${CYAN}--- Diagnostics ---${NC}\n"

test_endpoint "diagnostics_ingest_tsc" POST "/api/v1/diagnostics/ingest" \
  "{\"projectId\":\"${DIAG_PROJECT_ID}\",\"treeHash\":\"${DIAG_TREE_HASH}\",\"configHash\":\"${DIAG_CONFIG_HASH}\",\"toolName\":\"tsc\",\"toolVersion\":\"5.9.3\",\"status\":\"failed\",\"findings\":[{\"ruleId\":\"TS1001\",\"message\":\"Type capability fixture\",\"severity\":\"error\",\"location\":{\"filePath\":\"src/example.ts\",\"startLine\":1}}]}"

test_endpoint "diagnostics_ingest_eslint" POST "/api/v1/diagnostics/ingest" \
  "{\"projectId\":\"${DIAG_PROJECT_ID}\",\"treeHash\":\"${DIAG_TREE_HASH}\",\"configHash\":\"${DIAG_CONFIG_HASH}\",\"toolName\":\"eslint\",\"toolVersion\":\"9.0.0\",\"status\":\"failed\",\"findings\":[{\"ruleId\":\"no-unused-vars\",\"message\":\"ESLint capability fixture\",\"severity\":\"warning\",\"location\":{\"filePath\":\"src/example.ts\",\"startLine\":2}}]}"

test_endpoint "diagnostics_latest" GET "/api/v1/diagnostics/latest?projectId=${DIAG_PROJECT_ID}&toolName=tsc&treeHash=${DIAG_TREE_HASH}"
test_endpoint "diagnostics_compare_tools" GET "/api/v1/diagnostics/compare?projectId=${DIAG_PROJECT_ID}&treeHash=${DIAG_TREE_HASH}&toolNames=tsc,eslint"

# =============================================================================
# 9. GRAPH / RELATIONSHIPS (context_query_relationships, lineage, evolution, health)
# =============================================================================
printf "\n${CYAN}--- Graph & Relationships ---${NC}\n"

test_endpoint "context_health (graph)" GET "/api/v1/graph/health"
test_endpoint "context_query_relationships" GET "/api/v1/graph/relationships?entityId=test-capability-1&depth=1"
test_endpoint "context_hybrid_search" POST "/api/v1/graph/hybrid-search" \
  '{"query":"database","limit":5}'
test_endpoint "context_get_lineage" GET "/api/v1/graph/lineage/test-capability-1"
test_endpoint "context_query_evolution" GET "/api/v1/graph/evolution?entityId=test-capability-1"

# =============================================================================
# 10. CAUSAL INFERENCE (search_causes/effects, get_causal_chain, trigger_discovery)
# =============================================================================
printf "\n${CYAN}--- Causal Inference ---${NC}\n"

test_endpoint "search_causes" GET "/api/v1/causal/causes?entityId=test-capability-1&limit=5"
test_endpoint "search_effects" GET "/api/v1/causal/effects?entityId=test-capability-1&limit=5"
test_endpoint "get_causal_chain" GET "/api/v1/causal/chain?startEntityId=test-capability-1&endEntityId=test-decision-1"
test_endpoint "trigger_causal_discovery" POST "/api/v1/causal/discover" '{"text":"Because the database pool was exhausted, API latency increased and users saw timeouts.","persist":false}'

# =============================================================================
# 11. SHELL INTEGRATION
# =============================================================================
printf "\n${CYAN}--- Shell Integration ---${NC}\n"

test_endpoint "shell_event" POST "/api/v1/shell/event" \
  '{"type":"chdir","directory":"/Users/umasankr/Projects/ping-mem"}'

test_endpoint "shell_latest" GET "/api/v1/shell/latest"

# =============================================================================
# 12. MCP TRANSPORT (streamable-http)
# =============================================================================
printf "\n${CYAN}--- MCP Transport ---${NC}\n"

mcp_code=$(curl -sf -o /tmp/pm-mcp-body -w "%{http_code}" -X POST "${BASE}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"capability-test","version":"1.0"}}}')
if [[ "$mcp_code" == "200" ]]; then
  printf "${GREEN}  PASS${NC} %-45s [%s]\n" "mcp_initialize" "$mcp_code"
  PASS=$((PASS + 1))
  RESULTS+=("PASS|mcp_initialize|$mcp_code")
else
  printf "${RED}  FAIL${NC} %-45s [%s]\n" "mcp_initialize" "$mcp_code"
  FAIL=$((FAIL + 1))
  RESULTS+=("FAIL|mcp_initialize|$mcp_code")
fi

# =============================================================================
# 13. CLEANUP
# =============================================================================
printf "\n${CYAN}--- Cleanup ---${NC}\n"

test_endpoint "context_delete" DELETE "/api/v1/context/test-capability-1"
test_endpoint "context_delete_decision" DELETE "/api/v1/context/test-decision-1"
test_endpoint "context_delete_task" DELETE "/api/v1/context/test-task-1"
test_endpoint "agent_deregister" DELETE "/api/v1/agents/test-agent-001"

# End session
if [[ -n "$SESSION_ID" ]]; then
  test_endpoint "context_session_end" POST "/api/v1/session/end" "{\"sessionId\":\"$SESSION_ID\"}"
fi

# =============================================================================
# SUMMARY
# =============================================================================
TOTAL=$((PASS + FAIL + SKIP))

echo ""
echo "=========================================="
printf " Results: ${GREEN}%d PASS${NC} / ${RED}%d FAIL${NC} / ${YELLOW}%d SKIP${NC} / %d TOTAL\n" "$PASS" "$FAIL" "$SKIP" "$TOTAL"
echo "=========================================="

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo "Failed tests:"
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r status name code <<< "$r"
    if [[ "$status" == "FAIL" ]]; then
      printf "  ${RED}FAIL${NC} %s [%s]\n" "$name" "$code"
    fi
  done
fi

if [[ $SKIP -gt 0 ]]; then
  echo ""
  echo "Skipped (503 — service not configured):"
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r status name code <<< "$r"
    if [[ "$status" == "SKIP" ]]; then
      printf "  ${YELLOW}SKIP${NC} %s\n" "$name"
    fi
  done
fi

echo ""
exit $FAIL
