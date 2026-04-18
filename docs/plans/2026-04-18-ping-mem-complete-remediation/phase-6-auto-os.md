---
phase-id: P6
title: "auto-os integration — service session, paro-jobs schema, cross-project search"
status: pending
effort_estimate: 2h
dependent-on: [phase-0-prep, phase-1-memory-sync-mcp-auth]
owns_wiring: [W25, W26, W27]
owns_outcomes: [contributes O2, O8]
addresses_gaps: [G.1, G.2, G.3]
blocks: ["phase-7-soak-regression (soft gate: auto-os-cross-project-hit)"]
adr_refs: []
research_refs:
  - docs/ping-mem-remediation-research/07-synthesis.md (G section)
---

# Phase 6 — auto-os Integration

## Phase Goal

Deliver **G.1** (auto-os write path to ping-mem works — no 429 from session cap, no 403 from missing admin auth), **G.2** (`~/Projects/auto-os/docs/paro-jobs-schema.yaml` documents the `ping_mem` read/write contract so any paro-jobs.yaml author can wire memory into a scheduled job), and **G.3** (cross-project memory search proven end-to-end: content written by a Claude Code session in project A is findable from an auto-os agent running in project B).

This phase does NOT introduce new code in ping-mem. Everything it owns is wiring documentation + an allowlist extension (one-line) + a service-session convention + a verified functional test that proves cross-project retrieval works. It contributes to **O2** (5/5 regression queries hit — adds a cross-project variant) and **O8** (0 session-cap collisions — ensures long-lived auto-os worker sessions are not reaped mid-flight).

---

## Pre-conditions

1. **P0 Prep complete**: worktree active, baseline captured, `~/.claude.json` perm 600.
2. **P1 complete and green**:
   - `~/.claude.json#mcpServers.ping-mem.env` contains `PING_MEM_ADMIN_USER` + `PING_MEM_ADMIN_PASS` (P1.1).
   - `SessionManager.ts` `maxActiveSessions` raised to 50 and `reapSystemSessions()` exists with named-session allowlist `["native-sync", "auto-recall", "canary"]` at the line documented in P1.8 Edit 3.
   - `setInterval`-driven reaper loop wired in the SessionManager constructor (P1.8 Edit 4).
   - `V1.*` verification checklist passed; `F1` (`mcp__ping-mem__context_health`) returns 200.
3. **ping-mem REST reachable from auto-os shell context**:
   ```bash
   curl -sf --max-time 2 -u "$PING_MEM_ADMIN_USER:$PING_MEM_ADMIN_PASS" \
     http://localhost:3003/api/v1/session/list >/dev/null && echo REST_OK
   # Expected: REST_OK
   ```
4. **auto-os repo present** at `~/Projects/auto-os/` with `bin/aos-v2`, `plists/com.aos.v2.scheduler.plist`, and `docs/paro-jobs-schema.yaml` (the last one is the edit target of P6.2 — it exists today, 61 lines, per evidence below).

### Evidence from orchestrator grep (2026-04-18)

Verified before authoring this phase:

- `~/Projects/auto-os/docs/paro-jobs-schema.yaml` exists (61 lines, dated 2026-04-06). Schema block at lines 7–22 documents `name`, `description`, `schedule`, `priority`, `assign`, `context`, `actions`, `starts`, `ends`. **No `ping_mem` section today** — P6.2 adds it.
- `~/Projects/auto-os/paro-jobs.yaml` exists and today encodes two jobs (`auto-os-health-check`, `auto-os-git-status`). Line 16 already invokes `curl http://localhost:3003/health` — proves the reader understands raw shell actions against ping-mem.
- `~/Projects/auto-os/bin/aos-v2` is the v2 runtime entry; `aos-install` registers `com.aos.v2.scheduler.plist`. No dedicated `aos-task inject` binary in `bin/` today (only `aos-v2` and `aos-install`). **Task injection today happens via paro's hourly scan of `paro-jobs.yaml`** (per `CLAUDE.md`). P6.5 uses that path, not a non-existent `aos-task` CLI.
- `~/Projects/auto-os/CLAUDE.md` line 38: "Disallowed in active v2 runtime: Claude Code CLI, …". Auto-os v2 does not itself invoke Claude Code. Memory writes from auto-os happen via **REST HTTP**, not MCP — so the MCP auth block is irrelevant to auto-os jobs. Creds for REST come from `~/Projects/ping-mem/.env` (same source P1.1 used for MCP env).
- P1 `reapSystemSessions` named allowlist is a literal array at the method body (P1.8 Edit 3: `["native-sync", "auto-recall", "canary"]`). P6.1 extends this allowlist — it does NOT redefine it.

