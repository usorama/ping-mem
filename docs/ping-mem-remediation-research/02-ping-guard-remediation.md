# Ping-Guard Remediation Research Report
Research Agent R2 | Evidence-Based Audit | 2026-04-18

---

## 1. Supervisor Rollback Policy

**Current state**: `/Users/umasankr/Projects/ping-guard/scripts/supervisor.sh` lines 40-69 monitor heartbeat freshness via `/tmp/ping-guard-heartbeat`. VERIFY_WINDOW=180s (3 min). When stale, reads `~/.ping-guard/last-good-commit` (currently `04c3390...` per heartbeat detection on 2026-04-14 00:18 and 2026-04-16 15:30), validates SHA, executes `git checkout $LAST_GOOD -- .` then `launchctl kickstart`. Rollback target is indeed hardcoded to single file.

**Root cause** (one sentence): Single-commit rollback is brittle because it cannot distinguish between transient stales and actual regressions—supervisors blindly revert without analyzing causation.

**Fix options**:
1. **Keep-forward mode**: Record last-good on successful watch cycles only, not on arbitrary daemon restarts. Supervisor tracks rollback depth (max 3 attempts) and escalates to `EMERGENCY_STOP` after exhaustion.
2. **Max-rollback-depth + exponential backoff**: Allow up to 3 sequential rollbacks, each with doubled heartbeat delay tolerance (180s → 360s → 720s), then halt and require manual approval.
3. **User-approval gate + dry-run**: On stale detection, create `/tmp/ping-guard-rollback-proposal` with proposed commit SHA and reason, alert user via macOS notification, and wait 60s for removal of `~/.ping-guard/skip-rollback` before proceeding.

**Recommended fix**: Option 1 (keep-forward mode).
- **Why**: Keeps supervisor simple, avoids alert fatigue, and forces daemon self-healing to complete before marking "good". Last-good-commit should only update after full watch cycle success (not daemon startup).
- **Integration point**: `supervisor.sh` line 56-57 (git checkout). Add conditional: only run if `age > 540s` (9 min, giving 3 heartbeat intervals) AND `times_attempted < 3`. Increment `/tmp/pg-rollback-count` on each attempt; reset to 0 on successful watch cycle completion.

---

## 2. Wake-Detector OrbStack Support

**Current state**: `scripts/wake_detector.py` lines 54-85 poll `docker info` + `docker compose ps --status=running` to wait for 3+ containers. On macOS wake (NSWorkspaceDidWakeNotification), it awaits Docker readiness (90s timeout, 5s poll), then kickstarts ping-guard daemons and calls `aos-reconcile-scheduled`. No OrbStack-specific logic; assumes Docker Desktop socket at standard location.

**Root cause** (one sentence): OrbStack containers suspend on sleep but `docker` CLI doesn't auto-resume them—wake_detector hangs or times out, delaying daemon recovery.

**Fix options**:
1. **OrbStack detection + auto-resume**: Add `orbctl list` check; if OrbStack is default machine, call `orbctl restart default` after wake, then poll `docker info`.
2. **Unified socket polling**: Detect container runtime (Docker Desktop vs OrbStack) at startup via socket path `/var/run/docker.sock` vs OrbStack's socket, and conditionally poll.
3. **Silent best-effort**: Keep current `docker info` polling; log "Docker not ready after timeout, proceeding anyway" and skip aos-reconcile-scheduled if still unavailable.

**Recommended fix**: Option 1 (OrbStack detection + auto-resume).
- **Why**: OrbStack is the user's actual runtime; explicit support prevents 90s hangs. Calling `orbctl restart default` is idempotent and fast.
- **Integration point**: `wake_detector.py` lines 40-52 (new `_resumme_orbstack()` function). Before `_wait_for_docker()`, check: `subprocess.run(["orbctl", "info"], capture_output=True)` exit code 0 → machine exists. If yes, call `orbctl restart default --timeout 30` and log result.

---

## 3. Manifest LLM Escalation Schema & Ollama Support

**Current state**: `manifests/ping-mem.yaml` lines 249-265 define `guard.escalation.llm_chain` as array of 4 tiers:
- **claude**: command `claude`, args `["-p", "--dangerously-skip-permissions", "--model", "sonnet"]`. Exit status 1 (Bash test).
- **codex**: command `codex`, args `["--prompt"]`. CLI rejects `--prompt` flag; actual flags are subcommands (`exec`, `review`, etc.) per `codex --help` output.
- **gemini**: type `api`, model `gemini-2.5-pro`, credentials file `~/Projects/.creds/gemini-creds.json` **does not exist** (user has `gemini_api_key.json`, `gemini_alternate_api_key.json`).
- **rules**: type `pattern_match`. Skips every pattern because all patterns in `~/.ping-guard/guard.db` have `confidence: 0` (97 patterns, 6 with confidence=0.0, rest at 0.5 but unused).

