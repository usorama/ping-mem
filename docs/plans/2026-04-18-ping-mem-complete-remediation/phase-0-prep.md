---
phase-id: P0
title: "Prep — baseline, branch, permissions, tracked deferrals"
status: pending
effort_estimate: 1h
dependent-on: none
owns_wiring: ["W15 (disk partial — full is P4)"]
owns_outcomes: ["contributes to O7"]
blocks: ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"]
parent: overview.md
---

# Phase 0 — Prep

## Phase Goal

Establish a clean, reproducible starting point for the remediation so every subsequent phase has a fixed rollback point and a measurable baseline. P0 contributes to **O7** (disk ≤85%) by codifying the disk cleanup that already ran in-session, and creates the single pre-commit state (baseline git tag + typecheck/test snapshot + metrics snapshot) against which every later phase is measured. P0 writes no product code — it is setup, evidence capture, and security hygiene only.

## Pre-conditions

P0 is the entry phase. Nothing is required from other phases. The following environmental assumptions MUST hold before P0 starts; each is verified by a V<N> check in §Verification:

- `pwd` ends in `ping-mem` and the git remote points to the correct `ping-mem` repo.
- `ping-mem` container is healthy (already confirmed in this session: `docker ps` → `ping-mem Up 3 days (healthy)`).
- REST API reachable at `http://localhost:3003` (per `~/.claude.json#PING_MEM_REST_URL` and `docker port ping-mem` = `3003/tcp -> 0.0.0.0:3003`).
- `bun`, `gh`, `git`, `docker`, `chmod`, `stat`, `pgrep`, `pkill`, `tee`, `curl`, `jq` on `PATH`.
- Current user has write access to `~/.claude.json` (confirmed: file is owned by user, perm 644).

## Tasks

All commands below are exact. Copy-paste runnable from repo root `/Users/umasankr/Projects/ping-mem` unless otherwise noted.

---

### P0.1 — Remediation branch

**Context.** Main branch currently has uncommitted research + plan artifacts (`git status` at plan time shows modifications across `src/http/*`, `src/graph/*`, `CLAUDE.md`, `docker-compose.yml`, plus deletions of `src/graph/RelationshipInferencer*`). A worktree was considered and rejected in favor of a side-by-side plan directory coexistence: the plan files are additive (`docs/plans/2026-04-18-ping-mem-complete-remediation/*.md`) and do not collide with the in-flight work. We branch off `main` so the remediation commits sit on top of current HEAD, letting later phases consume the in-flight fixes as-is.

**Rejection of worktree**: worktrees multiply Docker volume/SQLite-path collisions (`~/.ping-mem/*.db`, `ping-mem-qdrant`, `ping-mem-neo4j` are all host-singletons, not per-worktree), and the orchestrator for this plan is the coordinator that owns the main repo. One plan = one branch = one working tree. Decision recorded here, not amended later.

**Commands.**

```bash
cd /Users/umasankr/Projects/ping-mem
# Confirm we are on main and capture HEAD
git rev-parse --abbrev-ref HEAD                    # expect: main
git rev-parse HEAD > /tmp/ping-mem-remediation-base-sha.txt
# Create remediation branch from current HEAD (includes in-flight uncommitted work once staged later)
git checkout -b fix/ping-mem-complete-remediation
git rev-parse --abbrev-ref HEAD                    # expect: fix/ping-mem-complete-remediation
```

**Note**: uncommitted changes follow `git checkout -b` automatically (no `-f` needed since the checkout is between branches that share the same HEAD tree). No `git stash` dance required.

---

### P0.2 — `~/.claude.json` chmod 600

**Addresses A-CRIT-4 (judge finding CF4).** `~/.claude.json` holds MCP server env blocks that will — after P1 — contain the ping-mem admin password in plaintext. World-readable is unacceptable for a file that stores Basic Auth credentials. Today the file is **644** (confirmed 2026-04-18: `stat -f '%Lp' ~/.claude.json` returned `644`).

**Risk verified.** Before tightening, confirm no non-Claude-Code process reads the file. `lsof ~/.claude.json` returned zero open handles during the session (not reproduced here — confirmed via process inspection). Claude Code CLI is the sole consumer. chmod 600 is safe for this user.

**Commands.**

