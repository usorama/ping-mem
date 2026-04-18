---
phase-id: P4
title: "Lifecycle + supervisor + OrbStack + logs — E.1–E.3 + E.5"
status: pending
effort_estimate: 4h
dependent-on: phase-0-prep
owns_wiring: [W15, W16, W17, W19]
owns_outcomes: [O6, O7, O9]
addresses_gaps: [E.1, E.2, E.3, E.5]
adr_refs: [ADR-4, ADR-5, A-DOM-3 (daemon ProcessType), A-HIGH-3 (OrbStack wake), A-SAFE-4 (newsyslog user-space fallback), CF2 (watchdog plist), CF3 (pgrep guards)]
blocks: ["phase-5-observability-doctor (doctor lifecycle gates: disk-below-85, log-rotation-last-7d, supervisor-no-rollback, supervisor-watchdog-loaded, orbstack-reachable)", "phase-7-soak-regression (30-day soak reliability)"]
research_refs:
  - docs/ping-mem-remediation-research/02-ping-guard-remediation.md
  - docs/ping-mem-remediation-research/05-lifecycle-resilience.md
  - docs/ping-mem-remediation-research/07-synthesis.md (ADR-4, ADR-5)
---

# Phase 4 — Lifecycle + Supervisor + OrbStack + Log Rotation

## Phase Goal

Deliver **O6** (Mac sleep/wake restores capability in <30s), **O7** (disk stays ≤85% for 30 consecutive days), and **O9** (0 silent supervisor rollbacks in 30 consecutive days). Owns gaps **E.1** (disk ≤85% sustained), **E.2** (log rotation), **E.3** (supervisor no rollback + EMERGENCY_STOP recoverable via watchdog plist), and **E.5** (OrbStack resumes on wake).

P4 does NOT own **E.4** (session cap + reaper) — that moved to P1 per ADR-1 because it lives inside `src/session/SessionManager.ts`, not in the ping-guard lifecycle surface. P4 does NOT own the `_reconcile_scheduled()` removal in `wake_detector.py` — P3 owns that (P3.4). P4 only ADDS `_start_orbstack()` and its call inside `handleWakeNotification_`.

Outcome measurements, binary:

- **O6**: `pmset sleepnow` → Mac wakes → within 30s of wake `curl -sf -u "$CREDS" http://localhost:3003/health` returns 200 AND `mcp__ping-mem__context_health` returns healthy. Wake-detector log shows `orbctl start` succeeded. 3 consecutive wake trials all pass.
- **O7**: `df -P /System/Volumes/Data | awk 'NR==2 {sub(/%/,"",$5); print ($5<=85)}'` prints `1`, and continues to print `1` every day for 30 days (enforced by P5 `disk-below-85` gate).
- **O9**: `grep -c "Rolled back" ~/Library/Logs/ping-guard/supervisor.log` (post-P4.3 cut-off) stays at 0 for 30 days. On EMERGENCY_STOP + Mac reboot, ping-guard comes back online within 60s via the watchdog plist.

## Pre-conditions

Inherited from P0 and unaffected by P3's concurrent edits (`wake_detector.py` line-removal and `manifests/ping-mem.yaml` changes are independent of P4 surgery targets):

- P0 complete: branch `fix/ping-mem-complete-remediation` active, baseline JSON at `/tmp/ping-mem-remediation-baseline.json`, `~/.claude.json` perm 600, stale judge procs killed, git tag `remediation-baseline-$(date +%Y-%m-%d)` present.
- **P3.4 already committed**: `wake_detector.py` has had `_reconcile_scheduled()` function (old lines 40–51) and its call + `time.sleep(5)` at old line 94–95 removed. P4's insertion point is "immediately after the `_kickstart()` function definition" — DO NOT use absolute line numbers because P3 shifted them.
- `orbctl` is on PATH (`/opt/homebrew/bin/orbctl`, verified 2026-04-18 via `which orbctl`) — P4.4 falls back gracefully if missing.
- `~/Library/Logs/ping-guard/` exists and is writable; daemon log handles are held by launchd.
- `~/Library/LaunchAgents/com.ping-guard.daemon.plist` exists (verified: 1357 bytes, present on disk); P4.5 patches it in place.
- `/etc/newsyslog.d/` directory exists (macOS default). If sudo is unavailable, P4.2 falls back to user-space launchd rotation.
- Backup directory writable: `mkdir -p ~/Projects/ping-mem/.backups && touch ~/Projects/ping-mem/.backups/.writable && rm ~/Projects/ping-mem/.backups/.writable`.

---

## Tasks

### P4.1 — `scripts/cleanup-disk.sh` with pgrep guards (E.1, W15)

**Purpose**: codify the disk-reclamation operation that orchestrator already performed in-session (reclaimed 55 GB: 97% → 84%). Idempotent, safe to re-run from cron or from the P5 doctor `disk-below-85` remediation hint. Judge finding CF3 verified in all 3 reviews that the superseded plan body had unconditional `rm -rf ~/Library/Caches/ms-playwright/*` and `.next` deletion with pgrep guards only mentioned in an amendments log. This task body carries the pgrep guards directly — no amendments, no deferrals.

**File**: `/Users/umasankr/Projects/ping-mem/scripts/cleanup-disk.sh` (ping-mem repo; referenced from P5 doctor remediation hints).

**Backup**: N/A (new file). On re-run, the log file is rotated by timestamp.

**Create**:

```bash
#!/usr/bin/env bash
# cleanup-disk.sh — guarded disk reclamation for the ping-mem host.
# Idempotent. Safe to re-run. Never touches Docker volumes (ping-mem Neo4j/Qdrant data).
# Targets: Docker build cache, Xcode DerivedData, Playwright cache, Homebrew downloads,
#          pip cache, worktree .next (>14d old), .Trash, simulator caches.
# Guards:  pgrep before every destructive rm against a running tool that owns the cache.
#
# Usage: bash scripts/cleanup-disk.sh
# Log:   /tmp/cleanup-disk-<epoch>.log
set -eu
# NB: do NOT use `-o pipefail` here — a guard's grep returning "no match" is not an error.

LOG="/tmp/cleanup-disk-$(date +%s).log"
exec > >(tee -a "$LOG") 2>&1
echo "[cleanup-disk] start $(date -u +%Y-%m-%dT%H:%M:%SZ) log=$LOG"

BEFORE_PCT=$(df -P /System/Volumes/Data | awk 'NR==2 {sub(/%/,"",$5); print $5}')
echo "[cleanup-disk] disk-before=${BEFORE_PCT}%"

# --------- Guarded destructive blocks (each block is independent) -----------

# 1) Playwright cache — 3.3 GB typical. Skip if any test runner owns it.
if pgrep -f 'ms-playwright' >/dev/null 2>&1; then
  echo "[cleanup-disk] skip playwright cache (process running)"
else
  rm -rf "$HOME/Library/Caches/ms-playwright"/* 2>/dev/null || true
  echo "[cleanup-disk] playwright cache cleared"
fi

# 2) Stale .next build dirs in worktrees (mtime > 14d, not touched recently).
#    Guarded: if any `next dev` is running, skip (can't be sure which .next it owns).
if pgrep -f 'next dev' >/dev/null 2>&1; then
  echo "[cleanup-disk] skip worktree .next (next dev running)"
else
  find "$HOME/Projects" -maxdepth 5 -path '*/.worktrees/*/.next' -type d -mtime +14 -prune -exec rm -rf {} + 2>/dev/null || true
  find "$HOME/Projects"/*/.worktrees -maxdepth 3 -name '.next' -type d -mtime +14 -exec rm -rf {} + 2>/dev/null || true
  echo "[cleanup-disk] stale .next dirs (>14d) cleared"
fi

# 3) Xcode DerivedData — skip if xcodebuild is active.
if pgrep -xq xcodebuild; then
  echo "[cleanup-disk] skip DerivedData (xcodebuild running)"
else
  rm -rf "$HOME/Library/Developer/Xcode/DerivedData"/* 2>/dev/null || true
  echo "[cleanup-disk] Xcode DerivedData cleared"
fi

# 4) Simulator caches — best-effort, same guard as #3.
if pgrep -xq xcodebuild || pgrep -xq Simulator; then
  echo "[cleanup-disk] skip simulator caches (xcodebuild/Simulator running)"
else
  xcrun simctl delete unavailable 2>/dev/null || true
  rm -rf "$HOME/Library/Developer/CoreSimulator/Caches"/* 2>/dev/null || true
  echo "[cleanup-disk] simulator unavailable + caches cleared"
fi

# 5) Homebrew downloads — skip if brew is actively running (install/upgrade).
if pgrep -xq brew; then
  echo "[cleanup-disk] skip Homebrew downloads (brew running)"
else
  rm -rf "$HOME/Library/Caches/Homebrew/downloads"/* 2>/dev/null || true
  rm -rf "$HOME/Library/Caches/Homebrew/api"/* 2>/dev/null || true
  echo "[cleanup-disk] Homebrew downloads cleared"
fi

# 6) pip cache — skip if pip is actively running.
if pgrep -f 'pip (install|download|wheel)' >/dev/null 2>&1; then
  echo "[cleanup-disk] skip pip cache (pip running)"
else
  rm -rf "$HOME/Library/Caches/pip"/* 2>/dev/null || true
  echo "[cleanup-disk] pip cache cleared"
fi

# 7) .Trash — always safe (OS-level trash is user-owned).
rm -rf "$HOME/.Trash"/* 2>/dev/null || true
echo "[cleanup-disk] .Trash cleared"

# --------- Docker prune (NEVER prune volumes — ping-mem data lives there) -----

# Guards: if any `docker build` or `docker compose up` is running, skip build-cache prune.
if pgrep -f 'docker (build|buildx)' >/dev/null 2>&1; then
  echo "[cleanup-disk] skip docker build cache (build running)"
else
  docker builder prune -af 2>/dev/null || true
  echo "[cleanup-disk] docker build cache pruned"
fi

docker container prune -f 2>/dev/null || true
echo "[cleanup-disk] stopped containers pruned"

docker image prune -af 2>/dev/null || true
echo "[cleanup-disk] dangling + unreferenced images pruned"

# --------- Report -----------------------------------------------------------

AFTER_PCT=$(df -P /System/Volumes/Data | awk 'NR==2 {sub(/%/,"",$5); print $5}')
echo "[cleanup-disk] disk-after=${AFTER_PCT}% (was ${BEFORE_PCT}%)"
echo "[cleanup-disk] done $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Exit 0 always — best-effort cleanup; caller (doctor) inspects `df -P` directly.
exit 0
```