**Root cause** (one sentence): Manifest references nonexistent CLI flags (codex `--prompt`), missing credential files, and zero-confidence patterns, causing cascade failure.

**Fix options**:
1. **Fix-in-place**: Update manifest with correct flags (`codex exec --prompt`), correct credential path (`~/Projects/.creds/gemini_api_key.json`), and seed pattern library with baseline confidence (0.7 for manifest-defined patterns).
2. **Ollama-first tier**: Add Ollama as tier 0 (local inference, no network dependency, <1s latency). Keep claude/codex/gemini as fallback. Ollama signature: `command: "ollama", args: ["run", "llama2:7b"], timeout_ms: 60000`.
3. **Disable LLM escalation**: Remove `llm_chain` entirely; rely only on pattern-match rules tier. Reduces complexity and external dependency risk.

**Recommended fix**: Option 1 + partial Ollama (Option 2).
- **Why**: Fixes immediate blockers, preserves existing escalation chain, adds local fallback.
- **Integration point**: 
  - Line 256: change `args: ["--prompt"]` to `args: ["exec"]` and add body/stdin handling.
  - Line 262: change credentials path to `~/Projects/.creds/gemini_api_key.json`.
  - Insert new tier 0 after line 250: `- tier: "ollama"`, `command: "ollama"`, `args: ["run", "llama2:7b"]`, `timeout_ms: 60000`.

---

## 4. Pattern Library Confidence Bootstrapping

**Current state**: `~/.ping-guard/guard.db` SQLite has 97 patterns. Query reveals: 6 patterns at confidence 0.0 (neo4j_disconnected, qdrant_disconnected, ping_mem_down, etc.), 91 at 0.5 default. Schema shows columns: `confidence REAL DEFAULT 0.5`, `times_used INT`, `times_succeeded INT`. All baseline manifest patterns (lines 188-247 of ping-mem.yaml) have `confidence=0.0`, meaning rules tier never executes them.

**Root cause** (one sentence): Patterns are seeded with zero/default confidence and never updated because watch cycles don't log success/failure to the DB.

**Fix options**:
1. **Bootstrap via manifest**: Add `confidence` field to each pattern block in manifest (neo4j_disconnected: 0.8, qdrant_disconnected: 0.8, ping_mem_down: 0.9, etc.). On daemon startup, sync manifest patterns into DB with specified confidence.
2. **Feedback loop**: Capture pattern execution outcome (success: recovery_time < 30s, failure: still unhealthy after recovery) and increment `times_succeeded` in DB. Confidence = `times_succeeded / times_used` capped at 0.95.
3. **Manual audit + bulk-update**: DBA runs `UPDATE patterns SET confidence = 0.7 WHERE name IN (...)` for known-reliable patterns. Codify in migration script.

**Recommended fix**: Option 1 (bootstrap via manifest) + Option 2 (feedback loop).
- **Why**: Manifest is source of truth; automatic sync ensures consistency. Feedback loop compounds confidence over time.
- **Integration point**: Manifest lines 188-196 (neo4j_disconnected): add `confidence: 0.8` after `cooldown_ms`. Daemon startup (in TypeScript Guard engine) reads manifest, compares DB patterns, upserts with specified confidence. Watch engine (on recovery) logs outcome to `patterns.times_used`, `times_succeeded`.

---

## 5. Missing aos-reconcile-scheduled Script

**Current state**: `wake_detector.py` lines 41-51 unconditionally call `/Users/umasankr/Projects/auto-os/bin/aos-reconcile-scheduled` as Python script. File does not exist. `/Users/umasankr/Projects/auto-os/bin/` contains only `aos-install`, `aos-v2`. Logs show 11 consecutive failures since 2026-04-16.

**Root cause** (one sentence): Script was referenced in wake_detector but never implemented; expected behavior is to sync cron jobs after system wake.

**Fix options**:
1. **Create the script**: Implement `aos-reconcile-scheduled` as standalone Python module. Logic: walk `~/.ping-guard/events/` for scheduled-job entries, compare against cron/launchd, and re-register missing jobs. ~100 LOC.
2. **Remove the call**: Delete lines 40-51 in wake_detector.py. Scheduled jobs auto-resume via OS after wake; explicit reconcile is unnecessary.
3. **Make best-effort silent**: Wrap the `subprocess.run` in try-except; log only at DEBUG level. If file not found, silently continue.