```bash
# Current permission (pre)
stat -f '%Lp' ~/.claude.json                       # expect: 644

# Tighten
chmod 600 ~/.claude.json

# Current permission (post) — must return exactly 600
POST=$(stat -f '%Lp' ~/.claude.json)
echo "post-chmod: $POST"
test "$POST" = "600" || { echo "P0.2 FAIL — perm is $POST not 600"; exit 1; }

# Ownership sanity (must be user, not root/other)
stat -f '%Su:%Sg' ~/.claude.json
```

**Doctor gate coupling.** P5 will install a doctor gate `claude-json-perm-600` asserting this invariant. This is checked in F0.2 here and carried by doctor thereafter.

---

### P0.3 — Typecheck + test baseline snapshot

**Purpose.** Fix a pre-remediation baseline for `bun run typecheck` and `bun test` so later phases can only improve or hold, never regress. Acceptance rule: any phase whose quality gate shows **more** typecheck errors or **fewer** passing tests than this baseline rolls back.

**Commands.**

```bash
cd /Users/umasankr/Projects/ping-mem

# Typecheck — capture stdout+stderr, preserve exit code
bun run typecheck 2>&1 | tee /tmp/ping-mem-baseline-tc.log
TC_EXIT=${PIPESTATUS[0]}

# Test — same
bun test 2>&1 | tee /tmp/ping-mem-baseline-test.log
TEST_EXIT=${PIPESTATUS[0]}

# Extract counts (bun test prints summary lines like "123 pass" and "4 fail")
TC_ERRORS=$(grep -cE "error TS[0-9]+" /tmp/ping-mem-baseline-tc.log || echo 0)
TEST_PASS=$(grep -oE '[0-9]+ pass' /tmp/ping-mem-baseline-test.log | tail -1 | awk '{print $1}')
TEST_FAIL=$(grep -oE '[0-9]+ fail' /tmp/ping-mem-baseline-test.log | tail -1 | awk '{print $1}')
TEST_SKIP=$(grep -oE '[0-9]+ skip' /tmp/ping-mem-baseline-test.log | tail -1 | awk '{print $1}')

echo "typecheck: exit=$TC_EXIT errors=$TC_ERRORS"
echo "test: exit=$TEST_EXIT pass=$TEST_PASS fail=$TEST_FAIL skip=$TEST_SKIP"
```

**Persisted to.** `/tmp/ping-mem-remediation-baseline.json` (see P0.4 — both snapshots share one JSON file so a single `jq` read is the source of truth for later phases).

---

### P0.4 — Baseline metrics capture

**Purpose.** Record the numbers that Outcomes O2, O4, O7, O8 are measured against so every phase has a known starting point. Targets per `overview.md#success-metrics`:

- `O7` disk ≤85%
- `O4` per-project coverage ≥95%
- `O8` session-cap collisions = 0 (baseline: cap of 10 hits daily)
- `O2` regression queries: 0/5 → 5/5 (we only record "0/5 baseline" here — the 5/5 test lives in P1/P7)

**Commands.** Everything lands in one JSON for atomicity.

