#!/usr/bin/env bash
# Nightly Improvement Loop for ping-mem
#
# Orchestrates: baseline eval -> Claude headless improvement -> post eval -> keep/discard
# ONE improvement per night. Blue instance is NEVER modified.
#
# Usage: ./scripts/nightly-improvement.sh [--dry-run]
# Scheduling: launchd plist or cron at 2 AM
#
# Prerequisites:
#   - docker compose running (Blue instance on port 3000)
#   - claude CLI installed and authenticated
#   - bun installed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
IMPROVEMENTS_DIR="$PROJECT_DIR/.ai/eval/improvements"
IMPROVEMENTS_TSV="$IMPROVEMENTS_DIR/improvements.tsv"
LOG_FILE="$IMPROVEMENTS_DIR/nightly-$(date +%Y-%m-%d).log"
DRY_RUN="${1:-}"
MAX_TURNS=15
GREEN_PORT=3001
BLUE_PORT=3000

# Ensure improvements directory exists
mkdir -p "$IMPROVEMENTS_DIR"

log() {
  local msg="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1"
  echo "$msg" | tee -a "$LOG_FILE"
}

cleanup() {
  log "Cleaning up: stopping Green instance..."
  cd "$PROJECT_DIR"
  docker compose -f docker-compose.yml -f docker-compose.improvement.yml --profile improvement stop ping-mem-green 2>/dev/null || true
}
trap cleanup EXIT

log "=== Nightly Improvement Run ==="
log "Project: $PROJECT_DIR"
log "Dry run: ${DRY_RUN:-no}"

# Step 1: Check budget via TypeScript wrapper
log "Step 1: Checking improvement budget..."
BUDGET_CHECK=$(cd "$PROJECT_DIR" && bun run src/eval/improvement-loop.ts check-budget 2>&1)
if echo "$BUDGET_CHECK" | grep -q "BUDGET_EXHAUSTED"; then
  log "Budget exhausted — skipping nightly run"
  exit 0
fi
log "Budget OK: $BUDGET_CHECK"

# Step 2: Snapshot Blue data to Green volume
log "Step 2: Snapshotting Blue data to Green volume..."
docker volume rm ping-mem-green-data 2>/dev/null || true
docker volume create ping-mem-green-data
# Copy Blue data to Green via temporary container
docker run --rm \
  -v ping-mem-data:/source:ro \
  -v ping-mem-green-data:/dest \
  alpine sh -c "cp -a /source/. /dest/" 2>&1 | tee -a "$LOG_FILE"
log "Data snapshot complete"

# Step 3: Start Green instance
log "Step 3: Starting Green instance on port $GREEN_PORT..."
cd "$PROJECT_DIR"
docker compose -f docker-compose.yml -f docker-compose.improvement.yml --profile improvement up -d ping-mem-green 2>&1 | tee -a "$LOG_FILE"

# Wait for Green to be healthy
log "Waiting for Green instance to be healthy..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$GREEN_PORT/health" > /dev/null 2>&1; then
    log "Green instance healthy after ${i}s"
    break
  fi
  if [ "$i" -eq 30 ]; then
    log "ERROR: Green instance did not become healthy after 30s"
    exit 1
  fi
  sleep 1
done

# Step 4: Run baseline eval
log "Step 4: Running baseline eval on Green..."
BASELINE=$(cd "$PROJECT_DIR" && bun run src/eval/improvement-loop.ts run-baseline 2>&1)
BASELINE_RECALL=$(echo "$BASELINE" | grep "meanRecallAt10" | head -1 | sed 's/.*: //')
log "Baseline Recall@10: ${BASELINE_RECALL:-unknown}"

if [ "$DRY_RUN" = "--dry-run" ]; then
  log "Dry run — skipping Claude improvement and post-eval"
  log "Would spawn: claude -p 'Improve ping-mem search quality...'"
  exit 0
fi

# Step 5: Spawn ONE Claude Code headless session for improvement
log "Step 5: Spawning Claude headless for ONE improvement..."
IMPROVEMENT_PROMPT="Improve ping-mem search quality. Current Recall@10: ${BASELINE_RECALL:-0}.
Target: > 0.95. You may modify search weights, BM25 parameters,
embedding preprocessing, or chunking strategy in src/search/.
Do NOT modify the eval suite (src/eval/), test files, or docker configs.
Run 'bun test' to verify no regressions. Make exactly ONE focused change."

cd "$PROJECT_DIR"
claude --headless \
  --model claude-sonnet-4-20250514 \
  --max-turns "$MAX_TURNS" \
  -p "$IMPROVEMENT_PROMPT" \
  2>&1 | tee -a "$LOG_FILE" || {
    log "WARNING: Claude session exited with non-zero status"
  }

# Step 6: Verify tests still pass
log "Step 6: Verifying tests..."
cd "$PROJECT_DIR"
if ! bun run typecheck 2>&1 | tee -a "$LOG_FILE"; then
  log "DISCARD: typecheck failed after improvement"
  git stash push -m "nightly-improvement-discard-$(date +%Y%m%d)" 2>/dev/null || true
  cd "$PROJECT_DIR" && bun run src/eval/improvement-loop.ts record-result discard "typecheck failed" 2>&1
  exit 0
fi
if ! bun test 2>&1 | tee -a "$LOG_FILE"; then
  log "DISCARD: tests failed after improvement"
  git stash push -m "nightly-improvement-discard-$(date +%Y%m%d)" 2>/dev/null || true
  cd "$PROJECT_DIR" && bun run src/eval/improvement-loop.ts record-result discard "tests failed" 2>&1
  exit 0
fi

# Step 7: Run post-improvement eval
log "Step 7: Running post-improvement eval..."
POST_RESULT=$(cd "$PROJECT_DIR" && bun run src/eval/improvement-loop.ts run-post 2>&1)

# Step 8: Compare and decide keep/discard
log "Step 8: Comparing scores..."
DECISION=$(cd "$PROJECT_DIR" && bun run src/eval/improvement-loop.ts compare 2>&1)

if echo "$DECISION" | grep -q "KEEP"; then
  log "KEEP: Improvement accepted!"
  cd "$PROJECT_DIR"
  git add -A
  git commit -m "nightly-improvement: $(date +%Y-%m-%d) — search quality improvement

Automated improvement via nightly-improvement.sh.
Eval delta: see .ai/eval/improvements/improvements.tsv"
  log "Changes committed"
else
  log "DISCARD: No improvement or regression detected"
  cd "$PROJECT_DIR"
  git stash push -m "nightly-improvement-discard-$(date +%Y%m%d)" 2>/dev/null || true
fi

log "=== Nightly Improvement Run Complete ==="