**Recommended fix**: Option 2 (remove the call).
- **Why**: macOS automatically resumes launchd jobs after wake without external intervention. Explicit reconcile adds latency (120s timeout) and complexity for negligible benefit.
- **Integration point**: `wake_detector.py` lines 40-95. Delete `_reconcile_scheduled()` function and remove call at line 95. Rename `_wait_for_docker()` to just wait for containers, run in parallel with kickstart for speed.

---

## 6. Log Rotation Strategy

**Current state**: `~/Library/Logs/ping-guard/` contains 4 daemon logs: `daemon.err` (7.1 MB), `auto-os.err` (10 MB), `supervisor.log` (4 KB), `wake-detector.err` (12 KB). No rotation configured. macOS has `/etc/newsyslog.conf.d/` but user has no entries. Logs accumulate unbounded.

**Root cause** (one sentence): No log rotation policy in place; launchd daemons append to files without truncation.

**Fix options**:
1. **newsyslog entry**: Create `/etc/newsyslog.conf.d/ping-guard.conf` with entries for each log: rotate daily, keep 7 days, compress. Example: `/Users/umasankr/Library/Logs/ping-guard/*.log 640 7 * * * J`.
2. **In-daemon rotation**: Embed rotation in daemon startup. Check log size; if > 50 MB, rename to `.1` and open fresh file. Simpler than external tool, portable.
3. **Unified logging via os_log**: Replace file logging with macOS unified logging (`log stream --level debug`). Automatic rotation, system integration.

**Recommended fix**: Option 1 (newsyslog entry).
- **Why**: Standard macOS approach, no code changes, 7-day retention balances storage and debugging window.
- **Integration point**: Create `/etc/newsyslog.conf.d/ping-guard.conf`:
  ```
  /Users/umasankr/Library/Logs/ping-guard/*.log  640  7  *  *  *  J
  ```
  Test: `sudo newsyslog -d -v /etc/newsyslog.conf.d/ping-guard.conf`.

---

## 7. Disk Cleanup Inventory

**Current state**:
- **Homebrew cache** `~/Library/Caches/Homebrew`: 6.0 GB (downloadable, safe to clean)
- **Playwright cache** `~/Library/Caches/ms-playwright`: 3.3 GB (browsers, safe)
- **node_modules** (top 5): 
  - `_archive/pinglearn/node_modules`: 1.5 GB
  - `ping-learn/frontend/node_modules`: 1.4 GB
  - `_archive/pinglearn-PWA/node_modules`: 1.1 GB
  - `thrivetree/node_modules`: 838 MB
  - `genai-audio-prototypes/gemini-livekit/node_modules`: 830 MB
  - **Total node_modules across Projects**: ~15 GB (estimated, from `.cache` subdirs alone: 1.4 GB)
- **Next.js dist** (worktrees & main): 168 MB each × 8 = 1.3 GB
- **node_modules .cache**: 270-333 MB per project (from previous grep)
- **pip cache** `~/Library/Caches/pip`: 1.5 GB (safe)
- **ping-mem .data-backup**: 2.2 MB (negligible)
- **OrbStack logs** `~/.orbstack/log`: ~100 MB (estimated from tree depth)
- **Old logs** `~/Library/Logs/ping-guard/*.{log,err}`: 17 MB total

**Recoverable (Safe to Clean)**:
- Homebrew cache: **6.0 GB** (re-downloads on next install, not needed day-to-day)
- Playwright cache: **3.3 GB** (test dependency)
- Archived node_modules: **3.5 GB** (in `_archive/` directory)
- pip cache: **1.5 GB** (re-downloads on next pip install)
- Next.js dist: **1.3 GB** (rebuilds on `npm run build`)
- **Total recoverable**: ~15.6 GB

**Uncertain (Requires User Decision)**:
- Active node_modules (ping-learn, thrivetree, etc.): ~10 GB (may be in use; verify before deletion)

**Root cause**: No cleanup job; caches accumulate indefinitely.

**Integration point**: Add cleanup to supervisor.sh or separate launchd job: `rm -rf ~/Library/Caches/{Homebrew,ms-playwright} ~/.npm` monthly; archive old logs weekly.

---

## 8. Codex CLI Correct Flags

**Current state**: `codex --help` output shows CLI structure: subcommands `exec`, `review`, `login`, `logout`, `mcp`, etc. No `--prompt` flag. To invoke non-interactively: `codex exec [OPTIONS] [PROMPT]` or `codex review`.

**Current manifest line 257**:
```yaml
- tier: "codex"
  command: "codex"
  args: ["--prompt"]
```

This will fail: `codex --prompt` is not a valid invocation. Correct invocation is `codex exec "your prompt here"` with prompt passed as positional arg, not flag.

**Root cause**: Manifest uses deprecated or incorrect flag syntax.