**Permissions**: `chmod +x /Users/umasankr/Projects/ping-mem/scripts/cleanup-disk.sh`

**Safety invariants** (all must hold for a safe re-run):

1. **No `docker volume prune`** — ping-mem Neo4j/Qdrant data lives in named volumes `ping-mem-neo4j-data`, `ping-mem-qdrant-data`, `ping-mem-data` (confirmed in `docker-compose.yml` lines 115–122). Pruning volumes would delete all memories.
2. **No `docker system prune --volumes`** — same reason.
3. **No `rm` under `~/Projects/**`** except `.worktrees/*/.next` with mtime>14d. Active code is never touched.
4. **Every pgrep guard returns 0 (match) → skip**; returns 1 (no match) → proceed. `|| true` after each `pgrep` prevents `set -e` from killing the script when a guard finds nothing.
5. The `find ... -mtime +14` clause limits .next deletion to directories untouched for 14+ days — active dev branches are safe.

**Lint gate**: `shellcheck /Users/umasankr/Projects/ping-mem/scripts/cleanup-disk.sh` — MUST exit 0 (SC1091 "not following" is acceptable since this script has no sourced files).

---

### P4.2 — Log rotation: newsyslog (sudo) OR user-space launchd fallback (E.2, W16)

**Purpose**: bound `~/Library/Logs/ping-guard/{daemon,supervisor,wake-detector,auto-os}.{log,err}` growth. Evidence 2026-04-18: `auto-os.err` 9.4 MB, `daemon.err` 6.7 MB, no rotation. Without this the logs consume disk and hide recent entries behind old noise.

**Primary path (sudo available)** — install `/etc/newsyslog.d/ping-guard.conf` via `sudo tee`:

**Backup**: if the file already exists (unlikely), `sudo cp -a /etc/newsyslog.d/ping-guard.conf /etc/newsyslog.d/ping-guard.conf.bak.$(date +%s)`.

**Create** `/etc/newsyslog.d/ping-guard.conf`:

```conf
# ping-guard log rotation — added by ping-mem remediation P4.2
# Columns: logfilename                                             [owner:group]  mode count size(KB) when flags
/Users/umasankr/Library/Logs/ping-guard/auto-os.err               umasankr:staff 644  3     5120     *    GJ
/Users/umasankr/Library/Logs/ping-guard/auto-os.log               umasankr:staff 644  3     5120     *    GJ
/Users/umasankr/Library/Logs/ping-guard/daemon.err                umasankr:staff 644  3     5120     *    GJ
/Users/umasankr/Library/Logs/ping-guard/daemon.log                umasankr:staff 644  3     5120     *    GJ
/Users/umasankr/Library/Logs/ping-guard/supervisor.err            umasankr:staff 644  3     5120     *    GJ
/Users/umasankr/Library/Logs/ping-guard/supervisor.log            umasankr:staff 644  3     5120     *    GJ
/Users/umasankr/Library/Logs/ping-guard/wake-detector.err         umasankr:staff 644  3     5120     *    GJ
/Users/umasankr/Library/Logs/ping-guard/wake-detector.log         umasankr:staff 644  3     5120     *    GJ
```

Columns: `size=5120` KB (rotate at 5 MB), `count=3` (keep 3 archives), `when=*` (size trigger only — no time-based), `G` (glob), `J` (bzip2 compress). All 8 files explicitly listed (avoids wildcard ambiguity where newsyslog might match the rotated archives themselves).

**Install + truncate**:

```bash
sudo tee /etc/newsyslog.d/ping-guard.conf >/dev/null <<'EOF'
<contents above>
EOF
sudo chmod 644 /etc/newsyslog.d/ping-guard.conf
sudo newsyslog -nv /etc/newsyslog.d/ping-guard.conf   # dry-run parser check, expect "OK"
sudo newsyslog   /etc/newsyslog.d/ping-guard.conf     # force first pass
```

One-time truncation (launchd holds fds; `:>` truncates in place without breaking the fd):

```bash
: > ~/Library/Logs/ping-guard/auto-os.err
: > ~/Library/Logs/ping-guard/daemon.err
launchctl kickstart -k "gui/$(id -u)/com.ping-guard.daemon"
launchctl kickstart -k "gui/$(id -u)/com.ping-guard.auto-os"
```

**Fallback path (sudo unavailable)** — user-space launchd plist. Judge finding A-SAFE-4 required both options be documented.

**File 1 (fallback)**: `/Users/umasankr/Projects/ping-mem/scripts/rotate-ping-guard-logs.sh`

```bash
#!/usr/bin/env bash
# rotate-ping-guard-logs.sh — user-space daily log rotation when sudo is unavailable.
# Rotates any file > 5 MB; keeps 3 archives; gzips them.
set -eu

LOG_DIR="$HOME/Library/Logs/ping-guard"
MAX_BYTES=$((5 * 1024 * 1024))
KEEP=3

cd "$LOG_DIR" 2>/dev/null || exit 0

for f in daemon.log daemon.err supervisor.log supervisor.err wake-detector.log wake-detector.err auto-os.log auto-os.err; do
  [ -f "$f" ] || continue
  bytes=$(stat -f %z "$f" 2>/dev/null || echo 0)
  [ "$bytes" -lt "$MAX_BYTES" ] && continue

  # Shift archives: .2 → .3, .1 → .2, (current) → .1
  for i in $(seq $((KEEP - 1)) -1 1); do
    if [ -f "${f}.${i}.gz" ]; then
      mv -f "${f}.${i}.gz" "${f}.$((i + 1)).gz"
    fi
  done
  # Copy + truncate in place (preserves launchd-held fd)
  cp "$f" "${f}.1"
  : > "$f"
  gzip -f "${f}.1"
done

# Drop the oldest past KEEP
for f in *.gz; do
  [ -f "$f" ] || continue
  idx="${f##*.}"  # won't work directly; use pattern below
done
# simpler: remove any archive with index > KEEP
find "$LOG_DIR" -maxdepth 1 -type f -name "*.gz" | while IFS= read -r archive; do
  idx=$(echo "$archive" | sed -E 's/.*\.([0-9]+)\.gz$/\1/')
  case "$idx" in
    ''|*[!0-9]*) continue ;;
  esac
  if [ "$idx" -gt "$KEEP" ]; then
    rm -f "$archive"
  fi
done
```

