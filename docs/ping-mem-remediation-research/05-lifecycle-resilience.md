# 05 — Lifecycle Resilience: Disk, Logs, Supervisor, Wake, Sessions

**Date**: 2026-04-18
**Host**: umasankr @ darwin 25.4.0, `/dev/disk3s5` 460 GiB (96 % used, 18 GiB free)
**Scope**: Deterministic fixes with a 30-day "don't touch" quality bar.

Evidence base (collected 2026-04-18 08:45 local):

- `df -h /System/Volumes/Data` → 412 GiB used / 17 GiB free / 96 %
- `docker system df` → 44.10 GB total, **16.69 GB reclaimable** (3.46 images, 1.15 containers, 1.12 volumes, **12.11 build cache**)
- `~/Library/Caches` 23 G, `~/Library/Developer` 29 G, `~/.Trash` 11 G, `~/Library/Containers` 2.8 G, `~/.orbstack` 0.7 M, `~/.docker` 5.6 M, `~/Library/Logs` 156 M
- `~/Projects/thrivetree/.worktrees` **1.3 G**, `~/Projects/thrivetree/.next` **1.4 G**, `~/Projects/thrivetree/node_modules` 838 M, `~/Projects/kanban-backend-template/node_modules` 451 M, `~/Projects/sn-assist/.worktrees` 417 M
- `~/Library/Logs/ping-guard/auto-os.err` 9.4 MB, `daemon.err` 6.7 MB, all `.log` siblings 0 B
- `com.ping-guard.daemon.plist` — `KeepAlive: true`, `ThrottleInterval: 30`, no log rotation
- `com.ping-mem.daemon.plist` — same shape; both std streams point at `~/Library/Logs/ping-mem-daemon.log`
- `orbctl status` → `Running` (OrbStack is up now); engine `28.5.2`
- `curl /api/v1/session/list` → 5 live `native-sync` sessions over a 25-minute window, each `memoryCount: 0, eventCount: 0`

---

## Task 1 — Disk Reclamation (target: ≥ 50 GB)

### Reclamation candidates (ranked, safe)

| # | Target | Size | Command | Recovered |
|---|---|---|---|---|
| 1 | Docker build cache | 12.11 GB | `docker builder prune -af` | ~12 GB |
| 2 | Docker images/containers/volumes | 4.58 GB | `docker system prune -af --volumes` | ~4 GB |
| 3 | `~/.Trash` | 11 GB | Finder → Empty Bin, or `rm -rf ~/.Trash/*` | ~11 GB |
| 4 | `~/Library/Developer/Xcode/DerivedData` | part of 29 GB | `rm -rf ~/Library/Developer/Xcode/DerivedData/*` | ~5–15 GB |
| 5 | Old simulator runtimes | part of 29 GB | `xcrun simctl delete unavailable` then `rm -rf ~/Library/Developer/CoreSimulator/Caches/*` | ~3–8 GB |
| 6 | Targeted `~/Library/Caches` | 23 GB | `rm -rf ~/Library/Caches/{com.apple.dt.Xcode,Homebrew,ms-playwright,Google,JetBrains,pip}` | ~8–15 GB |
| 7 | `thrivetree/.next` | 1.4 GB | `rm -rf ~/Projects/thrivetree/.next` | 1.4 GB |
| 8 | `thrivetree/.worktrees` merged branches | 1.3 GB | `git -C ~/Projects/thrivetree worktree list`, then `git worktree remove <path>` per merged branch | ~0.5–1.3 GB |
| 9 | `thrivetree/node_modules` | 838 MB | `rm -rf ~/Projects/thrivetree/node_modules` (reinstall via `bun install`) | 0.8 GB |
| 10 | `kanban-backend-template/node_modules` | 451 MB | `rm -rf ~/Projects/kanban-backend-template/node_modules` | 0.4 GB |
| 11 | `sn-assist/.worktrees` | 417 MB | prune merged worktrees | ~0.3 GB |

**Conservative total**: ~50 GB. Aggressive: 65 GB.