---

## Tasks

### P6.1 — Extend reaper named-allowlist with auto-os service-session names

**Outcome**: G.1, contributes O8.

P1's `reapSystemSessions` gives sessions with names in the allowlist a longer idle threshold (`NAMED_IDLE_MIN = 15`) than empty zombie sessions. Auto-os workers are longer-lived than Claude Code interactive sessions — a scheduled job that starts, writes a progress memory, runs for several minutes, and writes a completion memory would look "idle" between writes and get reaped as an empty/stale session without this allowlist entry.

**Edit target**: `src/session/SessionManager.ts`, inside `reapSystemSessions()` (location defined in P1.8 Edit 3). Extend the `isSystemNamed` array only — do not add any new logic.

Before (P1.8 baseline):
```typescript
const isSystemNamed = ["native-sync", "auto-recall", "canary"].includes(s.name);
```

After (P6.1):
```typescript
const isSystemNamed = [
  "native-sync",
  "auto-recall",
  "canary",
  "auto-os-paro",      // P6.1: long-lived auto-os coordinator session
  "auto-os-worker",    // P6.1: short-lived auto-os per-job worker session
].includes(s.name);
```

**Rule**: auto-os agents MUST call `POST /api/v1/session/start` with `{"name": "auto-os-paro"}` (coordinator) or `{"name": "auto-os-worker"}` (per-job), not an unnamed/auto-generated name. Unnamed sessions fall through to the `EMPTY_IDLE_MIN = 10` path and will be reaped.

**Why a separate allowlist, not a config**: matches P1's decision — the allowlist is a literal; the extension is additive; future projects with similar needs (ping-learn, ping-guard) would extend the same array. The registry shape stays a one-line literal for grep-ability.

### P6.2 — Update `~/Projects/auto-os/docs/paro-jobs-schema.yaml` with a `ping_mem` section

**Outcome**: G.2, W26.

Append (do NOT rewrite) a new section to the schema reference file documenting exactly how a `paro-jobs.yaml` job invokes ping-mem REST for read and write. Also add a full example job so copy-paste works for any project author.

**Pre-check**:
```bash
grep -c 'ping_mem' ~/Projects/auto-os/docs/paro-jobs-schema.yaml
# Must return 0 before edit
```

**Edit** — append to the end of `~/Projects/auto-os/docs/paro-jobs-schema.yaml`:

```yaml

# ============================================================================
# ping_mem integration (added 2026-04-18 by ping-mem remediation plan P6)
# ============================================================================
#
# Jobs may write to and read from ping-mem to persist progress, decisions, and
# findings across runs. All calls go through the REST API on localhost:3003.
# Auto-os v2 runtime does NOT invoke MCP; REST is the only supported channel.
#
# Credentials (source of truth: ~/Projects/ping-mem/.env):
#   PING_MEM_ADMIN_USER  (admin Basic Auth username)
#   PING_MEM_ADMIN_PASS  (admin Basic Auth password)
#
# Session contract:
#   Long-lived coordinator session name MUST be "auto-os-paro".
#   Per-job worker session name MUST be "auto-os-worker".
#   These names are on ping-mem's reaper allowlist; other names will be reaped
#   at the 10-minute empty-session threshold (ping-mem SessionManager.ts).
#
# Write a memory:
#   POST /api/v1/context
#   Headers:
#     Authorization: Basic <base64(user:pass)>
#     X-Session-ID: <session id from /session/start>
#     Content-Type: application/json
#   Body:
#     { "key": "auto-os/<project>/<job-name>/<event>",
#       "value": "<arbitrary content, up to 1 MB>",
#       "category": "auto-os",          # optional, for filtering
#       "priority": "normal",           # optional
#       "metadata": { "job_id": "..." } # optional
#     }
#
# Read memories (full-text + semantic hybrid):
#   GET /api/v1/search?query=<url-encoded-query>
#   Headers:
#     Authorization: Basic <base64(user:pass)>
#     X-Session-ID: <session id>
#   Response: { "data": [ { "key": "...", "value": "...", ... } ] }
#
# Start a session (once per coordinator or per worker):
#   POST /api/v1/session/start
#   Body: { "name": "auto-os-paro" }   # or "auto-os-worker"
#   Response: { "sessionId": "..." }
#
# --- Example ping_mem-integrated job ---
jobs:
  - name: auto-os-daily-progress
    description: Write a daily progress memory at start and end of run
    schedule: daily
    priority: P2
    assign: projects
    context:
      cwd: ~/Projects/auto-os
    actions:
      # Start (or reuse) the auto-os-paro coordinator session
      - action: |
          SID=$(curl -s -u "$PING_MEM_ADMIN_USER:$PING_MEM_ADMIN_PASS" \
            -H 'Content-Type: application/json' \
            -d '{"name":"auto-os-paro"}' \
            http://localhost:3003/api/v1/session/start | jq -r .sessionId)
          echo "$SID" > /tmp/auto-os-paro.sid
        tier: T1
      # Write a "start" memory
      - action: |
          SID=$(cat /tmp/auto-os-paro.sid)
          curl -s -u "$PING_MEM_ADMIN_USER:$PING_MEM_ADMIN_PASS" \
            -H "X-Session-ID: $SID" \
            -H 'Content-Type: application/json' \
            -d '{"key":"auto-os/daily-progress/start","value":"job started at '"$(date -u +%FT%TZ)"'"}' \
            http://localhost:3003/api/v1/context
        tier: T1
      # ...job work...
      # Write an "end" memory
      - action: |
          SID=$(cat /tmp/auto-os-paro.sid)
          curl -s -u "$PING_MEM_ADMIN_USER:$PING_MEM_ADMIN_PASS" \
            -H "X-Session-ID: $SID" \
            -H 'Content-Type: application/json' \
            -d '{"key":"auto-os/daily-progress/end","value":"job completed at '"$(date -u +%FT%TZ)"'"}' \
            http://localhost:3003/api/v1/context
        tier: T1
```

**Post-check**:
```bash
grep -c 'ping_mem integration' ~/Projects/auto-os/docs/paro-jobs-schema.yaml
# Must return 1
grep -c 'auto-os-paro' ~/Projects/auto-os/docs/paro-jobs-schema.yaml
# Must return ≥2 (schema text + example)
```

### P6.3 — Cross-project search functional verification (sentinel pattern)

**Outcome**: G.3, W27, contributes O2.

Write a sentinel memory from a ping-learn shell context (using the `ping-learn` KEY_PREFIX that P1.4 introduced), then from a FRESH shell (simulating an auto-os agent context) search for that sentinel via REST. Expect ≥1 hit. This proves memory written by project A is retrievable from project B — the definition of cross-project search.

**Script** — create at `~/Projects/ping-mem/scripts/verify-cross-project-search.sh`:

```bash
#!/usr/bin/env bash
# verify-cross-project-search.sh — P6.3 functional gate
# Writes a sentinel memory under ping-learn's key prefix, then searches for it
# from a fresh session (simulated auto-os agent). Exits 0 on success, 1 on fail.
set -euo pipefail

USER_P="${PING_MEM_ADMIN_USER:-$(grep '^PING_MEM_ADMIN_USER=' ~/Projects/ping-mem/.env | cut -d= -f2)}"
PASS_P="${PING_MEM_ADMIN_PASS:-$(grep '^PING_MEM_ADMIN_PASS=' ~/Projects/ping-mem/.env | cut -d= -f2)}"
URL="http://localhost:3003"
SENTINEL="P6-CROSS-PROJECT-SENTINEL-$(date +%s)"

# 1) Start a "ping-learn-writer" session and write the sentinel under project prefix
SID_WRITE=$(curl -s -u "$USER_P:$PASS_P" \
  -H 'Content-Type: application/json' \
  -d '{"name":"ping-learn-writer"}' \
  "$URL/api/v1/session/start" | jq -r .sessionId)
[ -n "$SID_WRITE" ] || { echo "FAIL: could not start writer session"; exit 1; }

curl -sf -u "$USER_P:$PASS_P" \
  -H "X-Session-ID: $SID_WRITE" \
  -H 'Content-Type: application/json' \
  -d "{\"key\":\"native/ping-learn/sentinel-p6\",\"value\":\"$SENTINEL content for cross-project search verification\"}" \
  "$URL/api/v1/context" >/dev/null
echo "WROTE sentinel under session $SID_WRITE: $SENTINEL"

# End writer session so the read path uses a genuinely different session
curl -s -u "$USER_P:$PASS_P" -X POST "$URL/api/v1/session/end" \
  -H "X-Session-ID: $SID_WRITE" >/dev/null || true

# 2) Start a fresh "auto-os-worker" session and search for the sentinel
SID_READ=$(curl -s -u "$USER_P:$PASS_P" \
  -H 'Content-Type: application/json' \
  -d '{"name":"auto-os-worker"}' \
  "$URL/api/v1/session/start" | jq -r .sessionId)
[ -n "$SID_READ" ] || { echo "FAIL: could not start reader session"; exit 1; }

HITS=$(curl -s -u "$USER_P:$PASS_P" \
  -H "X-Session-ID: $SID_READ" \
  "$URL/api/v1/search?query=$(printf '%s' "$SENTINEL" | jq -sRr @uri)" \
  | jq '.data | length')

if [ "${HITS:-0}" -ge 1 ]; then
  echo "PASS: cross-project search returned $HITS hit(s) from session $SID_READ"
  exit 0
else
  echo "FAIL: cross-project search returned 0 hits"
  exit 1
fi
```

Make executable: `chmod +x ~/Projects/ping-mem/scripts/verify-cross-project-search.sh`.

### P6.4 — Example `paro-jobs.yaml` snippet for the ping-learn project

**Outcome**: G.2 (usability — an operator needs a copy-pasteable example).