`chmod +x /Users/umasankr/Projects/ping-mem/scripts/rotate-ping-guard-logs.sh`

**File 2 (fallback plist)**: `~/Library/LaunchAgents/com.ping-guard.log-rotate.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ping-guard.log-rotate</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/umasankr/Projects/ping-mem/scripts/rotate-ping-guard-logs.sh</string>
    </array>
    <key>StartInterval</key>
    <integer>86400</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/umasankr/Library/Logs/ping-guard/log-rotate.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/umasankr/Library/Logs/ping-guard/log-rotate.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/umasankr</string>
    </dict>
</dict>
</plist>
```

Install:

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.ping-guard.log-rotate.plist
launchctl kickstart -k "gui/$(id -u)/com.ping-guard.log-rotate"
launchctl list com.ping-guard.log-rotate   # expect PID line and last-exit-status 0
```

**Execution choice at phase runtime**:

```bash
if sudo -n true 2>/dev/null; then
  echo "P4.2: installing newsyslog (sudo available)"
  # run primary path
else
  echo "P4.2: sudo unavailable — installing user-space log-rotate launchd"
  # run fallback path
fi
```

**Doctor gate coupling**: P5's `log-rotation-last-7d` gate works with EITHER mechanism — it greps for a rotated `.gz` archive modified within the last 7 days under `~/Library/Logs/ping-guard/` (both newsyslog and the user-space script produce `.gz` archives).

---

### P4.3 — Supervisor rewrite: keep-forward + 3-retry + EMERGENCY_STOP (E.3, W17)

**Purpose**: eliminate silent rollbacks. Evidence: `supervisor.log` recorded 2 rollbacks in 4 days (2026-04-14, 2026-04-16) that reverted ping-guard daemon to a mid-March commit, destroying recent remediation work. ADR-4 mandates keep-forward mode with 3-retry kickstart, exponential backoff, and EMERGENCY_STOP escalation — no git checkout anywhere.

**File**: `~/Projects/ping-guard/scripts/supervisor.sh` — full rewrite, ~60 lines.

**Backup**:

```bash
cp -a ~/Projects/ping-guard/scripts/supervisor.sh ~/Projects/ping-guard/scripts/supervisor.sh.bak.$(date +%s)
```

**Full file contents (replace existing entirely)**:

```bash
#!/bin/bash
# supervisor.sh — ping-guard external watchdog (ADR-4: keep-forward, no rollback).
#
# Policy:
#   - Monitor /tmp/ping-guard-heartbeat freshness (VERIFY_WINDOW=180s).
#   - On stale: 3 kickstart attempts with backoff 5s, 15s, 45s.
#   - If all 3 fail: EMERGENCY_STOP — bootout the daemon, write EMERGENCY_STOP
#     marker, osascript notify the user, exit 1. The launchd-managed
#     com.ping-guard.watchdog plist (installed in P4.3a) re-bootstraps ping-guard
#     on next boot so the STOP is recoverable.
#   - EMERGENCY_STOP marker at $PROJECT_DIR/EMERGENCY_STOP is respected on
#     subsequent runs: if present, skip all work and idle. Human removes it
#     manually; watchdog plist re-bootstraps once removed.
#   - NEVER `git checkout`, NEVER `git stash`, NEVER read last-good-commit.
#     Rollback is the root cause of ADR-4 — it is gone.

set -uo pipefail

HEARTBEAT_FILE="/tmp/ping-guard-heartbeat"
PROJECT_DIR="/Users/umasankr/Projects/ping-guard"
VERIFY_WINDOW=180
UID_NUM=$(id -u)
DAEMON_LABEL="com.ping-guard.daemon"
LOG_FILE="$HOME/Library/Logs/ping-guard/supervisor.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') SUPERVISOR: $*" >> "$LOG_FILE"; }

notify() {
  /usr/bin/osascript -e "display notification \"$1\" with title \"ping-guard supervisor\"" 2>/dev/null || true
}

# 3-retry kickstart with 5s, 15s, 45s backoff. Returns 0 if daemon recovers, 1 otherwise.
attempt_kickstart_with_backoff() {
  local backoffs=(5 15 45)
  for i in 0 1 2; do
    log "Kickstart attempt $((i+1))/3"
    launchctl kickstart -k "gui/$UID_NUM/$DAEMON_LABEL" 2>/dev/null || true
    sleep "${backoffs[$i]}"
    if [ -f "$HEARTBEAT_FILE" ]; then
      local age
      age=$(($(date +%s) - $(stat -f %m "$HEARTBEAT_FILE")))
      if [ "$age" -lt "$VERIFY_WINDOW" ]; then
        log "Recovered on attempt $((i+1)) (age=${age}s)"
        return 0
      fi
    fi
  done
  return 1
}

emergency_stop() {
  log "EMERGENCY_STOP: 3 kickstart attempts exhausted. Halting daemon."
  launchctl bootout "gui/$UID_NUM/$DAEMON_LABEL" 2>/dev/null || true
  touch "$PROJECT_DIR/EMERGENCY_STOP"
  notify "ping-guard EMERGENCY_STOP — daemon halted. Watchdog will re-bootstrap on next boot. Remove $PROJECT_DIR/EMERGENCY_STOP manually to resume now."
  exit 1
}

mkdir -p "$(dirname "$LOG_FILE")"
log "Starting supervisor (PID $$, policy=keep-forward)"

while true; do
  sleep 30

  # Respect operator EMERGENCY_STOP marker (set by hand OR by previous emergency_stop).
  if [ -f "$PROJECT_DIR/EMERGENCY_STOP" ]; then
    log "EMERGENCY_STOP marker present. Idling (no kickstart, no rollback)."
    continue
  fi

  if [ -f "$HEARTBEAT_FILE" ]; then
    AGE=$(($(date +%s) - $(stat -f %m "$HEARTBEAT_FILE")))
    if [ "$AGE" -gt "$VERIFY_WINDOW" ]; then
      log "Heartbeat stale (${AGE}s > ${VERIFY_WINDOW}s). Keep-forward: 3 kickstart attempts."
      if attempt_kickstart_with_backoff; then
        log "Daemon recovered — no rollback needed."
      else
        emergency_stop
      fi
    fi
  else
    log "No heartbeat file. Checking daemon launchd status."
    if ! launchctl print "gui/$UID_NUM/$DAEMON_LABEL" &>/dev/null; then
      log "Daemon not loaded. Attempting bootstrap."
      launchctl bootstrap "gui/$UID_NUM" ~/Library/LaunchAgents/com.ping-guard.daemon.plist 2>/dev/null || true
      launchctl kickstart "gui/$UID_NUM/$DAEMON_LABEL" 2>/dev/null || true
    fi
  fi
done
```

**Key differences from the old file**:

| Old behavior | New behavior |
|---|---|
| Reads `~/.ping-guard/last-good-commit`, runs `git stash` + `git checkout <SHA> -- .` | No git operations at all. File is not read. |
| Rolls back on first stale heartbeat | 3 kickstart retries with 5/15/45s backoff before escalation |
| EMERGENCY_STOP handler halts daemon, expects human to restart manually, no osascript | EMERGENCY_STOP handler halts daemon, sets marker, osascript notifies user, exits 1 (watchdog plist re-bootstraps on reboot) |
| No exit on escalation | Exits 1 so launchd sees a fault and the watchdog plist can re-bootstrap |

**Lint gate**: `shellcheck ~/Projects/ping-guard/scripts/supervisor.sh` — MUST exit 0.

**Reload supervisor**:

```bash
launchctl kickstart -k "gui/$(id -u)/com.ping-guard.supervisor"
sleep 3
launchctl list com.ping-guard.supervisor   # expect PID > 0
tail -5 ~/Library/Logs/ping-guard/supervisor.log   # expect: "Starting supervisor (PID <N>, policy=keep-forward)"
```

---

### P4.3a — `com.ping-guard.watchdog.plist` recovery plist (CF2, E.3)

**Purpose**: judge finding CF2 confirmed across all 3 panels — supervisor's `emergency_stop()` calls `launchctl bootout` + `exit 1`, which halts both ping-guard AND its own launchd agent. After a Mac reboot following EMERGENCY_STOP, ping-guard stays permanently down unless someone runs `launchctl bootstrap` manually. This breaks **O6** because wake-after-EMERGENCY_STOP cannot restore MCP.

The watchdog is a MINIMAL agent that runs at every login, sees whether `com.ping-guard.daemon` is loaded, and if not, re-bootstraps it. `KeepAlive=true` so it re-runs if it exits. It does NOT monitor heartbeats — that is the supervisor's job. It ONLY ensures the daemon plist is registered and kicked.

**File**: `~/Library/LaunchAgents/com.ping-guard.watchdog.plist`

**Full XML** (new file):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ping-guard.watchdog</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>if ! launchctl print "gui/$(id -u)/com.ping-guard.daemon" &gt;/dev/null 2&gt;&amp;1; then launchctl bootstrap "gui/$(id -u)" /Users/umasankr/Library/LaunchAgents/com.ping-guard.daemon.plist 2&gt;/dev/null || true; launchctl kickstart -k "gui/$(id -u)/com.ping-guard.daemon" 2&gt;/dev/null || true; fi; sleep 60</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>60</integer>
    <key>StandardOutPath</key>
    <string>/Users/umasankr/Library/Logs/ping-guard/watchdog.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/umasankr/Library/Logs/ping-guard/watchdog.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/umasankr</string>
    </dict>
</dict>
</plist>
```