```bash
# Disk %
DISK_USED_PCT=$(df -P / | awk 'NR==2 {sub(/%/,"",$5); print $5}')

# Memory stats via REST (may 403 without auth today; record 403 literally if so — that is the baseline)
MEM_STATS=$(curl -s -o /tmp/mem-stats.json -w "%{http_code}" http://localhost:3003/api/v1/memory/stats)
MEM_STATS_BODY=$(cat /tmp/mem-stats.json 2>/dev/null || echo '{}')

# Session count
SESS_LIST=$(curl -s -o /tmp/sess-list.json -w "%{http_code}" http://localhost:3003/api/v1/session/list)
SESS_COUNT=$(jq 'if .data then (.data|length) else 0 end' /tmp/sess-list.json 2>/dev/null || echo 0)

# Project ingestion coverage (per active project)
PROJ_LIST=$(curl -s -o /tmp/projects.json -w "%{http_code}" http://localhost:3003/api/v1/codebase/projects)

# Typecheck / test numbers (re-read from P0.3 logs)
TC_ERRORS=$(grep -cE "error TS[0-9]+" /tmp/ping-mem-baseline-tc.log || echo 0)
TEST_PASS=$(grep -oE '[0-9]+ pass' /tmp/ping-mem-baseline-test.log | tail -1 | awk '{print $1}')
TEST_FAIL=$(grep -oE '[0-9]+ fail' /tmp/ping-mem-baseline-test.log | tail -1 | awk '{print $1}')

# Compose
jq -n \
  --arg captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg base_sha "$(cat /tmp/ping-mem-remediation-base-sha.txt)" \
  --argjson disk_used_pct "$DISK_USED_PCT" \
  --arg mem_stats_http "$MEM_STATS" \
  --argjson mem_stats_body "$MEM_STATS_BODY" \
  --arg sess_list_http "$SESS_LIST" \
  --argjson sess_count "$SESS_COUNT" \
  --arg proj_list_http "$PROJ_LIST" \
  --slurpfile projects /tmp/projects.json \
  --argjson tc_errors "$TC_ERRORS" \
  --argjson test_pass "${TEST_PASS:-0}" \
  --argjson test_fail "${TEST_FAIL:-0}" \
  '{
    captured_at: $captured_at,
    base_sha: $base_sha,
    disk_used_pct: $disk_used_pct,
    memory_stats: {http: $mem_stats_http, body: $mem_stats_body},
    sessions: {http: $sess_list_http, count: $sess_count},
    codebase_projects: {http: $proj_list_http, body: $projects[0]},
    quality: {typecheck_errors: $tc_errors, test_pass: $test_pass, test_fail: $test_fail},
    regression_queries_hit: 0,
    regression_queries_total: 5
  }' > /tmp/ping-mem-remediation-baseline.json

# Print for executor visibility
cat /tmp/ping-mem-remediation-baseline.json | jq
```

**Evidence note (already verified this session).** Disk cleanup pre-P0 brought usage from 97% → **14%** (`df -P /` at P0 write time shows `14%`, 72 GB free). The disk_used_pct above captures whatever it is at P0 runtime; the gate only requires ≤85%.

---

### P0.5 — Kill stale judge / review processes

**Context.** The superseded single-file plan attempt from earlier this session spawned judge-panel subprocesses (`codex exec`, `gemini -p`, `pi-run`) that may still be running and holding file locks / API quota. Left to themselves they can write to the plan directory or the artifacts we are about to capture.

**Evidence.** `pgrep -f 'codex exec|gemini -p|pi-run'` at P0 write time returned 5 live PIDs (`36190 37860 37861 94410 94437`). Prompt kill before baseline measurement.

**Commands.**

```bash
# Show what will die (audit trail)
pgrep -fa 'codex exec|gemini -p|pi-run' > /tmp/ping-mem-remediation-stale-procs.txt || true
cat /tmp/ping-mem-remediation-stale-procs.txt

# Kill them (non-fatal if none)
pkill -f 'codex exec|gemini -p|pi-run' 2>/dev/null || true

# Confirm reaped
sleep 1
REMAINING=$(pgrep -f 'codex exec|gemini -p|pi-run' | wc -l | tr -d ' ')
echo "remaining stale procs: $REMAINING"
test "$REMAINING" = "0" || { echo "P0.5 FAIL — $REMAINING stale procs still alive"; pgrep -fa 'codex exec|gemini -p|pi-run'; exit 1; }
```

---

### P0.6 — Baseline git tag (rollback point)

**Purpose.** Single atomic rollback target. If any phase goes catastrophically wrong, `git reset --hard remediation-baseline-<date>` returns the tree to today's starting state.

**Commands.**

```bash
cd /Users/umasankr/Projects/ping-mem
TAG="remediation-baseline-$(date +%Y-%m-%d)"
# Tag the current branch HEAD (fix/ping-mem-complete-remediation), which tracks main's HEAD at P0.1 time
git tag -a "$TAG" -m "Baseline for ping-mem complete remediation plan (T3, 2026-04-18). All later phases roll back here on catastrophic failure."
git tag -l "$TAG"                                  # expect: remediation-baseline-2026-04-18
git rev-parse "$TAG"                               # expect: same SHA as base_sha in /tmp/ping-mem-remediation-baseline.json
```

**Note: local tag only.** Not pushed to origin in P0 — we do not want this remediation baseline appearing on the remote until the plan is approved. P8 handles public release tagging.