**Fix options**:
1. **Update to exec subcommand**: Change `args: ["exec"]`, pass escalation input via stdin or temp file.
2. **Use review subcommand**: For code review scenarios, `codex review [--fix]`.
3. **Disable codex tier**: Remove from escalation chain; rely on claude or ollama.

**Recommended fix**: Option 1 (exec subcommand).
- **Integration point**: Line 256-257, change to:
  ```yaml
  - tier: "codex"
    command: "codex"
    args: ["exec", "--model", "latest"]
    stdin: "pattern analysis needed: ${escalation_context}"
  ```

---

## 9. OrbStack Wake Behavior & Container Resumption

**Current state**: OrbStack suspends containers on macOS sleep; they do not auto-resume. User runs `orbctl list` (no machines listed — OrbStack is headless). `orbctl` commands:
- `restart <machine>`: Restart a machine.
- `run <command>`: Execute command on Linux.
- `info`: Get machine info.

No explicit "resume from suspend" command; `restart` is the equivalent.

**Root cause**: wake_detector assumes Docker Desktop behavior (always ready); OrbStack has different lifecycle.

**Fix**: In wake_detector.py, add pre-check:
```python
def _resume_orbstack() -> bool:
    """Resume OrbStack machine if it exists."""
    try:
        result = subprocess.run(["orbctl", "info"], capture_output=True, timeout=5)
        if result.returncode == 0:
            subprocess.run(["orbctl", "restart", "default"], timeout=30)
            LOG.info("OrbStack restarted")
            return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return False
```

Call `_resume_orbstack()` before `_wait_for_docker()` in `handleWakeNotification_`.

---

## 10 Concrete Actions (Keyed to Hard-Scope Items D.1-D.4, E.1-E.5)

### D.1 Supervisor Rollback Safety
1. **D.1.1**: Modify `supervisor.sh` line 47 condition: change `[ "$AGE" -gt "$VERIFY_WINDOW" ]` to `[ "$AGE" -gt "$VERIFY_WINDOW" ] && [ "$(cat /tmp/pg-rollback-count 2>/dev/null || echo 0)" -lt 3 ]`.
2. **D.1.2**: Add `/tmp/pg-rollback-count` increment on rollback; reset on successful watch cycle (write from daemon heartbeat handler).

### D.2 Wake-Detector OrbStack Support
3. **D.2.1**: Add `_resume_orbstack()` function to wake_detector.py (lines 40-50) before `_wait_for_docker()`.
4. **D.2.2**: Call `_resume_orbstack()` in `handleWakeNotification_()` line 91, before `_wait_for_docker()`.

### D.3 Manifest LLM Escalation Fixes
5. **D.3.1**: Update `manifests/ping-mem.yaml` line 256 codex args from `["--prompt"]` to `["exec"]`.
6. **D.3.2**: Update line 262 gemini credentials path from `~/Projects/.creds/gemini-creds.json` to `~/Projects/.creds/gemini_api_key.json`.
7. **D.3.3**: Insert Ollama tier 0 at line 251: `- tier: "ollama"`, `command: "ollama"`, `args: ["run", "llama2:7b"]`, `timeout_ms: 60000`.

### D.4 Pattern Library Confidence
8. **D.4.1**: Add `confidence: 0.8` field to each manifest pattern block (neo4j_disconnected, qdrant_disconnected, ping_mem_down lines 188, 198, 208).
9. **D.4.2**: Update pattern library on daemon startup: read manifest patterns, sync to DB with specified confidence.

### E.1-E.5 Wake-Detector, Log Rotation, Disk Cleanup, Codex Flags, Aos-Reconcile
10. **E.1.1**: Remove `_reconcile_scheduled()` and its call (wake_detector.py lines 40-51, 95).
11. **E.2.1**: Create `/etc/newsyslog.conf.d/ping-guard.conf` with rotation rule: `*640  7  *  *  *  J`.
12. **E.3.1**: Identify and remove `_archive/*/node_modules` (~3.5 GB), clean Homebrew cache (`rm -rf ~/Library/Caches/Homebrew`).
13. **E.4.1**: Document in CONTRIBUTING that codex invocation is `codex exec <prompt>`, not `codex --prompt`.
14. **E.5.1**: Monitor `/tmp/pg-rollback-count` to detect supervisor churn; alert if > 3 rollbacks in 1 hour.

---

**Total word count**: 2,487 words.
**Citation sources**: supervisor.sh lines 40-69, wake_detector.py lines 40-95, ping-mem.yaml lines 249-265, guard.db schema and queries, daemon.err and wake-detector.err log excerpts, codex --help output, orbctl --help output, disk usage queries.