One-shot script (`~/Projects/ping-mem/scripts/disk-reclaim.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail
docker builder prune -af
docker system prune -af --volumes
rm -rf ~/.Trash/*
rm -rf ~/Library/Developer/Xcode/DerivedData/*
xcrun simctl delete unavailable || true
rm -rf ~/Library/Caches/com.apple.dt.Xcode \
       ~/Library/Caches/Homebrew \
       ~/Library/Caches/ms-playwright \
       ~/Library/Caches/Google \
       ~/Library/Caches/JetBrains \
       ~/Library/Caches/pip 2>/dev/null || true
rm -rf ~/Projects/thrivetree/.next
rm -rf ~/Projects/thrivetree/node_modules
rm -rf ~/Projects/kanban-backend-template/node_modules
df -h /System/Volumes/Data
```

**Forbidden**: anywhere under `~/Projects/**` outside `node_modules|dist|.next|.worktrees`, `~/Library/Application Support`, `~/Library/Mail`, Photos libraries.

---

## Task 2 — Log Rotation (chosen: macOS `newsyslog`)

**Why**: built into macOS, run by system launchd, zero external deps, zero bash maintenance. Option (b) couples rotation to a buggy script; (c) adds a Homebrew dependency for one file.

**File**: `/etc/newsyslog.d/ping-guard.conf`, root-owned, mode 644:

```conf
# logfilename                                              [owner:group]   mode count size  when  flags
/Users/umasankr/Library/Logs/ping-guard/auto-os.err        umasankr:staff  644  3     5120  *     GJ
/Users/umasankr/Library/Logs/ping-guard/auto-os.log        umasankr:staff  644  3     5120  *     GJ
/Users/umasankr/Library/Logs/ping-guard/daemon.err         umasankr:staff  644  3     5120  *     GJ
/Users/umasankr/Library/Logs/ping-guard/daemon.log         umasankr:staff  644  3     5120  *     GJ
/Users/umasankr/Library/Logs/ping-guard/supervisor.err     umasankr:staff  644  3     5120  *     GJ
/Users/umasankr/Library/Logs/ping-guard/supervisor.log     umasankr:staff  644  3     5120  *     GJ
/Users/umasankr/Library/Logs/ping-guard/wake-detector.err  umasankr:staff  644  3     5120  *     GJ
/Users/umasankr/Library/Logs/ping-guard/wake-detector.log  umasankr:staff  644  3     5120  *     GJ
/Users/umasankr/Library/Logs/ping-mem-daemon.log           umasankr:staff  644  3     5120  *     GJ
```

- `size=5120` KB → **rotate at 5 MB**
- `count=3` → keep 3 archives
- `G` = glob, `J` = bzip2 compress (use `Z` for gzip)
- `when=*` → size trigger only, no time rotation

**Install & verify**:

```bash
sudo tee /etc/newsyslog.d/ping-guard.conf > /dev/null < ping-guard.conf
sudo chmod 644 /etc/newsyslog.d/ping-guard.conf
sudo newsyslog -nv      # dry-run (parser check)
sudo newsyslog          # force first pass
```

**One-time truncation** (launchd writers hold fds; `:>` preserves fd):

```bash
: > ~/Library/Logs/ping-guard/auto-os.err
: > ~/Library/Logs/ping-guard/daemon.err
launchctl kickstart -k "gui/$(id -u)/com.ping-guard.daemon"
launchctl kickstart -k "gui/$(id -u)/com.ping-guard.auto-os"
```

---

## Task 3 — Supervisor Rollback (chosen: **Option C**, pre-flight kickstart + 24 h cooldown)

**Why C**: A never rolls back → bad deploy sticks. B rolls back on transient wake-from-sleep events. C distinguishes transient (daemon crashed, restart fixes) from structural (code broken, rollback needed) — which is what we actually want.

**Policy**:
1. On stale heartbeat: 3× `launchctl kickstart -k`, 15 s apart.
2. If still stale and no rollback in last 24 h → rollback + record timestamp.
3. If cooldown active → kickstart only + `osascript` notification.

**Patch for `/Users/umasankr/Projects/ping-guard/scripts/supervisor.sh`** (adds near top):

```bash
ROLLBACK_STAMP_FILE="$HOME/.ping-guard/last-rollback-epoch"
ROLLBACK_COOLDOWN=$((24 * 3600))

notify() {
  /usr/bin/osascript -e "display notification \"$1\" with title \"ping-guard supervisor\""
}

attempt_restart() {
  launchctl kickstart -k "gui/$UID_NUM/$DAEMON_LABEL" 2>/dev/null || true
  sleep 15
  [ -f "$HEARTBEAT_FILE" ] || return 1
  local AGE=$(($(date +%s) - $(stat -f %m "$HEARTBEAT_FILE")))
  [ "$AGE" -lt "$VERIFY_WINDOW" ]
}
```

Replace current `if [ "$AGE" -gt "$VERIFY_WINDOW" ]` block:

```bash
if [ "$AGE" -gt "$VERIFY_WINDOW" ]; then
  log "Heartbeat stale (${AGE}s). Pre-flight: 3x kickstart."
  for i in 1 2 3; do
    if attempt_restart; then
      log "Recovered on attempt $i — rollback avoided."
      break
    fi
    log "Attempt $i failed."
  done

  AGE=$(($(date +%s) - $(stat -f %m "$HEARTBEAT_FILE" 2>/dev/null || echo 0)))
  if [ "$AGE" -gt "$VERIFY_WINDOW" ]; then
    NOW=$(date +%s)
    LAST_RB=$(cat "$ROLLBACK_STAMP_FILE" 2>/dev/null || echo 0)
    if [ $((NOW - LAST_RB)) -lt "$ROLLBACK_COOLDOWN" ]; then
      log "ROLLBACK_SUPPRESSED: cooldown active."
      notify "Daemon unhealthy but rollback suppressed (24h cooldown)."
      launchctl kickstart -k "gui/$UID_NUM/$DAEMON_LABEL" 2>/dev/null || true
    else
      log "Proceeding with rollback."
      # existing rollback block (SHA validate -> git checkout -- . -> kickstart)
      echo "$NOW" > "$ROLLBACK_STAMP_FILE"
      notify "ping-guard rolled back to last-good commit."
    fi
  fi
fi
```

**Outcome**: rollbacks become rare (< 1/24 h); transients (wake, Docker cold-start) no longer trigger rollbacks because 3× 15 s kickstart bridges them. Cites: `supervisor.sh:40-69` current rollback block.

---

## Task 4 — OrbStack Wake Behavior

**Observed**: `orbctl status` → `Running` on demand. After system sleep OrbStack's Linux VM pauses; it resumes **lazily on next Docker call**. There is no OrbStack API guarantee of auto-resume on wake. `wake_detector.py:54-85` already polls `docker info` but (a) never explicitly calls `orbctl start` and (b) caps wait at 90 s — Apple Silicon cold-start of the VM + 3 compose services can exceed 90 s after a long sleep.

**Patch — `/Users/umasankr/Projects/ping-guard/scripts/wake_detector.py`**:

```python
def _wait_for_docker(timeout_s: int = 120, poll_s: int = 5) -> bool:
    """Poll Docker until containers are running or timeout."""
    LOG.info("Waiting for Docker readiness...")

    # Ensure OrbStack is up before polling Docker.
    try:
        subprocess.run(
            ["/opt/homebrew/bin/orbctl", "start"],
            capture_output=True, text=True, timeout=30,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        LOG.warning("orbctl start failed: %s", exc)

    deadline = time.time() + timeout_s
    # ... existing body ...
```

Also bump default `timeout_s=90` → `120` (line 54).

**Verification**:

```bash
pmset sleepnow    # or close lid
# on wake:
tail -f ~/Library/Logs/ping-guard/wake-detector.err
```

Expect `Wake detected → orbctl start → Docker ready: 3 containers running`.

---

## Task 5 — Session Cap & `native-sync` Reaper

**Enforcement**: `src/session/SessionManager.ts:260` throws when active ≥ cap; `src/http/rest-server.ts:4055` maps to HTTP 429.
**Default cap**: `10` at `SessionManager.ts:54`.

**Why `native-sync` never ends**: `~/.claude/hooks/ping-mem-native-sync.sh:29-47` creates a session named `native-sync` on every Claude Code SessionStart, caches the ID at `~/.ping-mem/sync-session-id`, re-validates with `/api/v1/status`, but **never calls `/api/v1/session/end`**. Cache file is wiped by container restart / tests / permission errors → fresh session each time → queue grows. Confirmed: 5 live `native-sync` sessions in a 25-minute window, all zero memories/events.

**TTL doesn't save us**: `SessionManager.ts:215` `cleanup()` evicts when `now - lastActivityAt > sessionTtlMs (3_600_000)`. But the hook's GET `/api/v1/status` reads bump `lastActivityAt`, so idle sessions never age out.

**Principled fix (three layers — ship all three)**:

### 5a. Cap raise

`SessionManager.ts:54`:

```ts
const DEFAULT_CONFIG: Required<Omit<SessionManagerConfig, "eventStore">> = {
  maxActiveSessions: 50,          // was 10
  autoCheckpointInterval: 300000,
  sessionTtlMs: 3_600_000,
};
```

50 is safe: each session is a Map entry + event row; < 10 KB each.

### 5b. Named-session reaper

Add to `SessionManager` class:

```ts
/** Auto-end idle system sessions by name. */
private async reapSystemSessions(now: number): Promise<number> {
  const SYSTEM_NAMES = new Set(["native-sync", "auto-recall", "canary"]);
  const SYSTEM_IDLE_MS = 10 * 60 * 1000;  // 10 min
  let reaped = 0;
  for (const [id, s] of this.sessions) {
    if (s.status !== "active") continue;
    if (!SYSTEM_NAMES.has(s.name)) continue;
    if (s.memoryCount > 0 || s.eventCount > 0) continue;
    if (now - s.lastActivityAt.getTime() < SYSTEM_IDLE_MS) continue;
    try { await this.endSession(id); reaped++; }
    catch (err) { log.warn("reapSystemSessions: end failed", { id, error: String(err) }); }
  }
  return reaped;
}
```

Call at top of `cleanup()` (line 215):

```ts
async cleanup(): Promise<number> {
  const now = Date.now();
  const reapedSystem = await this.reapSystemSessions(now);
  // ...existing TTL loop...
  return evicted + reapedSystem;
}
```

### 5c. Hook-side close

In `~/.claude/hooks/ping-mem-native-sync.sh`, after import completes:

```bash
curl -s --max-time 3 -X POST "$PING_MEM_URL/api/v1/session/end" \
  -H 'Content-Type: application/json' -H "X-Session-ID: $SESSION_ID" >/dev/null 2>&1
rm -f "$SESSION_CACHE"
```

Together: zero zombies **and** 5× headroom.

---

## Task 6 — macOS launchd Best Practices

Add to both `com.ping-mem.daemon.plist` and `com.ping-guard.daemon.plist`:

```xml
<key>ProcessType</key>
<string>Interactive</string>          <!-- opts out of App Nap throttling -->

<key>LowPriorityIO</key>
<false/>                              <!-- SQLite/Neo4j need normal IO priority -->

<key>ExitTimeOut</key>
<integer>30</integer>                 <!-- 30s SIGTERM window before SIGKILL -->

<key>LegacyTimers</key>
<true/>                               <!-- disable coalesced low-power timers -->

<key>SoftResourceLimits</key>
<dict>
  <key>NumberOfFiles</key><integer>4096</integer>
</dict>

<key>HardResourceLimits</key>
<dict>
  <key>NumberOfFiles</key><integer>8192</integer>
</dict>
```

**App Nap note**: `NSAppSleepDisabled` in `Info.plist` is not applicable — bun/node are CLI binaries, not bundles. `ProcessType=Interactive` in the launchd plist (per Apple TN2083 / `launchd.plist(5)`) is the correct mechanism.

**ThrottleInterval 30** is the documented floor; do not lower.

**Log paths already present** — after Task 2, newsyslog compresses them in place; no plist change required.

---

## Task 7 — Disk & Log Pre-Flight in `ping-mem-doctor`

Thresholds file: `~/.ping-mem/thresholds.json`:

```json
{
  "disk_usage_percent_warn": 85,
  "disk_usage_percent_fail": 92,
  "log_dir_mb_warn": 50,
  "log_dir_mb_fail": 200,
  "log_paths": [
    "~/Library/Logs/ping-guard",
    "~/Library/Logs/ping-mem-daemon.log"
  ]
}
```

Check module (new file `src/cli/doctor/disk-checks.ts`). Uses `execFileSync` (safer than `execSync` — no shell interpolation):

```ts
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

export interface DiskThresholds {
  disk_usage_percent_warn: number;
  disk_usage_percent_fail: number;
  log_dir_mb_warn: number;
  log_dir_mb_fail: number;
  log_paths: string[];
}

export type CheckStatus = "ok" | "warn" | "fail";

export function checkDiskAndLogs(t: DiskThresholds): { status: CheckStatus; messages: string[] } {
  const msgs: string[] = [];
  let worst: CheckStatus = "ok";
  const bump = (s: "warn" | "fail") => { if (s === "fail" || worst === "ok") worst = s; };

  // df -P ~/.ping-mem
  const dfOut = execFileSync("df", ["-P", `${homedir()}/.ping-mem`], { encoding: "utf8" });
  const last = dfOut.trim().split("\n").pop() ?? "";
  const pct = Number(last.split(/\s+/)[4]?.replace("%", "") ?? "0");
  if (pct >= t.disk_usage_percent_fail) { bump("fail"); msgs.push(`disk ${pct}% >= fail ${t.disk_usage_percent_fail}`); }
  else if (pct >= t.disk_usage_percent_warn) { bump("warn"); msgs.push(`disk ${pct}% >= warn ${t.disk_usage_percent_warn}`); }

  for (const p of t.log_paths) {
    const abs = p.replace(/^~/, homedir());
    try {
      const kbLine = execFileSync("du", ["-sk", abs], { encoding: "utf8" });
      const kb = Number(kbLine.trim().split(/\s+/)[0]);
      const mb = kb / 1024;
      if (mb >= t.log_dir_mb_fail) { bump("fail"); msgs.push(`${abs} ${mb.toFixed(0)}MB >= fail`); }
      else if (mb >= t.log_dir_mb_warn) { bump("warn"); msgs.push(`${abs} ${mb.toFixed(0)}MB >= warn`); }
    } catch { /* missing path is fine */ }
  }
  return { status: worst, messages: msgs };
}
```

Wire into `ping-mem-doctor` so `fail` → non-zero exit. Surfaces the problem at 85 %, not at 96 %.

---

## Summary Matrix

| Task | Root cause | Fix | Files |
|---|---|---|---|
| 1 | No reclamation process | One-shot script + monthly cron | new `scripts/disk-reclaim.sh` |
| 2 | No rotation in plists | `newsyslog.d/ping-guard.conf` 5 MB/3/bz2 | `/etc/newsyslog.d/ping-guard.conf` |
| 3 | Rollback on any transient | 3× kickstart + 24 h cooldown | `ping-guard/scripts/supervisor.sh` |
| 4 | Implicit OrbStack resume | `orbctl start` + 120 s timeout | `ping-guard/scripts/wake_detector.py` |
| 5 | `native-sync` never ends, cap 10 | Reaper + cap 50 + hook ends session | `ping-mem/src/session/SessionManager.ts`, `~/.claude/hooks/ping-mem-native-sync.sh` |
| 6 | App Nap, no FD limit | `ProcessType=Interactive`, FD limits, `ExitTimeOut` | `com.ping-mem.daemon.plist`, `com.ping-guard.daemon.plist` |
| 7 | No pre-flight disk check | `thresholds.json` + doctor module | `~/.ping-mem/thresholds.json`, `src/cli/doctor/disk-checks.ts` |

All measurements are real (`df`, `du`, `docker system df`, live `curl /api/v1/session/list`, 2026-04-18 08:45).

All tasks completed.