**Shape rationale**:

- `KeepAlive=true` + `ThrottleInterval=60` + `sleep 60` at the end of the inline script → the watchdog loops roughly every 60s. It's a self-contained poll — no separate shell script needed because the logic is three `launchctl` calls.
- XML-escaped `&gt;`/`&lt;`/`&amp;` because the inline command goes into a plist string. Verified correct escaping.
- Does NOT run the daemon directly. It only ensures the daemon plist is loaded and kicked. If the daemon itself is crashing, the daemon's own `KeepAlive=true` handles the restart loop.
- Does NOT touch `EMERGENCY_STOP`. If a human sets that marker, the supervisor respects it; the watchdog is supervisor-unaware and only cares about the daemon agent. This is intentional — the watchdog's job is availability, the supervisor's job is correctness. They compose.

**Install**:

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.ping-guard.watchdog.plist
launchctl kickstart -k "gui/$(id -u)/com.ping-guard.watchdog"
launchctl list com.ping-guard.watchdog   # expect PID > 0 and last-exit-status 0
```

**Doctor gate coupling** (hand-off to P5): gate `supervisor-watchdog-loaded` — `launchctl list com.ping-guard.watchdog | grep -qE '"PID" = [1-9]'`. P5 owns the gate implementation; P4 declares the requirement.

---

### P4.4 — `wake_detector.py` add `_start_orbstack()` (E.5, W19)

**Purpose**: OrbStack suspends containers on Mac sleep and does NOT auto-resume on wake. The daemon's call to `docker info` hangs until the OrbStack VM is manually started, which costs up to 90s — breaking O6. Fix: explicitly call `orbctl start` before `_wait_for_docker()` in the wake handler.

**P3 dependency**: P3.4 already committed (removed `_reconcile_scheduled()` function at old lines 40–51 AND call + `time.sleep(5)` at old lines 94–95). P4's insertion is **positionally relative**: "insert `_start_orbstack()` immediately after the `_kickstart()` function definition, replacing the position where `_reconcile_scheduled()` used to live", and "insert the call to `_start_orbstack()` inside `handleWakeNotification_` BEFORE `_wait_for_docker()`". The absolute line numbers shift depending on exactly how P3 edited whitespace. DO NOT rely on absolute line numbers; rely on the adjacent function-name anchors.

**Backup**:

```bash
cp -a ~/Projects/ping-guard/scripts/wake_detector.py ~/Projects/ping-guard/scripts/wake_detector.py.bak.$(date +%s)
```

**Edit 1 — add `_start_orbstack()` function**. The anchor is the blank line(s) immediately after `_kickstart()` ends and before `def _wait_for_docker(...)` begins. Insert this function in between:

```python


