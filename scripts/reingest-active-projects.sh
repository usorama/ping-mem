#!/bin/bash
# Phase 2 remediation (2026-04-18): Force full re-ingest of the 5 active
# projects with maxCommits=10000 + maxCommitAgeDays=365 so that ping-mem
# coverage hits ≥95% commits AND files per project.
#
# Uses admin credentials (rate-limit bypass is live after PR phase 1).
# Host path ~/Projects/<name> maps to container /projects/<name>.
# Skips any project whose host dir doesn't exist.
#
# Compatible with macOS default bash 3.2 — no associative arrays.

set -euo pipefail

PING_MEM_URL="${PING_MEM_URL:-http://localhost:3003}"
ADMIN_USER="${PING_MEM_ADMIN_USER:-admin}"
ADMIN_PASS="${PING_MEM_ADMIN_PASS:-ping-mem-dev-local}"
HOST_PROJECTS_ROOT="${HOST_PROJECTS_ROOT:-$HOME/Projects}"
CONTAINER_PROJECTS_ROOT="${CONTAINER_PROJECTS_ROOT:-/projects}"

PROJECTS="ping-learn ping-mem auto-os ping-guard thrivetree"

# Verify ping-mem is reachable
if ! curl -sf --max-time 5 "${PING_MEM_URL}/health" >/dev/null; then
  echo "ERROR: ping-mem not reachable at ${PING_MEM_URL}" >&2
  exit 2
fi

STATE_DIR="$(mktemp -d -t ping-mem-reingest-XXXXXX)"
trap 'rm -rf "$STATE_DIR"' EXIT

FAIL=0

# --- Phase 1: enqueue all ------------------------------------------------------
for P in $PROJECTS; do
  HOST_DIR="${HOST_PROJECTS_ROOT}/${P}"
  CONTAINER_DIR="${CONTAINER_PROJECTS_ROOT}/${P}"

  if [ ! -d "$HOST_DIR" ]; then
    echo "$P: SKIP (host dir not found: $HOST_DIR)" >&2
    continue
  fi

  START_MS=$(( $(date +%s) * 1000 ))
  RESPONSE=$(curl -sf --max-time 10 -u "${ADMIN_USER}:${ADMIN_PASS}" \
    -X POST "${PING_MEM_URL}/api/v1/ingestion/enqueue" \
    -H 'Content-Type: application/json' \
    -d "{\"projectDir\":\"${CONTAINER_DIR}\",\"forceReingest\":true,\"maxCommits\":10000,\"maxCommitAgeDays\":365}" 2>&1) \
    && CURL_OK=1 || CURL_OK=0

  if [ "$CURL_OK" -ne 1 ]; then
    echo "$P: FAIL enqueue — $RESPONSE" >&2
    FAIL=$((FAIL + 1))
    continue
  fi

  RUN_ID=$(echo "$RESPONSE" | /usr/bin/jq -r '.runId // empty' 2>/dev/null || echo "")
  if [ -z "$RUN_ID" ]; then
    echo "$P: FAIL — no runId in response: $RESPONSE" >&2
    FAIL=$((FAIL + 1))
    continue
  fi

  echo "$RUN_ID" > "$STATE_DIR/$P.runid"
  echo "$START_MS" > "$STATE_DIR/$P.start_ms"
  echo "$P: enqueued runId=$RUN_ID at ${HOST_DIR} -> ${CONTAINER_DIR}"
done

# --- Phase 2: poll completion --------------------------------------------------
# Budget: queue is serial; ping-learn is biggest (~657 commits × diff per commit).
# A-PERF-4 allows 20min for ping-learn alone; allow 45min total to give headroom.
BUDGET_SEC="${REINGEST_BUDGET_SEC:-2700}"
DEADLINE=$(( $(date +%s) + BUDGET_SEC ))

echo ""
echo "Polling ingestion runs (budget: ${BUDGET_SEC}s, deadline: $(date -r $DEADLINE '+%H:%M:%S'))..."

for P in $PROJECTS; do
  RUN_ID_FILE="$STATE_DIR/$P.runid"
  [ -f "$RUN_ID_FILE" ] || continue
  RUN_ID=$(cat "$RUN_ID_FILE")
  [ -z "$RUN_ID" ] && continue

  while :; do
    NOW=$(date +%s)
    if [ "$NOW" -gt "$DEADLINE" ]; then
      echo "$P: TIMEOUT after ${BUDGET_SEC}s (deadline reached)" >&2
      FAIL=$((FAIL + 1))
      break
    fi

    STATUS_JSON=$(curl -sf --max-time 10 -u "${ADMIN_USER}:${ADMIN_PASS}" \
      "${PING_MEM_URL}/api/v1/ingestion/run/${RUN_ID}" 2>&1) || STATUS_JSON=""
    STATUS=$(echo "$STATUS_JSON" | /usr/bin/jq -r '.status // "unknown"' 2>/dev/null || echo "unknown")

    case "$STATUS" in
      completed)
        END_MS=$(( $(date +%s) * 1000 ))
        START_MS=$(cat "$STATE_DIR/$P.start_ms" 2>/dev/null || echo 0)
        DURATION_MS=$((END_MS - START_MS))
        FILES=$(echo "$STATUS_JSON" | /usr/bin/jq -r '.result.filesIndexed // 0')
        COMMITS=$(echo "$STATUS_JSON" | /usr/bin/jq -r '.result.commitsIndexed // 0')
        echo "$P: COMPLETED in ${DURATION_MS}ms (files=$FILES commits=$COMMITS)"
        echo "$DURATION_MS" > "$STATE_DIR/$P.duration_ms"
        break
        ;;
      failed)
        ERR=$(echo "$STATUS_JSON" | /usr/bin/jq -r '.error // "(no error)"')
        echo "$P: FAILED — $ERR" >&2
        FAIL=$((FAIL + 1))
        break
        ;;
      queued|scanning|chunking|persisting_neo4j|indexing_qdrant)
        sleep 3
        ;;
      *)
        echo "$P: unknown status '$STATUS' (raw: $STATUS_JSON)" >&2
        sleep 3
        ;;
    esac
  done
done

# --- Phase 3: persist timings --------------------------------------------------
DURATION_FILE="${TMPDIR:-/tmp}/ping-mem-reingest-durations.json"
{
  echo "{"
  FIRST=1
  for P in $PROJECTS; do
    DUR=$(cat "$STATE_DIR/$P.duration_ms" 2>/dev/null || echo "null")
    if [ "$FIRST" -eq 0 ]; then echo ","; fi
    printf '  "%s": %s' "$P" "$DUR"
    FIRST=0
  done
  echo ""
  echo "}"
} > "$DURATION_FILE"
echo "Durations written to $DURATION_FILE"

if [ "$FAIL" -gt 0 ]; then
  echo "ERROR: $FAIL project(s) failed to re-ingest" >&2
  exit 1
fi

echo "OK: all projects re-ingested successfully"