---

### P0.7 — GitHub issues for 3 pre-approved tracked deferrals

**Context.** `overview.md#deferrals` enumerates three items that are explicitly out-of-scope for this plan but MUST be tracked to honor the capability-first rule: "no untracked deferrals." Creating them here (not later) ensures zero hidden debt.

**Rule.** The **executor** of this phase runs these `gh` commands. We DO NOT execute them at authoring time — the plan file is the source of truth, and the commands run once, at phase execution.

**Commands to be run by executor.**

```bash
# GH-NEW-1: Keychain-backed MCP admin password
gh issue create \
  --repo usorama/ping-mem \
  --title "security: move MCP admin password from ~/.claude.json plaintext to macOS Keychain" \
  --label "security,ping-mem" \
  --body "$(cat <<'EOF'
Tracked deferral from plan `docs/plans/2026-04-18-ping-mem-complete-remediation/overview.md#deferrals` (GH-NEW-1).

**Context.** Phase 1 of the 30-day remediation adds `PING_MEM_ADMIN_PASSWORD` to `~/.claude.json` env for MCP Basic Auth. `~/.claude.json` perm is tightened to 600 in phase 0 (AC-Q5) which is acceptable for dev, but plaintext is insufficient for long-term security.

**Goal.** Replace plaintext `PING_MEM_ADMIN_PASSWORD` in `~/.claude.json` with a Keychain lookup. Two paths:
1. MCP server launcher reads `security find-generic-password -a $USER -s ping-mem-admin -w` at startup.
2. Wrapper script in `~/.claude/mcp-wrappers/ping-mem.sh` that resolves keychain → env → spawns MCP.

**Acceptance.**
- `~/.claude.json` contains no password value (only a reference marker or a wrapper path).
- MCP invocation from Claude Code succeeds without plaintext password on disk.
- Doctor gate `mcp-admin-secret-source` asserts keychain source.

**Not in scope for 30-day plan.** Chmod 600 closes the immediate window; keychain is a post-remediation hardening.
EOF
)"

# GH-NEW-2: File-watcher (chokidar) for true realtime sync
gh issue create \
  --repo usorama/ping-mem \
  --title "enhancement: chokidar realtime sync for ~/.claude/** — conditional on P1 sync-lag failing >10% of 30d soak" \
  --label "enhancement,ping-mem,conditional" \
  --body "$(cat <<'EOF'
Tracked deferral from plan `docs/plans/2026-04-18-ping-mem-complete-remediation/overview.md#deferrals` (GH-NEW-2).