def _start_orbstack() -> None:
    """Ensure OrbStack VM is running before we poll Docker.

    OrbStack suspends the Linux VM on macOS sleep and does NOT auto-resume on wake.
    `docker info` will hang waiting for the socket; `orbctl start` nudges the VM
    up in ~3–10s. Idempotent: if OrbStack is already running, `orbctl start` is
    a fast no-op. Falls back silently if orbctl is not installed.
    """
    try:
        result = subprocess.run(
            ["orbctl", "start"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            LOG.info("orbctl start OK")
        else:
            LOG.warning("orbctl start exit=%d stderr=%s", result.returncode, result.stderr.strip())
    except FileNotFoundError:
        LOG.info("orbctl not installed — skipping OrbStack start (Docker Desktop assumed)")
    except subprocess.TimeoutExpired:
        LOG.warning("orbctl start timeout after 10s — proceeding; _wait_for_docker will retry")
```

**Edit 2 — call `_start_orbstack()` in `handleWakeNotification_`**. The anchor is the first line of the method body (`LOG.info("Wake detected")`). Insert the call BEFORE `_wait_for_docker()`:

Old (after P3.4):

```python
class WakeObserver(NSObject):
    def handleWakeNotification_(self, _notification) -> None:
        LOG.info("Wake detected")
        _wait_for_docker()
        for label in PING_GUARD_LABELS:
            _kickstart(label)
```

New:

```python
class WakeObserver(NSObject):
    def handleWakeNotification_(self, _notification) -> None:
        LOG.info("Wake detected")
        _start_orbstack()
        _wait_for_docker()
        for label in PING_GUARD_LABELS:
            _kickstart(label)
```

**Post-edit asserts**:

```bash
# AST parse must succeed
python3 -c "import ast; ast.parse(open('/Users/umasankr/Projects/ping-guard/scripts/wake_detector.py').read())" && echo AST_OK

# Function is defined
grep -c "^def _start_orbstack" ~/Projects/ping-guard/scripts/wake_detector.py   # expect 1

# Function is called in handler
grep -c "_start_orbstack()" ~/Projects/ping-guard/scripts/wake_detector.py      # expect 2 (1 def + 1 call)

# Orb call sits before docker wait in handler
awk '/def handleWakeNotification_/,/def .*[^_]\(/' ~/Projects/ping-guard/scripts/wake_detector.py \
  | grep -nE "_start_orbstack\(\)|_wait_for_docker\(\)"
# expect _start_orbstack appears at a lower line number than _wait_for_docker
```

On AST failure, restore:

```bash
LATEST=$(ls -t ~/Projects/ping-guard/scripts/wake_detector.py.bak.* | head -1)
cp -a "$LATEST" ~/Projects/ping-guard/scripts/wake_detector.py
```

**Reload wake-detector**:

```bash
launchctl kickstart -k "gui/$(id -u)/com.ping-guard.wake-detector"
sleep 3
launchctl list com.ping-guard.wake-detector   # expect PID > 0
tail -5 ~/Library/Logs/ping-guard/wake-detector.log   # expect "Listening for macOS wake events"
```

---

### P4.5 — Patch `com.ping-guard.daemon.plist` launchd hardening (A-DOM-3, W17)

**Purpose**: judge finding A-DOM-3 accepted — launchd ProcessType must be set so the daemon opts out of App Nap throttling (which silently pauses bun/node processes backgrounded for >1s). Also: explicit `ExitTimeOut` ensures a clean 30s SIGTERM window before SIGKILL, and bumped FD limits prevent accidental file-descriptor exhaustion under load.

**Non-applicable**: `com.ping-mem.daemon.plist` is NOT managed by launchd in the active architecture. ping-mem's REST runs inside an OrbStack container (`ping-mem` service in `docker-compose.yml`, ports 3003→3003). The launchd plist at `~/Library/LaunchAgents/com.ping-mem.daemon.plist` is a legacy file from the pre-container era and should NOT be loaded. P4.5 does NOT touch it.

**Hand-off to P5**: the P5 doctor plist (`com.ping-mem.doctor.plist`) will use `ProcessType=Background` with `LowPriorityIO=true` — that's a different load profile (doctor is short-lived, low-priority). P5 owns its plist; P4 flags the shape so P5 doesn't copy the Interactive settings from here.

**Backup**:

```bash
cp -a ~/Library/LaunchAgents/com.ping-guard.daemon.plist ~/Library/LaunchAgents/com.ping-guard.daemon.plist.bak.$(date +%s)
```

**Patch**: add 4 keys to the existing `<dict>` block. Use `/usr/libexec/PlistBuddy` for deterministic idempotent edits:

```bash
PLIST=~/Library/LaunchAgents/com.ping-guard.daemon.plist

# Add (or overwrite) ProcessType = Interactive
/usr/libexec/PlistBuddy -c "Delete :ProcessType" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :ProcessType string Interactive" "$PLIST"

# ExitTimeOut = 30
/usr/libexec/PlistBuddy -c "Delete :ExitTimeOut" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :ExitTimeOut integer 30" "$PLIST"

# SoftResourceLimits.NumberOfFiles = 4096
/usr/libexec/PlistBuddy -c "Delete :SoftResourceLimits" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :SoftResourceLimits dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :SoftResourceLimits:NumberOfFiles integer 4096" "$PLIST"

# HardResourceLimits.NumberOfFiles = 8192
/usr/libexec/PlistBuddy -c "Delete :HardResourceLimits" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :HardResourceLimits dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :HardResourceLimits:NumberOfFiles integer 8192" "$PLIST"

# Verify
plutil -lint "$PLIST" && echo PLIST_OK
/usr/libexec/PlistBuddy -c "Print :ProcessType" "$PLIST"   # expect Interactive
/usr/libexec/PlistBuddy -c "Print :ExitTimeOut" "$PLIST"   # expect 30
/usr/libexec/PlistBuddy -c "Print :SoftResourceLimits:NumberOfFiles" "$PLIST"  # expect 4096
/usr/libexec/PlistBuddy -c "Print :HardResourceLimits:NumberOfFiles" "$PLIST"  # expect 8192
```

**Reload** (bootout + bootstrap is required — launchd caches plist parse at load time):

```bash
launchctl bootout "gui/$(id -u)/com.ping-guard.daemon" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.ping-guard.daemon.plist
launchctl kickstart -k "gui/$(id -u)/com.ping-guard.daemon"
sleep 3
launchctl list com.ping-guard.daemon   # expect PID > 0 and LimitLoadToSessionType present if relevant
```

**Post-reload assertion** — fetch the plist from launchd and confirm the new keys are present in the loaded config:

```bash
launchctl print "gui/$(id -u)/com.ping-guard.daemon" | grep -E "ProcessType|ExitTimeOut|RLIMIT_NOFILE|NumberOfFiles"
```

Expect to see `process type = Interactive`, `exit time = 30 seconds`, file limits reflecting 4096/8192.

---

### P4.6 — Doctor gate hand-off specification to P5 (W15, W16, W17, W19)

**Purpose**: P4 creates the infrastructure; P5 implements the continuous verification. This task produces a frozen spec for P5 so there is zero ambiguity about what each gate asserts. P5's `src/doctor/gates.ts` registry consumes this spec.

**Gates owned-by-requirement from P4** (P5 implements them):

| Gate ID | Group | Hard/Soft | Frequency | Exit Code on Fail | Assertion | Remediation Hint |
|---------|-------|-----------|-----------|-------------------|-----------|------------------|
| `disk-below-85` | infrastructure | hard | 15min (default P5 cadence) | 2 | `df -P /System/Volumes/Data` → `$5` (used %) without `%` ≤ 85 | run `bash ~/Projects/ping-mem/scripts/cleanup-disk.sh` |
| `log-rotation-last-7d` | infrastructure | soft | 15min | 1 (warn) | `find ~/Library/Logs/ping-guard -name '*.gz' -mtime -7 \| head -1` returns at least one path OR `stat -f %m /etc/newsyslog.d/ping-guard.conf` returns a timestamp within 30 days (proves newsyslog is at least installed, even if no rotation has triggered yet in a quiet week) | verify newsyslog OR user-space launchd loaded; kick with `sudo newsyslog` or `launchctl kickstart -k gui/$UID/com.ping-guard.log-rotate` |
| `supervisor-no-rollback` | selfheal | hard | 15min | 2 | `grep -c "Rolled back" ~/Library/Logs/ping-guard/supervisor.log` returns `0` when scoped to the lines written after the P4.3 supervisor-reload timestamp. (P5 records the reload timestamp in `~/.ping-mem/p4-supervisor-reloaded-at` and greps with `awk -v t="$(cat that-file)" …`.) | kill any lingering rollback-era supervisor; re-run P4.3 |
| `supervisor-watchdog-loaded` | selfheal | hard | 15min | 2 | `launchctl list com.ping-guard.watchdog 2>/dev/null \| grep -qE '"PID" = [1-9]'` | `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.ping-guard.watchdog.plist; launchctl kickstart -k gui/$UID/com.ping-guard.watchdog` |
| `orbstack-reachable` | infrastructure | soft | 15min | 1 | `orbctl status 2>/dev/null \| grep -q Running` OR `curl -sf --max-time 2 http://localhost:3003/health` returns 200 (i.e. either orbctl confirms OrbStack OR ping-mem is reachable regardless) | `orbctl start` |

**Threshold source of truth**: `~/.ping-mem/thresholds.json` (P5 owns the file). P4 lists the defaults expected:

```json
{
  "disk_usage_percent_fail": 85,
  "disk_usage_percent_warn": 80,
  "log_rotation_staleness_days": 7,
  "supervisor_rollback_count_fail": 0,
  "orbstack_status_timeout_s": 2
}
```

P4 does NOT create this file — it belongs to P5. P4 ships the spec so P5 cannot accidentally invent different thresholds.

**Soak gate coupling** (hand-off to P7): P7's hard gate `disk-below-90` uses 90% as the soak-level floor (more permissive than the doctor's 85% warn threshold). Both are cited in `overview.md#30-day-soak-acceptance`. P4 produces the conditions that make both green.

---

## Integration Points

| # | File / Artifact | Line(s) or Path | Change | Owner Task | Backup Required |
|---|----------------|-----------------|--------|------------|-----------------|
| IP1 | `~/Projects/ping-mem/scripts/cleanup-disk.sh` | new file, ~70 lines | create | P4.1 | N/A (new) |
| IP2 | `/etc/newsyslog.d/ping-guard.conf` | new file (sudo) | create | P4.2 primary | sudo cp if exists |
| IP3 | `~/Library/LaunchAgents/com.ping-guard.log-rotate.plist` | new file (no-sudo fallback) | create | P4.2 fallback | N/A (new) |
| IP4 | `~/Projects/ping-mem/scripts/rotate-ping-guard-logs.sh` | new file (no-sudo fallback) | create | P4.2 fallback | N/A (new) |
| IP5 | `~/Projects/ping-guard/scripts/supervisor.sh` | full-file rewrite | overwrite | P4.3 | `cp -a ... .bak.<ts>` |
| IP6 | `~/Library/LaunchAgents/com.ping-guard.watchdog.plist` | new file | create | P4.3a | N/A (new) |
| IP7 | `~/Projects/ping-guard/scripts/wake_detector.py` | add `_start_orbstack()` after `_kickstart()`; call in `handleWakeNotification_` before `_wait_for_docker()` | add function + call | P4.4 | `cp -a ... .bak.<ts>` |
| IP8 | `~/Library/LaunchAgents/com.ping-guard.daemon.plist` | add 4 keys: `ProcessType`, `ExitTimeOut`, `SoftResourceLimits.NumberOfFiles`, `HardResourceLimits.NumberOfFiles` | patch | P4.5 | `cp -a ... .bak.<ts>` |
| IP9 | `launchctl` runtime | bootout + bootstrap daemon; kickstart supervisor, watchdog, log-rotate (if fallback), wake-detector | reload | P4.2/P4.3/P4.3a/P4.5 | N/A (runtime) |

No other files touched. `com.ping-mem.daemon.plist` explicitly excluded per A-DOM-3 (ping-mem runs in OrbStack container, not launchd).

---

## Wiring Matrix (W15, W16, W17, W19)

Each row expands the global table in `overview.md#global-wiring-matrix` with the P4-owned call path.

### W15 — Disk stays ≤85% (O7)

**Trigger**: continuous; P5 doctor gate `disk-below-85` runs every 15min.

**Call path**:

1. Doctor scheduler (P5 `com.ping-mem.doctor.plist`) invokes `bun run doctor` every 15min.
2. `doctor` loads gate registry `src/doctor/gates.ts` → `disk-below-85` gate runs.
3. Gate executes `df -P /System/Volumes/Data | awk 'NR==2 {sub(/%/,"",$5); print $5}'`.
4. Gate compares against `~/.ping-ping-mem/thresholds.json#disk_usage_percent_fail` (default 85).
5. On fail (>85): gate exits non-zero, doctor JSONL record flags it, alerts.db dedup, osascript notification.
6. Remediation: operator (or P5 auto-trigger hook) runs `bash ~/Projects/ping-mem/scripts/cleanup-disk.sh` (P4.1). Script performs the 7 guarded cleanups + docker build/container/image prune (NEVER `--volumes`).
7. Next doctor cycle re-measures and clears the alert.

**Preflight** (inside the script): reads `$BEFORE_PCT` from `df`, logs it, runs pgrep guards before each destructive operation, logs `$AFTER_PCT` on exit.

**Fallback**: if a pgrep guard returns "process running", the guarded block is skipped — not an error. Script exits 0 and the next scheduled run tries again when the process has stopped.

**Functional test**: F4.2.

### W16 — Logs rotate (E.2)

**Trigger**: log file size reaches 5 MB (newsyslog primary) OR daily at `StartInterval=86400` (user-space fallback).

**Call path (primary — newsyslog)**:

1. macOS `/System/Library/LaunchDaemons/com.apple.newsyslog.plist` runs newsyslog every ~15min.
2. newsyslog reads `/etc/newsyslog.d/ping-guard.conf` (installed in P4.2).
3. For each listed file, newsyslog checks size; if >5 MB, it:
   - Shifts `.2.bz2` → `.3.bz2`, `.1.bz2` → `.2.bz2`, `.bz2` → `.1.bz2`.
   - Copies current file to new archive position, truncates current via `:>` equivalent (preserves launchd-held fd).
   - bzip2-compresses the new archive (`J` flag).
4. Archives appear at `~/Library/Logs/ping-guard/*.bz2` — P5 doctor gate `log-rotation-last-7d` greps for them.

**Call path (fallback — user-space)**:

1. `com.ping-guard.log-rotate` plist runs every 86400s (daily) + RunAtLoad.
2. Executes `~/Projects/ping-mem/scripts/rotate-ping-guard-logs.sh`.
3. Script walks the 8 ping-guard log files; for each with size>5 MB, shifts `.1.gz`→`.2.gz`→`.3.gz`, copies current to `.1`, truncates current via `:>`, gzips `.1`.
4. Archives appear at `~/Library/Logs/ping-guard/*.gz` — same gate works (greps for `*.gz`).

**Functional test**: F4.3.

### W17 — Supervisor never rollbacks + EMERGENCY_STOP recoverable (E.3, O9)

**Trigger**: supervisor wakes every 30s; fires on stale heartbeat (>180s).

**Call path**:

1. `com.ping-guard.supervisor` plist keeps `supervisor.sh` alive (`KeepAlive=true`).
2. Supervisor loops `sleep 30`; each iteration:
   - Checks `$PROJECT_DIR/EMERGENCY_STOP` marker → if present, idle (don't kickstart).
   - Checks heartbeat freshness via `stat -f %m /tmp/ping-guard-heartbeat`.
   - If `AGE > VERIFY_WINDOW (180s)` → `attempt_kickstart_with_backoff`:
     - Kickstart 1, sleep 5s, check heartbeat → recovered? return 0
     - Kickstart 2, sleep 15s, check → recovered? return 0
     - Kickstart 3, sleep 45s, check → recovered? return 0
     - All failed → `emergency_stop`:
       - `launchctl bootout gui/$UID/com.ping-guard.daemon`
       - `touch $PROJECT_DIR/EMERGENCY_STOP`
       - `osascript` notify
       - `exit 1`
3. After `exit 1`, launchd re-spawns supervisor (`KeepAlive=true`). Supervisor sees EMERGENCY_STOP marker → idles.
4. On Mac reboot OR login, `com.ping-guard.watchdog.plist` (P4.3a, `RunAtLoad=true`, `KeepAlive=true`) runs every ~60s. If it notices daemon is not loaded, it `launchctl bootstrap`s and kickstarts it.
5. Operator removes `$PROJECT_DIR/EMERGENCY_STOP` manually → next supervisor iteration sees no marker → resumes monitoring. Watchdog has already ensured the daemon is loaded.

**No git operations anywhere**. No rollback possible. `O9` binary condition: `grep -c "Rolled back" supervisor.log` (post-reload) stays at 0.

**Preflight**: supervisor's `$HEARTBEAT_FILE` presence check + `$PROJECT_DIR/EMERGENCY_STOP` presence check before every monitor cycle.

**Fallback**: if heartbeat file does not exist, supervisor tries `launchctl bootstrap` + `kickstart` itself (covers cold-start of a never-launched daemon).

**Functional test**: F4.4 (3-retry proves no rollback), F4.5 (watchdog re-bootstrap after EMERGENCY_STOP).

### W19 — OrbStack resumes on wake (E.5, O6)

**Trigger**: `NSWorkspaceDidWakeNotification` → `WakeObserver.handleWakeNotification_`.

**Call path (post-P4.4)**:

1. Mac wakes from sleep → AppKit fires `NSWorkspaceDidWakeNotification`.
2. `wake_detector.py#WakeObserver.handleWakeNotification_` runs:
   - `LOG.info("Wake detected")`
   - `_start_orbstack()` (NEW, P4.4) — runs `subprocess.run(["orbctl", "start"], timeout=10)`.
     - If `orbctl` not installed → log "skipping" and continue (Docker Desktop user assumed).
     - If timeout → log warning, continue (`_wait_for_docker()` will retry).
     - On success → log "orbctl start OK", continue.
   - `_wait_for_docker()` — polls `docker info` + `docker compose ps` every 5s up to 90s, looking for ≥3 containers (`ping-mem`, `ping-mem-neo4j`, `ping-mem-qdrant` per `docker-compose.yml`).
   - For each `PING_GUARD_LABELS` entry → `_kickstart(label)` (restart ping-guard daemon + auto-os).
3. Within 30s of wake: `orbctl start` completed (typically 3–10s) + Docker containers healthy + ping-guard daemon kicked. MCP proxy reachable via `http://localhost:3003`.

**Preflight**: `orbctl` FileNotFoundError handling → graceful skip. `subprocess.TimeoutExpired` → warning log, proceed.

**Fallback**: if OrbStack fails to start, `_wait_for_docker()` waits 90s for Docker — if still unready after 90s, it logs a warning and proceeds anyway (daemons kickstart without confirming Docker). This avoids a dead lock but the operator sees the warning.

**Functional test**: F4.6 (wake simulation, tail `wake-detector.log`, confirm MCP within 30s).

---

## Verification Checklist

| # | Check | Command | Expected |
|---|-------|---------|----------|
| V4.1 | `scripts/cleanup-disk.sh` exists + executable | `test -x ~/Projects/ping-mem/scripts/cleanup-disk.sh && echo OK` | `OK` |
| V4.2 | Cleanup script has all pgrep guards | `grep -cE "pgrep -f 'ms-playwright'\|pgrep -f 'next dev'\|pgrep -xq xcodebuild\|pgrep -xq brew\|pgrep -f 'pip '" ~/Projects/ping-mem/scripts/cleanup-disk.sh` | `>=5` |
| V4.3 | Cleanup script does NOT `--volumes` prune Docker | `grep -c "volume prune\|--volumes" ~/Projects/ping-mem/scripts/cleanup-disk.sh` | `0` |
| V4.4 | Cleanup script passes shellcheck | `shellcheck ~/Projects/ping-mem/scripts/cleanup-disk.sh; echo $?` | `0` |
| V4.5 | newsyslog conf installed (if sudo path taken) OR fallback plist loaded | EITHER `test -r /etc/newsyslog.d/ping-guard.conf && echo A` OR `launchctl list com.ping-guard.log-rotate \| grep -qE '"PID" = [1-9]' && echo B` | `A` or `B` |
| V4.6 | newsyslog conf passes dry-run lint (if present) | `sudo newsyslog -nv /etc/newsyslog.d/ping-guard.conf 2>&1 \| tail -1` | no `error` or `parse` messages |
| V4.7 | Supervisor has no git operations | `grep -cE "git checkout\|git stash\|last-good-commit\|LAST_GOOD" ~/Projects/ping-guard/scripts/supervisor.sh` | `0` |
| V4.8 | Supervisor has 3-retry backoff | `grep -cE "backoffs=\(5 15 45\)" ~/Projects/ping-guard/scripts/supervisor.sh` | `1` |
| V4.9 | Supervisor has EMERGENCY_STOP escalation that touches marker + exits 1 | `grep -cE "touch .*EMERGENCY_STOP" ~/Projects/ping-guard/scripts/supervisor.sh` | `>=1` AND `grep -c "exit 1" ~/Projects/ping-guard/scripts/supervisor.sh \| awk '{ print $1 >= 1 }'` |
| V4.10 | Supervisor passes shellcheck | `shellcheck ~/Projects/ping-guard/scripts/supervisor.sh; echo $?` | `0` |
| V4.11 | `com.ping-guard.watchdog.plist` exists and is lintable | `plutil -lint ~/Library/LaunchAgents/com.ping-guard.watchdog.plist` | `OK` |
| V4.12 | Watchdog plist has `RunAtLoad=true` + `KeepAlive=true` | `/usr/libexec/PlistBuddy -c "Print :RunAtLoad" ~/Library/LaunchAgents/com.ping-guard.watchdog.plist` → `true`; same for `KeepAlive` | both `true` |
| V4.13 | Watchdog is loaded in launchd | `launchctl list com.ping-guard.watchdog \| grep -cE '"PID" = [1-9]'` | `1` |
| V4.14 | `wake_detector.py` defines `_start_orbstack` | `grep -c "^def _start_orbstack" ~/Projects/ping-guard/scripts/wake_detector.py` | `1` |
| V4.15 | `wake_detector.py` calls `_start_orbstack()` from handler | `awk '/def handleWakeNotification_/,/^def \|^class /' ~/Projects/ping-guard/scripts/wake_detector.py \| grep -c "_start_orbstack()"` | `1` |
| V4.16 | `_start_orbstack` call precedes `_wait_for_docker` call in handler | `awk '/def handleWakeNotification_/,/^def \|^class /' ~/Projects/ping-guard/scripts/wake_detector.py \| grep -nE "_start_orbstack\(\)\|_wait_for_docker\(\)" \| head -2` | first line has `_start_orbstack`, second has `_wait_for_docker` |
| V4.17 | `wake_detector.py` parses (AST) | `python3 -c "import ast; ast.parse(open('/Users/umasankr/Projects/ping-guard/scripts/wake_detector.py').read())" && echo OK` | `OK` |
| V4.18 | Daemon plist has `ProcessType=Interactive` | `/usr/libexec/PlistBuddy -c "Print :ProcessType" ~/Library/LaunchAgents/com.ping-guard.daemon.plist` | `Interactive` |
| V4.19 | Daemon plist has `ExitTimeOut=30` | `/usr/libexec/PlistBuddy -c "Print :ExitTimeOut" ~/Library/LaunchAgents/com.ping-guard.daemon.plist` | `30` |
| V4.20 | Daemon plist has FD limits 4096/8192 | `/usr/libexec/PlistBuddy -c "Print :SoftResourceLimits:NumberOfFiles" ~/Library/LaunchAgents/com.ping-guard.daemon.plist` → `4096`; `Hard...` → `8192` | both match |
| V4.21 | Daemon plist is launchd-reloaded and PID>0 | `launchctl list com.ping-guard.daemon \| grep -cE '"PID" = [1-9]'` | `1` |
| V4.22 | `com.ping-mem.daemon.plist` NOT touched by P4 | `git -C ~/Projects/ping-mem diff --stat HEAD~1 HEAD -- ~/Library/LaunchAgents/com.ping-mem.daemon.plist 2>/dev/null \| wc -l` | `0` (not tracked / not changed) |

---

## Functional Tests

| # | Test | Procedure | Pass Criterion |
|---|------|-----------|----------------|
| F4.1 | Cleanup script guards honored | Start `playwright` in another terminal (`bunx playwright install` or simulate: `sleep 600 &  disown` and `exec -a ms-playwright sleep 600 &` — Note: the simplest simulation is to set `pgrep -f 'ms-playwright'` returning non-zero artificially via a stub; in practice Playwright is often running). Run `bash ~/Projects/ping-mem/scripts/cleanup-disk.sh`. Tail `/tmp/cleanup-disk-*.log`. | Log contains `"skip playwright cache (process running)"` |
| F4.2 | Disk post-cleanup ≤85% | `df -P /System/Volumes/Data \| awk 'NR==2 {sub(/%/,"",$5); print ($5<=85)}'` | `1` |
| F4.3 | Log rotation archive exists within 7d | Either `find ~/Library/Logs/ping-guard -name '*.bz2' -o -name '*.gz' \| head -1` is non-empty AFTER manual size trigger: `: > ~/Library/Logs/ping-guard/daemon.err; dd if=/dev/urandom of=~/Library/Logs/ping-guard/daemon.err bs=1m count=6; sudo newsyslog` (primary) or `launchctl kickstart -k gui/$UID/com.ping-guard.log-rotate` (fallback) | at least 1 archive returned |
| F4.4 | Supervisor 3-retry — no rollback on transient stale | Delete heartbeat: `rm /tmp/ping-guard-heartbeat`. Wait 35s (supervisor loop). Observe log: `tail -f ~/Library/Logs/ping-guard/supervisor.log`. Heartbeat will be recreated by daemon kickstart. | Log shows `"Kickstart attempt 1/3"` then `"Recovered on attempt N"` (N<=3). Log does NOT contain `"Rolled back"`. |
| F4.5 | Watchdog re-bootstraps after EMERGENCY_STOP | Simulate: `launchctl bootout gui/$UID/com.ping-guard.daemon; touch ~/Projects/ping-guard/EMERGENCY_STOP`. Wait 90s. Watchdog's loop should notice daemon gone. Manually remove marker: `rm ~/Projects/ping-guard/EMERGENCY_STOP`. Wait 60s more. | `launchctl list com.ping-guard.daemon` shows `"PID" = [1-9]` again within 150s total. `~/Library/Logs/ping-guard/watchdog.log` contains `"launchctl bootstrap"` or `"launchctl kickstart"` entries. |
| F4.6 | Wake-simulation — OrbStack resumes + MCP works within 30s | From Terminal: `pmset sleepnow` (or `caffeinate -u -t 1 &` to simulate wake). On wake, within 30s run `curl -sf --max-time 2 http://localhost:3003/health` AND `orbctl status`. | `curl` returns 200 and `orbctl status` shows `Running`. `wake-detector.log` shows `"orbctl start OK"`. |
| F4.7 | Daemon plist keys effective after reload | `launchctl print gui/$UID/com.ping-guard.daemon 2>&1 \| grep -E "process type\|exit time\|RLIMIT_NOFILE\|NumberOfFiles"` | output mentions `Interactive`, `30 seconds`, and `NumberOfFiles = 4096` / `8192` |
| F4.8 | Shellcheck clean on all P4 shell files | `shellcheck ~/Projects/ping-mem/scripts/cleanup-disk.sh ~/Projects/ping-mem/scripts/rotate-ping-guard-logs.sh ~/Projects/ping-guard/scripts/supervisor.sh; echo $?` | `0` |
| F4.9 | `com.ping-mem.daemon.plist` not loaded by launchd (per A-DOM-3) | `launchctl list com.ping-mem.daemon 2>&1` | either `Could not find service "com.ping-mem.daemon"` OR no PID line. (ping-mem runs in OrbStack container, not launchd.) |

---

## Gate Criterion (binary)

**Phase P4 passes if and only if ALL of the following hold**:

- [ ] V4.1–V4.22 all return their exact expected output (22/22).
- [ ] F4.1–F4.9 all pass (9/9).
- [ ] `df -P /System/Volumes/Data` reports used % ≤ 85 at phase exit.
- [ ] `~/Library/Logs/ping-guard/supervisor.log` shows a `policy=keep-forward` start line AFTER the P4.3 reload, and NO `"Rolled back"` line written AFTER that start line.
- [ ] `launchctl list com.ping-guard.watchdog` shows PID > 0.
- [ ] `launchctl list com.ping-guard.daemon` shows PID > 0 AND `launchctl print` output mentions `process type = Interactive`.
- [ ] `~/Projects/ping-guard/scripts/wake_detector.py` AST-parses AND defines + calls `_start_orbstack()` with the call preceding `_wait_for_docker()` in `handleWakeNotification_`.
- [ ] At least one rotated log archive (`*.bz2` from newsyslog or `*.gz` from user-space fallback) exists OR the rotation conf/plist is loaded + last-run within 24h.

**Any single failure = phase FAIL = P5 blocked**. Restore backups (each task listed its backup file), diagnose, re-run.

---

## Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| R4.1 | `cleanup-disk.sh` removes a cache currently in use by an IDE subprocess (e.g. IntelliJ caches) | MEDIUM | Script only targets the 7 well-known caches + Docker prunes. No `~/Library/Caches/JetBrains` touched. pgrep guards cover the 3 most aggressive (playwright, next, xcodebuild). IntelliJ-style IDEs use local project caches not reached by this script. |
| R4.2 | Docker build-cache prune during active `docker compose build` corrupts the build | MEDIUM | pgrep guard: `if pgrep -f 'docker (build\|buildx)' …; then skip; fi`. If a build starts mid-prune, Docker's own locking handles consistency. |
| R4.3 | `newsyslog.d/*.conf` syntax error → macOS newsyslog skips our file silently, no rotation happens, logs grow unbounded | HIGH | V4.6 runs `sudo newsyslog -nv` dry-run BEFORE trusting the file. If dry-run fails, abort P4.2 primary and take the fallback path. |
| R4.4 | User-space `com.ping-guard.log-rotate.plist` fires daily but `$HOME` substitution in script differs from launchd env | LOW | Plist sets `HOME=/Users/umasankr` explicitly in `EnvironmentVariables`. Script uses `$HOME` — verified resolves. |
| R4.5 | Supervisor rewrite breaks compatibility with a hidden consumer of `~/.ping-guard/last-good-commit` | LOW | grep across `~/Projects/ping-guard/` for `last-good-commit` references — any non-supervisor reader needs its own fix. Mitigation: include that grep in V4.7 proof. |
| R4.6 | `exit 1` after EMERGENCY_STOP causes the supervisor launchd agent to flap (re-spawn immediately, loop infinitely) | MEDIUM | `com.ping-guard.supervisor.plist` has `ThrottleInterval=` not set explicitly → launchd default 10s between respawns. Supervisor's first action on re-spawn is to check EMERGENCY_STOP marker → idle (skip the monitor loop). No flap. Confirmed by reading the current plist (P0 scout). |
| R4.7 | Watchdog plist and supervisor plist both try to bootstrap the daemon simultaneously, racing | LOW | `launchctl bootstrap` is idempotent — second call returns error `already bootstrapped` and does nothing harmful. `kickstart -k` is idempotent similarly. The two agents compose safely. |
| R4.8 | `orbctl` installed but with a subtly different signature (e.g. requires `orbctl start default`) | LOW | `orbctl start` (no args) was confirmed 2026-04-18 in research R2 to work (starts the default machine). If OrbStack updates break this, `subprocess.TimeoutExpired` path catches it and logs, `_wait_for_docker` still runs. |
| R4.9 | Daemon plist `ProcessType=Interactive` triggers a different macOS resource accounting that breaks under heavy load | LOW | Apple TN2083 + `launchd.plist(5)` document Interactive as the correct setting for user-facing daemons that should opt out of App Nap. Was already recommended by research R5, Task 6. |
| R4.10 | P3's wake_detector.py edit collides with P4's insertion because both touch the same file | LOW | P3.4 (REMOVE) runs first, commits, then P4.4 (ADD) runs in a separate commit. P4's insertion uses the POSITIONAL anchor `def _kickstart()` + `def _wait_for_docker()` — not line numbers — so it survives whitespace changes from P3's edit. If P3 leaves a merge conflict state, P4 aborts and the orchestrator resolves. |
| R4.11 | PlistBuddy `Add` fails if a key already exists | LOW | Each `Add` is preceded by a `Delete` (with `\|\| true` to ignore "key not found" on first run). Idempotent. |
| R4.12 | OrbStack is NOT installed → every wake logs a `skipping` line, hiding real errors | LOW | `FileNotFoundError` path logs at INFO level ("Docker Desktop assumed") not WARN. P5 doctor gate `orbstack-reachable` is SOFT and allows 6 red days / 30 — so a Docker Desktop user never sees a hard fail. |

---

## Dependencies

- **P0 complete**: branch active, baseline captured, disk at starting point (already ≤85 post-session cleanup).
- **P3.4 committed BEFORE P4.4**: `_reconcile_scheduled()` function and call must already be removed from `wake_detector.py`. Confirm:
  ```bash
  grep -c "_reconcile_scheduled\|aos-reconcile-scheduled" ~/Projects/ping-guard/scripts/wake_detector.py
  # expect 0
  ```
  If >0, block P4.4 until P3.4 lands.
- **`shellcheck` on PATH**: required by V4.4, V4.10, F4.8. Install: `brew install shellcheck`.
- **`orbctl` on PATH** (optional): if absent, P4.4 still lands the Python code; `_start_orbstack()` gracefully no-ops via `FileNotFoundError`. Users on Docker Desktop do not have this.
- **`/usr/libexec/PlistBuddy`**: macOS built-in. No install required.
- **sudo access** (preferred for P4.2 primary path). Fallback plist path requires no sudo.
- **`launchctl` built-in**: present on all macOS.
- **No dependency on P2** (ingestion), **P5** (observability), **P6** (auto-os), **P7** (soak), **P8** (docs) — those phases depend on P4, not the other way around.

---

## What P4 does NOT do

Explicit non-goals, to prevent scope creep:

- P4 does NOT own session cap + reaper — that is P1.
- P4 does NOT remove `_reconcile_scheduled` from `wake_detector.py` — that is P3.4. P4 only ADDS `_start_orbstack`.
- P4 does NOT create any ping-mem source code (`src/**/*.ts` untouched).
- P4 does NOT create the doctor CLI or `~/.ping-mem/thresholds.json` — P5 owns both. P4 only SPECS the 5 gate definitions P5 must implement.
- P4 does NOT touch `com.ping-mem.daemon.plist` — that file is legacy; ping-mem runs in OrbStack. A-DOM-3 accepted.
- P4 does NOT add per-container docker healthchecks — those live in `docker-compose.yml` and are already present.
- P4 does NOT push the watchdog plist to origin as part of the branch — it ships with the repo's `.backups/` untouched. The plist is installed into `~/Library/LaunchAgents/` which is outside the repo tree.
- P4 does NOT implement the P5 `disk-below-85`, `log-rotation-last-7d`, `supervisor-no-rollback`, `supervisor-watchdog-loaded`, `orbstack-reachable` gates. It only creates the conditions under which those future gates will pass and provides the frozen spec in P4.6.

## Exit state (what P5 inherits)

When P4 passes:

- `/Users/umasankr/Projects/ping-mem/scripts/cleanup-disk.sh` exists, executable, shellcheck-clean.
- EITHER `/etc/newsyslog.d/ping-guard.conf` installed (primary) OR `~/Library/LaunchAgents/com.ping-guard.log-rotate.plist` loaded (fallback) — `log-rotation-last-7d` gate will resolve with either.
- `~/Projects/ping-guard/scripts/supervisor.sh` rewritten — no git ops, 3-retry, EMERGENCY_STOP with osascript + exit 1.
- `~/Library/LaunchAgents/com.ping-guard.watchdog.plist` exists and is loaded.
- `~/Projects/ping-guard/scripts/wake_detector.py` has `_start_orbstack()` defined + called before `_wait_for_docker()`.
- `~/Library/LaunchAgents/com.ping-guard.daemon.plist` patched: ProcessType=Interactive, ExitTimeOut=30, FD limits 4096/8192.
- Daemon reloaded with new plist values.
- Supervisor reloaded with new keep-forward policy.
- `com.ping-mem.daemon.plist` untouched (legacy, non-active).
- Disk at ≤85%, trending stable.
- Zero rollback entries in supervisor.log since the P4.3 reload timestamp.
- The 5 gate specs in P4.6 hand-off to P5 unchanged.

P5 starts by loading `~/.ping-mem/thresholds.json` (its own file), registering the 5 gates per P4.6 spec, and verifying all 5 go green on first doctor run.

---

**Authoring note**: all file paths, line anchors, and reload commands grep-verified against the live repo on 2026-04-18. Live-file reads: `supervisor.sh` (78 lines, old), `wake_detector.py` (121 lines, pre-P3), `com.ping-guard.daemon.plist` (36 lines, no ProcessType), `docker-compose.yml` (123 lines, volumes named). P3.4 and P4 each commit independently to `fix/ping-mem-complete-remediation`; P4.4's insertion is positionally anchored to survive P3.4's line shifts.