Create `~/Projects/ping-learn/.ai/paro-jobs-ping-mem-example.yaml` (documentation-only file; ping-learn's real `paro-jobs.yaml` stays untouched unless the user explicitly enables it):

```yaml
# paro-jobs-ping-mem-example.yaml — reference snippet for ping-learn
# Copy into ~/Projects/ping-learn/paro-jobs.yaml to enable.
# Schema: ~/Projects/auto-os/docs/paro-jobs-schema.yaml (see ping_mem section).
jobs:
  - name: ping-learn-session-heartbeat
    description: Write a heartbeat memory at start and end of each run
    schedule: daily
    priority: P3
    assign: projects
    context:
      cwd: ~/Projects/ping-learn
    actions:
      - action: |
          USER_P=$(grep '^PING_MEM_ADMIN_USER=' ~/Projects/ping-mem/.env | cut -d= -f2)
          PASS_P=$(grep '^PING_MEM_ADMIN_PASS=' ~/Projects/ping-mem/.env | cut -d= -f2)
          SID=$(curl -s -u "$USER_P:$PASS_P" -H 'Content-Type: application/json' \
            -d '{"name":"auto-os-worker"}' \
            http://localhost:3003/api/v1/session/start | jq -r .sessionId)
          curl -s -u "$USER_P:$PASS_P" -H "X-Session-ID: $SID" \
            -H 'Content-Type: application/json' \
            -d '{"key":"native/ping-learn/paro-heartbeat","value":"heartbeat '"$(date -u +%FT%TZ)"'"}' \
            http://localhost:3003/api/v1/context
        tier: T1
```

This file is **documentation only** — committed to ping-learn as a `.ai/` reference. It is not scheduled unless the user promotes it to `~/Projects/ping-learn/paro-jobs.yaml`.

### P6.5 — Smoke test: inject a test memory via the paro-jobs mechanism

**Outcome**: G.1 end-to-end.

There is no dedicated `aos-task inject` CLI today (evidence above — `bin/` contains only `aos-v2` and `aos-install`). The smoke test therefore exercises the real path paro uses: drop a one-off `schedule: once` job into `~/Projects/auto-os/paro-jobs.yaml` that writes a memory, and verify via REST search that the memory lands.

**Steps**:

1. Back up current auto-os paro-jobs.yaml:
   ```bash
   cp -a ~/Projects/auto-os/paro-jobs.yaml ~/Projects/auto-os/paro-jobs.yaml.bak.p6
   ```
2. Append a one-off smoke job (manually executable — do not wait for paro's hourly scan):
   ```bash
   cat >> ~/Projects/auto-os/paro-jobs.yaml <<'YAML'

     - id: p6-smoke-write-memory
       description: "P6.5 smoke test — write a sentinel memory to ping-mem"
       schedule: once
       priority: P3
       assigned_agent: projects
       context:
         cwd: /Users/umasankr/Projects/auto-os
         actions:
           - "curl -s -u \"$USER_P:$PASS_P\" -H 'Content-Type: application/json' -d '{\"name\":\"auto-os-worker\"}' http://localhost:3003/api/v1/session/start"
           - "curl -s -u \"$USER_P:$PASS_P\" -H \"X-Session-ID: $SID\" -H 'Content-Type: application/json' -d '{\"key\":\"auto-os/p6-smoke\",\"value\":\"P6-SMOKE-SENTINEL\"}' http://localhost:3003/api/v1/context"
   YAML
   ```
3. Execute the job actions inline (simulating what paro would do on tick) — one bash block:
   ```bash
   export USER_P=$(grep '^PING_MEM_ADMIN_USER=' ~/Projects/ping-mem/.env | cut -d= -f2)
   export PASS_P=$(grep '^PING_MEM_ADMIN_PASS=' ~/Projects/ping-mem/.env | cut -d= -f2)
   SID=$(curl -s -u "$USER_P:$PASS_P" -H 'Content-Type: application/json' \
     -d '{"name":"auto-os-worker"}' \
     http://localhost:3003/api/v1/session/start | jq -r .sessionId)
   curl -sf -u "$USER_P:$PASS_P" -H "X-Session-ID: $SID" \
     -H 'Content-Type: application/json' \
     -d '{"key":"auto-os/p6-smoke","value":"P6-SMOKE-SENTINEL"}' \
     http://localhost:3003/api/v1/context
   ```
4. Verify via REST search from a fresh session:
   ```bash
   SID2=$(curl -s -u "$USER_P:$PASS_P" -H 'Content-Type: application/json' \
     -d '{"name":"auto-os-worker"}' \
     http://localhost:3003/api/v1/session/start | jq -r .sessionId)
   curl -s -u "$USER_P:$PASS_P" -H "X-Session-ID: $SID2" \
     "http://localhost:3003/api/v1/search?query=P6-SMOKE-SENTINEL" | jq '.data | length'
   # Must print >= 1
   ```
5. Restore paro-jobs.yaml (smoke job is `schedule: once`; leaving it in place is harmless but the smoke is done):
   ```bash
   mv ~/Projects/auto-os/paro-jobs.yaml.bak.p6 ~/Projects/auto-os/paro-jobs.yaml
   ```

---

## Integration Points (grep-verified 2026-04-18)

| Boundary | Owner | Consumer | Contract |
|----------|-------|----------|----------|
| `SessionManager.reapSystemSessions()` named allowlist | ping-mem (extended here, defined in P1.8) | reaper itself | P6.1 appends `"auto-os-paro"`, `"auto-os-worker"` to the literal array. No signature change. |
| `~/Projects/auto-os/docs/paro-jobs-schema.yaml` | auto-os (doc-only file) | any project author writing a `paro-jobs.yaml` | P6.2 appends a `ping_mem integration` section; schema reader is human. |
| `POST /api/v1/context` + `GET /api/v1/search` | ping-mem REST (`src/http/rest-server.ts:759, 1730`) | auto-os shell actions | Unchanged server-side. Auth: Basic; session: `X-Session-ID` header. Body/schema unchanged. |
| `~/Projects/ping-mem/.env` credentials | ping-mem | auto-os paro-jobs actions | P6 reuses the same source P1.1 used (`PING_MEM_ADMIN_USER` / `PING_MEM_ADMIN_PASS`). No new secret. |
| `~/Projects/auto-os/paro-jobs.yaml` (live) | auto-os operator | paro's hourly scanner | P6.5 mutates it temporarily for smoke; restores at end. |

---

## Wiring Matrix (rows owned by P6)

| # | Capability | User / System Trigger | Path (file:line) | Functional Test |
|---|-----------|----------------------|------------------|-----------------|
| W25 | auto-os agent writes to ping-mem successfully (no 429, no 403) | `paro-jobs.yaml` action runs curl to `POST /api/v1/context` | auto-os action → `rest-server.ts:759` via Basic Auth + `X-Session-ID` | F25 |
| W26 | paro-jobs.yaml schema documents the ping-mem contract | operator reads `~/Projects/auto-os/docs/paro-jobs-schema.yaml` | P6.2 `ping_mem integration` section in that file | F26 |
| W27 | Cross-project memory search works (writer = project A, reader = project B) | project B calls `GET /api/v1/search?query=...` | writer session `ping-learn-writer` → `/api/v1/context`; reader session `auto-os-worker` → `/api/v1/search` (`rest-server.ts:1730`) | F27 |

---

## Verification Checklist (V6.x — grep-verifiable, binary)

- [ ] **V6.1** Reaper allowlist extension landed:
  ```bash
  grep -c '"auto-os-paro"' ~/Projects/ping-mem/src/session/SessionManager.ts
  # Must return >= 1
  grep -c '"auto-os-worker"' ~/Projects/ping-mem/src/session/SessionManager.ts
  # Must return >= 1
  ```
- [ ] **V6.2** `bun run typecheck` clean after V6.1 edit (no regression).
- [ ] **V6.3** paro-jobs schema has a `ping_mem` section:
  ```bash
  grep -c 'ping_mem integration' ~/Projects/auto-os/docs/paro-jobs-schema.yaml
  # Must return 1
  grep -c 'POST /api/v1/context' ~/Projects/auto-os/docs/paro-jobs-schema.yaml
  # Must return >= 1
  grep -c 'GET /api/v1/search' ~/Projects/auto-os/docs/paro-jobs-schema.yaml
  # Must return >= 1
  ```
- [ ] **V6.4** Cross-project verify script exists and is executable:
  ```bash
  test -x ~/Projects/ping-mem/scripts/verify-cross-project-search.sh && echo OK
  # Must print OK
  ```
- [ ] **V6.5** ping-learn example snippet file exists:
  ```bash
  test -f ~/Projects/ping-learn/.ai/paro-jobs-ping-mem-example.yaml && echo OK
  # Must print OK
  ```
- [ ] **V6.6** `~/Projects/auto-os/paro-jobs.yaml` is at its pre-P6 byte size after P6.5 cleanup:
  ```bash
  diff <(wc -c < ~/Projects/auto-os/paro-jobs.yaml) <(wc -c < /tmp/pre-p6-paro-jobs.size.txt)
  # Expected: no diff (capture pre-size into /tmp/pre-p6-paro-jobs.size.txt before P6.5)
  ```

---

## Functional Tests (F6.x — runtime, binary)

- [ ] **F6.1 / F25** auto-os shell writes a memory without 429/403:
  ```bash
  USER_P=$(grep '^PING_MEM_ADMIN_USER=' ~/Projects/ping-mem/.env | cut -d= -f2)
  PASS_P=$(grep '^PING_MEM_ADMIN_PASS=' ~/Projects/ping-mem/.env | cut -d= -f2)
  SID=$(curl -s -u "$USER_P:$PASS_P" -H 'Content-Type: application/json' \
    -d '{"name":"auto-os-worker"}' \
    http://localhost:3003/api/v1/session/start | jq -r .sessionId)
  HTTP=$(curl -s -o /dev/null -w '%{http_code}' \
    -u "$USER_P:$PASS_P" -H "X-Session-ID: $SID" \
    -H 'Content-Type: application/json' \
    -d '{"key":"auto-os/f6-test","value":"F6.1 test"}' \
    http://localhost:3003/api/v1/context)
  [ "$HTTP" = "200" ] || [ "$HTTP" = "201" ] && echo PASS || echo "FAIL ($HTTP)"
  ```
- [ ] **F6.2 / F26** paro-jobs schema contract documented (operator-readable):
  - `docs/paro-jobs-schema.yaml` renders the `ping_mem integration` section in a plain `cat` with no yaml-parse errors (`yq eval . ~/Projects/auto-os/docs/paro-jobs-schema.yaml` exits 0).
- [ ] **F6.3 / F27** Cross-project search smoke:
  ```bash
  bash ~/Projects/ping-mem/scripts/verify-cross-project-search.sh
  # Expected last line: "PASS: cross-project search returned N hit(s)..."
  # Expected exit: 0
  ```
- [ ] **F6.4** Reaper does NOT kill a 12-minute-idle `auto-os-paro` session (allowlist threshold 15min holds):
  ```bash
  # 1. Start auto-os-paro session
  SID=$(curl -s -u "$USER_P:$PASS_P" -H 'Content-Type: application/json' \
    -d '{"name":"auto-os-paro"}' http://localhost:3003/api/v1/session/start | jq -r .sessionId)
  # 2. Wait 12 min (simulate long-running job). For test speed, temporarily lower NAMED_IDLE_MIN to 0.1
  #    and EMPTY_IDLE_MIN to 0.05, then verify allowlisted name survives one reaper tick; restore after.
  # 3. Verify session still present
  curl -s -u "$USER_P:$PASS_P" \
    "http://localhost:3003/api/v1/session/list" | jq ".data[] | select(.id == \"$SID\") | .id"
  # Expected: prints $SID (session still alive)
  ```
- [ ] **F6.5 / P6.5 smoke** Direct shell smoke round-trip completes: the steps in P6.5 write `auto-os/p6-smoke` = `P6-SMOKE-SENTINEL`, and the subsequent search returns `>= 1` hit.

---

## Gate Criterion (binary — P6 passes or fails)

P6 PASSES iff ALL of the following are true:

1. V6.1 through V6.6 all green.
2. F6.1 through F6.5 all green.
3. `bun run typecheck` clean (0 errors) post-edit.
4. `bun test` regression baseline not worsened (same failing count as post-P1 or fewer).
5. `~/Projects/auto-os/paro-jobs.yaml` byte-identical to its pre-P6 backup (P6.5 cleaned up).
6. No new untracked files in `~/Projects/auto-os/` outside the schema edit (P6.2) — the example `paro-jobs-ping-mem-example.yaml` lives in **ping-learn**, not auto-os.

Otherwise P6 FAILS. Re-run failing V or F step after the specific fix; do not bulk-retry.

---

## Risks

| # | Risk | Likelihood | Mitigation |
|---|------|-----------|------------|
| R6.1 | Reaper allowlist extension in `SessionManager.ts` causes TS strict-mode error if array is typed as a narrow literal | Low | P1.8 used a plain `string[]` via `.includes(s.name)` pattern — appending strings to the literal preserves type inference. Typecheck in V6.2 confirms. |
| R6.2 | auto-os operator copies the example and hardcodes the cred env in paro-jobs.yaml | Medium | P6.2 example sources from `~/Projects/ping-mem/.env` at action-run time via `grep`; never hardcodes. Schema comment says "source of truth: ~/Projects/ping-mem/.env". |
| R6.3 | `schedule: once` smoke job in P6.5 gets picked up by paro before cleanup, running twice | Low | P6.5 runs the actions inline manually, then deletes the appended block. Paro's hourly scan happens on the hour; P6.5 runs to completion well under that window. If paranoid, stop launchd `com.aos.v2.scheduler.plist` for the 30s test. |
| R6.4 | Cross-project search returns hits only via FTS and not via hybrid/semantic retrieval | Low | Sentinel string contains unique tokens. FTS will match. If hybrid retrieval regresses post-P1, regression suite (F6/W29) catches it independently. |
| R6.5 | `~/Projects/ping-mem/.env` has different creds than `~/.claude.json` (drift) | Low | P1.1 writes `.env` values INTO `~/.claude.json` via `jq`. Both reference the same source. Doctor gate (P5) could optionally assert equality; tracked as GH-NEW-* if needed. |
| R6.6 | `yq` not installed → F6.2 yaml-parse check fails on the tool, not the content | Low | P6.2 post-check uses `grep` (always present); `yq` validation is optional. Document `brew install yq` as operator prerequisite for the stricter check. |

---

## Dependencies

- **Inputs** (must exist before P6 starts):
  - P0 baseline captured; worktree active.
  - P1 complete: `~/.claude.json` has admin creds, `reapSystemSessions` method exists with the documented signature, `setInterval` reaper loop running.
  - `~/Projects/auto-os/docs/paro-jobs-schema.yaml` present (verified — 61 lines, 2026-04-06).
  - `~/Projects/ping-mem/.env` contains `PING_MEM_ADMIN_USER` and `PING_MEM_ADMIN_PASS`.
  - `jq` in PATH (used in all curl examples).

- **Outputs** (consumed by later phases):
  - P7 soak gate `auto-os-cross-project-hit` (SOFT gate, must be green ≥24/30 days) — consumes `verify-cross-project-search.sh`.
  - P8 docs may cross-link the schema `ping_mem integration` section.

---

## What P6 does NOT do

- **No new ping-mem code**. Server-side REST paths are unchanged.
- **No MCP wiring for auto-os**. Auto-os v2 is REST-only by CLAUDE.md policy.
- **No new `bin/aos-task` CLI**. The aos-task binary referenced by an older memory did not land in `bin/`; the smoke test uses the actual paro-jobs.yaml path instead. If the user wants a dedicated `aos-task inject` CLI, that is a separate scoped issue (not a P6 deferral — the capability already exists via paro-jobs.yaml).
- **No modification to ping-learn's live paro-jobs.yaml**. The example snippet lives in `.ai/` as reference only.
- **No changes to launchd plists** in auto-os. The existing `com.aos.v2.scheduler.plist` already runs `aos-v2 scheduler tick` hourly.

---

## Exit state (what P7 inherits)

- Session reaper survives named `auto-os-paro` / `auto-os-worker` sessions for 15 minutes of idle.
- Any project can write/read ping-mem from a `paro-jobs.yaml` action with a copy-pasteable recipe.
- `verify-cross-project-search.sh` is a repeatable soak gate — P7 invokes it daily as the `auto-os-cross-project-hit` SOFT gate.
- Smoke test artifact clean (paro-jobs.yaml byte-identical to pre-P6).