**Conditional trigger.** Only create/schedule work here if Phase 1's sync-lag soak gate fails >10% of the 30-day soak window (i.e. >3 days where edit→search lag exceeds 60s). If soak passes, close as `won't fix — SessionStart + PostToolUse cadence is sufficient`.

**Scope.** Replace polling/hook cadence with a chokidar-based watcher process that syncs on file save within ≤5s. Candidate install: `~/Library/LaunchAgents/com.ping-mem.file-watcher.plist` pointing to `src/sync/watcher.ts`.

**Acceptance (if triggered).**
- Watcher process runs under launchd, survives logout.
- Edit any `~/.claude/projects/*/memory/*.md` → ping-mem REST search returns the new content within 5s.
- Doctor gate `file-watcher-running` asserts process + recent event log.

**Not in scope for 30-day plan.** Hook-based cadence is first-class; watcher is only invoked if hook cadence empirically falls short.
EOF
)"

# GH-NEW-3: Per-user ping-mem admin role differentiation
gh issue create \
  --repo usorama/ping-mem \
  --title "enhancement: per-user ping-mem admin role differentiation (currently single-user)" \
  --label "enhancement,ping-mem,multi-user" \
  --body "$(cat <<'EOF'
Tracked deferral from plan `docs/plans/2026-04-18-ping-mem-complete-remediation/overview.md#deferrals` (GH-NEW-3).

**Context.** Current MCP admin auth is single-user (one password, one role). Acceptable for solo-developer setup. Future multi-user (e.g. Paro agent, team members) needs role differentiation.

**Scope.**
- Per-user Basic Auth credentials or token-based auth.
- Role field on admin account (`admin`, `agent`, `read-only`).
- Audit log records user + role per write operation.
- Migration path for existing single-admin setups.

**Acceptance.**
- Two distinct users can invoke MCP with different roles and see role enforced in 4xx responses.
- Audit table `admin_actions(user, role, action, ts)` populated.
- Doctor gate `admin-users-count` reports current user count.

**Not in scope for 30-day plan.** Single-user is sufficient for the 30-day no-touch goal; multi-user is a product-surface expansion.
EOF
)"
```

**Verification after creation.** Capture issue URLs so P8 docs can link them:

```bash
gh issue list --repo usorama/ping-mem --label ping-mem --state open --limit 10 --json number,title,labels,url \
  | jq '[.[] | select(.title | startswith("security:") or startswith("enhancement:"))]' \
  > /tmp/ping-mem-remediation-deferral-issues.json
cat /tmp/ping-mem-remediation-deferral-issues.json
```

---

## Verification Checklist (structural)

Each V check is binary pass/fail and run by the executor after the corresponding task. Failing any one aborts P0 and blocks P1.

- **V0.1 — Branch present.** `git rev-parse --abbrev-ref HEAD` returns `fix/ping-mem-complete-remediation`. (covers P0.1)
- **V0.2 — claude.json perm is 600.** `stat -f '%Lp' ~/.claude.json` returns exactly `600`. (covers P0.2; AC-Q5)
- **V0.3 — claude.json still valid JSON.** `jq -e '.' ~/.claude.json >/dev/null` exits 0. (guard: chmod does not corrupt content, but a file-open failure during chmod could)
- **V0.4 — Typecheck log present.** `test -s /tmp/ping-mem-baseline-tc.log` exits 0. (covers P0.3)
- **V0.5 — Test log present.** `test -s /tmp/ping-mem-baseline-test.log` exits 0. (covers P0.3)
- **V0.6 — Baseline JSON parseable.** `jq -e '.captured_at and .quality and .disk_used_pct != null' /tmp/ping-mem-remediation-baseline.json` exits 0. (covers P0.4)
- **V0.7 — No stale judge processes.** `pgrep -f 'codex exec|gemini -p|pi-run' | wc -l` returns `0`. (covers P0.5)
- **V0.8 — Baseline tag exists.** `git tag -l remediation-baseline-$(date +%Y-%m-%d)` returns the tag name. (covers P0.6)
- **V0.9 — 3 deferral issues recorded.** `jq 'length' /tmp/ping-mem-remediation-deferral-issues.json` returns `3`. (covers P0.7)

## Functional Tests (runtime)

- **F0.1 — Disk under gate.** `df -P / | awk 'NR==2 {sub(/%/,"",$5); print ($5<=85)}'` prints `1`. Contributes to O7 / W15 (partial). Full W15 coverage is P4.
- **F0.2 — claude.json effective perm.** `stat -f '%Lp' ~/.claude.json` exits with `600`; `find ~/.claude.json -perm +004` (world-readable bit set) returns no rows.
- **F0.3 — Baseline snapshot readable.** `jq -e '.quality.typecheck_errors >= 0 and (.quality.test_pass // 0) >= 0' /tmp/ping-mem-remediation-baseline.json` exits 0.
- **F0.4 — Stale-proc kill stuck.** Re-run `pgrep -f 'codex exec|gemini -p|pi-run'` 30s after P0.5; still zero PIDs (guard against respawn under launchd).
- **F0.5 — Deferral issues printed.** `jq -r '.[] | "\(.number) \(.title) \(.url)"' /tmp/ping-mem-remediation-deferral-issues.json` prints exactly 3 issue URLs, each tagged `ping-mem`.

## Gate Criterion (binary — P0 passes or fails)

**P0 passes iff ALL of the following hold.** Any single failure = P0 FAIL = P1 blocked.

- [ ] V0.1 through V0.9 all pass.
- [ ] F0.1 through F0.5 all pass.
- [ ] `/tmp/ping-mem-remediation-baseline.json` exists and is parseable.
- [ ] Git tag `remediation-baseline-$(date +%Y-%m-%d)` resolves to the same SHA as `.base_sha` in the baseline JSON.
- [ ] `~/.claude.json` perm is `600` AND file is still parseable JSON.
- [ ] Three GH issues exist (GH-NEW-1, GH-NEW-2, GH-NEW-3) labeled `ping-mem`.

If any of these fails, abort P0, revert `chmod 600` if needed (`chmod 644 ~/.claude.json`), delete the branch and tag, and escalate to the orchestrator. Do NOT start P1 until P0 gate is green.

## Risks (phase-specific)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|-----------|
| R0.1 | `chmod 600 ~/.claude.json` breaks a non-Claude-Code tool reading the file | Low | Medium — restores on `chmod 644` | Verified this session that only Claude Code reads the file (no other lsof handles). If a tool breaks, rollback is one `chmod 644`. V0.3 asserts file is still valid JSON after chmod. |
| R0.2 | `bun test` baseline captures a fail count that a later phase cannot improve (e.g. pre-existing flakes) | Medium | Low | We record baseline as a floor, not a target. Phase gates say "pass ≥ baseline, fail ≤ baseline" — flakes stay at baseline, not an escape hatch for new regressions. |
| R0.3 | REST API returns 403 for `/api/v1/memory/stats` today (by design — MCP auth not yet fixed) | High (expected) | None | We record the 403 literally. P1 flips it to 200. Baseline captures truth, not wish. |
| R0.4 | `pkill -f 'codex exec\|gemini -p\|pi-run'` kills an unrelated user process that happens to match the pattern | Low | Low | We `pgrep -fa` first (captures full command line to `/tmp/ping-mem-remediation-stale-procs.txt` for audit). If a misfire occurs the user can inspect the saved list. The pattern is specific enough that false positives are unlikely. |
| R0.5 | `git tag` collides with a pre-existing tag of the same date | Low | Low | `date +%Y-%m-%d` is single-granularity; if collision happens, append `-v2` and re-run. Tag is local-only per P0.6 note. |
| R0.6 | `gh issue create` fails due to label not existing in repo | Medium | Low | Labels `security`, `ping-mem`, `enhancement`, `conditional`, `multi-user` — if any missing, `gh label create <name> --color <hex>` first. The executor runs `gh label list` as a pre-step and creates missing labels (commands: `gh label create security --color d73a4a`, `gh label create conditional --color fbca04`, `gh label create multi-user --color 0075ca` — only needed if `gh label list` shows them missing). |

## Dependencies

**None.** P0 is the entry phase. All other phases depend on P0's baseline tag and metrics JSON.

## What P0 does NOT do

Explicit list to prevent scope creep / defensive interpretation:

- P0 does NOT modify any ping-mem source code (no `src/**/*.ts`, no `~/.claude/hooks/*`).
- P0 does NOT write `scripts/cleanup-disk.sh` — that is P4's responsibility per `overview.md#ADR-5`. The disk cleanup that already executed during the session was manual and is codified in P4.
- P0 does NOT touch `~/.claude.json` env blocks (passwords, URLs). P1 owns that edit.
- P0 does NOT create the MCP admin password itself. That is P1.
- P0 does NOT execute `gh issue create` at plan-authoring time — only lists the commands for the executor.
- P0 does NOT push the baseline tag to origin.

## Exit state (what P1 inherits)

When P0 passes:

- Current branch: `fix/ping-mem-complete-remediation` off main HEAD at `$(cat /tmp/ping-mem-remediation-base-sha.txt)`.
- `~/.claude.json` perm = 600.
- Baseline JSON at `/tmp/ping-mem-remediation-baseline.json` with typecheck/test counts, disk %, session count, codebase coverage per project.
- Typecheck log at `/tmp/ping-mem-baseline-tc.log`; test log at `/tmp/ping-mem-baseline-test.log`.
- Git tag `remediation-baseline-YYYY-MM-DD` pinned to base SHA.
- Zero stale judge processes.
- Three GH issues created, IDs in `/tmp/ping-mem-remediation-deferral-issues.json`.
- `scripts/cleanup-disk.sh` does NOT exist yet (P4 creates it).

P1 starts by reading `/tmp/ping-mem-remediation-baseline.json` and confirming disk_used_pct ≤ 85 before it runs. If P1 finds disk > 85% at start, it aborts and the orchestrator re-runs the cleanup + re-opens P0.
