#!/bin/bash
# cleanup-disk.sh — free disk space to keep macOS below the 85% ceiling.
#
# Phase 4 / P4.1 of the ping-mem remediation plan. Disk at >=85% triggers
# cascading failures (ingest stalls, log rotation fails, node_modules sync
# breaks). This script prunes regenerable caches.
#
# Safety (A-SAFE-1): before rm-ing Playwright or .next caches, we check for
# running processes that may still hold file handles. Corrupting a live
# playwright run or Next dev server has bitten users before — we skip those
# dirs if the processes are up.
#
# Idempotent. Non-fatal: missing tool (docker, find) prints a warning and
# continues. Prints pre + post disk usage so the gate evidence is self-contained.

set -uo pipefail

LOG_PREFIX="cleanup-disk"
log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') ${LOG_PREFIX}: $*"
}

disk_line() {
  df -h /System/Volumes/Data | tail -1
}

disk_pct() {
  df -h /System/Volumes/Data | tail -1 | awk '{print $5}'
}

log "Pre: $(disk_line)"
PRE_PCT=$(disk_pct)
log "Pre disk pct: ${PRE_PCT}"

# 1. Docker build cache — usually the largest single win
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    log "Pruning docker builder cache"
    docker builder prune -af 2>&1 | tail -3 || log "docker builder prune failed (non-fatal)"
  else
    log "docker daemon not reachable; skipping builder prune"
  fi
else
  log "docker CLI absent; skipping builder prune"
fi

# 2. Xcode derived data
if [ -d "$HOME/Library/Developer/Xcode/DerivedData" ]; then
  log "Clearing Xcode DerivedData"
  rm -rf "$HOME/Library/Developer/Xcode/DerivedData"/* 2>/dev/null || true
fi

# 3. Playwright caches — SKIP if playwright is running (A-SAFE-1)
if pgrep -f 'playwright' >/dev/null 2>&1; then
  log "SKIP ms-playwright: active playwright process detected"
else
  if [ -d "$HOME/Library/Caches/ms-playwright" ]; then
    log "Clearing ~/Library/Caches/ms-playwright"
    rm -rf "$HOME/Library/Caches/ms-playwright"/* 2>/dev/null || true
  fi
fi

# 4. Homebrew download cache
if [ -d "$HOME/Library/Caches/Homebrew/downloads" ]; then
  log "Clearing Homebrew downloads cache"
  rm -rf "$HOME/Library/Caches/Homebrew/downloads"/* 2>/dev/null || true
fi

# 5. Old node_modules in worktrees (14d+)
log "Pruning worktree node_modules older than 14d"
find "$HOME/Projects"/*/.worktrees -maxdepth 3 -name "node_modules" -type d -mtime +14 -exec rm -rf {} + 2>/dev/null || true

# 6. Old .next caches in worktrees (14d+) — SKIP if next dev is running (A-SAFE-1)
if pgrep -f 'next dev' >/dev/null 2>&1; then
  log "SKIP worktree .next caches: active 'next dev' process detected"
else
  log "Pruning worktree .next caches older than 14d"
  find "$HOME/Projects"/*/.worktrees -maxdepth 3 -name ".next" -type d -mtime +14 -exec rm -rf {} + 2>/dev/null || true
fi

# 7. pip cache
if [ -d "$HOME/Library/Caches/pip" ]; then
  log "Clearing pip cache"
  rm -rf "$HOME/Library/Caches/pip"/* 2>/dev/null || true
fi

log "Post: $(disk_line)"
POST_PCT=$(disk_pct)
log "Post disk pct: ${POST_PCT}"

# Gate: assert <= 85%
POST_NUM=${POST_PCT%\%}
if [ "${POST_NUM}" -gt 85 ]; then
  log "GATE-FAIL: disk still ${POST_PCT} (>85%)"
  exit 2
fi
log "GATE-PASS: disk at ${POST_PCT} (<=85%)"
exit 0
