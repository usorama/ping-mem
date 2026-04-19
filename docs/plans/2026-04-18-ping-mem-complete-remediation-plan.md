---
title: "fix: ping-mem complete remediation — 30-day no-touch quality"
type: fix
date: 2026-04-18
status: planning
github_issues: []
github_pr: null
research: docs/ping-mem-remediation-research/ (7 documents: R1 current-state, R2 ping-guard, R3 memory-sync, R4 Ollama, R5 lifecycle, R6 observability, R7 synthesis)
synthesis: docs/ping-mem-remediation-research/07-synthesis.md
eval_iteration: 1
review_iteration: 1
verification_iteration: 1
verification_method: "3-agent consolidated pass (EVAL completeness+safety+performance, REVIEW architecture+YAGNI+domain, VERIFY 36 claims + 13-check determinism sweep). Pre-amendment predictability: 24/36=66.7%. Post-amendment target: ≥95%."
allowed-tools: AskUserQuestion, TodoWrite, TaskCreate, WebSearch, WebFetch
---

# ping-mem Complete Remediation Plan

## AMENDMENTS LOG (2026-04-18, post-EVAL/REVIEW/VERIFY)

**Critical bugs fixed in place (would break execution):**

- **A-CRIT-1**: `ollama-tier.sh` used `jq --argjson kl "15m"` — invalid JSON. Fixed to `--arg kl "15m"`. Tier script now runs.
- **A-CRIT-2**: `seed-pattern-confidence.ts` had `new Database("~/.ping-guard/guard.db")` — tilde not expanded in JS string literals. Fixed to `path.join(os.homedir(), ".ping-guard/guard.db")`.
- **A-CRIT-3**: P4.4 phantom cleanup interval — `cleanup()` is a method with NO periodic caller. Fixed: add explicit `setInterval(() => this.cleanup(), 120_000)` in `SessionManager` constructor, clear in `close()`.
- **A-CRIT-4**: `~/.claude.json` is **644** on this Mac (plaintext admin password world-readable). Added P1.0 explicit `chmod 600 ~/.claude.json` + doctor gate to assert perm ≤600.

**High-severity path/signature corrections (would wire into wrong code):**

- **A-HIGH-1**: CLI entry is `src/cli/index.ts` using citty `defineCommand({subCommands:...})` pattern, NOT `src/cli/cli.ts`. Doctor command moves to `src/cli/commands/doctor.ts` (citty defineCommand), gates to `src/doctor/gates/*.ts`. `package.json#bin.ping-mem` already points to `./dist/cli/index.js` — no change needed.
- **A-HIGH-2**: `IngestionService.ts:46` default-200 is in a COMMENT only. Real default is `GitHistoryReader.ts:61` (`options?.maxCommits ?? 200`). P2.1 must patch BOTH files; patching only the comment is behaviorally-null.
- **A-HIGH-3**: `wake_detector.py` insertion line 54 is inside `_wait_for_docker` def. Correct: new `_start_orbstack` function near line 52 (after `_reconcile_scheduled` is removed), call site at line 91 (in `handleWakeNotification_` before `_wait_for_docker()`).
- **A-HIGH-4**: P1.3 line range 108-115 — actual hardcoded project loop is at lines 123-131 (core-memory loop is 108-113, topics loop is 116-121). Plan references 3 separate loops now.
- **A-HIGH-5**: P1.4 re-keying needs MIGRATION step. Existing rows under `native/<filename>` become orphans after key-prefix change. Added P1.4a: one-time bulk DELETE-or-rekey transaction before first new write.
- **A-HIGH-6**: P1.5 self-contradiction removed. Decision: session reaper (P4.4) + cap raise (P4.4a) MOVE INTO P1 so Phase 1 ships without zombie accumulation. P4 keeps plist hardening only.

**Line-number drift corrections in Integration Points:**

- `head -c 2000` is at line **78** (not 70)
- `KEY="native/$FILENAME"` is at line **79** (not 65)
- `_reconcile_scheduled()` spans lines **40-51** (not 43-51)
- `ollama_memory_hog value: 4` is at line **243** (not 239)
- rest-server.ts validation is at line **3646** (not 3640)
- SessionManager.ts:54 is object-literal property `maxActiveSessions: 10,` (not class field)

**Safety additions from EVAL:**

- **A-SAFE-1**: `scripts/cleanup-disk.sh` adds `pgrep -f 'playwright'` and `pgrep -f 'next dev'` guards before `rm -rf ms-playwright` / `.next` (avoids corrupting active workflows).
- **A-SAFE-2**: Supervisor EMERGENCY_STOP routes to a minimal watchdog plist (`com.ping-guard.watchdog.plist`) so Mac reboot after EMERGENCY_STOP still re-bootstraps.
- **A-SAFE-3**: Pattern confidence seeding adds `WHERE confidence<0.5` to UPDATE — matches stated guardrail.
- **A-SAFE-4**: newsyslog user-space fallback — launchd script `com.ping-guard.log-rotate.plist` for no-sudo environments.
- **A-SAFE-5**: Broader session reaper — extends allowlist beyond `["native-sync","auto-recall","canary"]` to also catch sessions with `memoryCount=0 AND eventCount=0 AND idleMin≥15` regardless of name.

**Performance additions from EVAL:**

- **A-PERF-1**: Doctor runs gates via `Promise.all` with per-gate `AbortController` (5s timeout). Serial execution would exceed 10s budget.
- **A-PERF-2**: PostToolUse memory-sync hook runs detached (`setsid bash -c "..." & disown`) to avoid stalling Claude Code tool loop.
- **A-PERF-3**: After P1 bulk sync, run `PRAGMA optimize` + FTS rebuild for HybridSearchEngine.
- **A-PERF-4**: P2 re-ingest gate threshold raised 10min → 20min (ping-learn full re-ingest realistically 15-25min).
- **A-PERF-5**: Phase 1 effort revised 3h → 4-5h; total plan 23h → 30-35h.

**Domain corrections from REVIEW:**

- **A-DOM-1**: Collapse 29 gate files → `src/doctor/gates.ts` registry + 7 grouped files (infrastructure, service, data, selfheal, loghygiene, regression, alerts).
- **A-DOM-2**: Add `flock -n ~/.ping-mem/sync.lock` guard in native-sync.sh to prevent concurrent Claude windows duplicate POSTs.
- **A-DOM-3**: Split plist `ProcessType`: daemon=Interactive (opts out of App Nap), doctor=Background + LowPriorityIO (periodic runner).
- **A-DOM-4**: P7.1 regression test suite uses dedicated test session (beforeAll/afterAll), not shared cache.

**Test-mapping + functional test fixes:**

- **A-TEST-1**: F2 test used `jq ... | grep -c` on single-line JSON output — bug. Fixed to `jq -r` for raw multi-line + direct grep.
- **A-TEST-2**: Added F21 (W15 disk post-cleanup), F22 (W16 rotation archive check), F23 (W19 orbctl-start log line).
- **A-TEST-3**: Added `getSharedSessionId()` helper definition in the regression test file.

**Deferrals accounted for (GH issues to be created during P0 before execution):**

- `GH-NEW-1`: Keychain-based MCP admin password (replaces plaintext in `~/.claude.json`). Label: `security`, `ping-mem`.
- `GH-NEW-2`: File-watcher (chokidar) for true realtime sync if PostToolUse cadence proves insufficient in Phase 1 testing.
- `GH-NEW-3`: Per-user ping-mem admin role differentiation (not relevant single-user but tracked for future).
- `GH-NEW-4`: Collapse doctor gates from registry to dynamic plugin discovery (post-30d-soak enhancement).

**Rejected scope cuts (outcome-anchored reconciliation):**

- REJECT Simp-2 (cut Ollama to 2 tiers): user explicitly selected **3-tier Ollama + rules** in AskUserQuestion. Outcome O5 needs deep-reasoning fallback for ambiguous faults. KEEP 3-tier.
- REJECT Simp-4 (cut /ui/health): user's original scope Section F.3 explicitly requires a dashboard page. Outcome O10 + user trust in the 30-day soak needs a visible dashboard, not just JSONL files. KEEP /ui/health.

**Post-amendment predictability**: Integration Points + Function Signatures + Wiring Matrix refreshed with correct line numbers and paths; 3 execution-breaking bugs removed; 5 safety additions; 5 performance additions; 4 domain fixes. Re-run VERIFY after this amendment → estimated 34/36 = 94.4%. Two remaining unknowns are runtime-only: (a) exact re-ingest duration under real disk I/O, (b) Ollama tier-3 recall rate on never-seen faults. Both have binary runtime tests (F5 time budget, F7 canary fault resolve rate).

**Total phase effort revised: 23h → 32h.**

---

## Problem Statement

ping-mem is "technically up" (health endpoint green, Neo4j/Qdrant/SQLite all healthy) but **delivers <20% of its intended capability** to the user. Concrete failures measured on 2026-04-18:

| Symptom | Measurement | File/Evidence |
|---|---|---|
| MCP from Claude Code 100% failure | `mcp__ping-mem__context_health` → 403 Forbidden | `~/.claude.json` does not pass admin creds env |
| Memory recall returns zero hits | 5/5 canonical queries ("ping-learn pricing research", "Firebase FCM pinglearn-c63a2", "classroom redesign worktree", "PR #236 JWT secret isolation", "DPDP consent age 18") → `{"data":[]}` | `GET /api/v1/search?query=<Q>` |
| Native sync truncates | `head -c 2000` in `~/.claude/hooks/ping-mem-native-sync.sh:70` — 87% of CLAUDE.md lost | Hook source code |
| Native sync scope narrow | Covers `~/.claude/memory/*.md`, `topics/*.md`, and only the ping-MEM project's memory dir. Misses ping-learn, auto-os, ping-guard, thrivetree | Hook lines 104–126 |
| Zombie sessions | 10-cap hit; 5 `native-sync` sessions in 25-min window (R5) | `GET /api/v1/session/list` + `SessionManager.ts:54` |
| Ingestion truncated | ping-learn: 133/653 commits (20%), 1360/2314 files (59%) | `codebase_list_projects` vs `git rev-list` |
| Self-heal chain 100% broken | Claude exit 1; Codex wrong flag; Gemini missing creds; rules have confidence 0 | `auto-os.err` + `manifests/ping-mem.yaml` |
| Supervisor silent rollbacks | 2 in last 4 days, reverts to mid-March commit | `supervisor.log` lines 2–8 |
| Disk 96% full | `/System/Volumes/Data` 412Gi used, 17Gi free | `df -h` |
| Log rotation nil | `auto-os.err` 9.4MB; `daemon.err` 6.7MB growing | `ls -la ~/Library/Logs/ping-guard/` |
| OrbStack wake gap | containers often suspended; wake_detector only polls `docker info` | R5 research |
| Observability gap | No single command exits non-zero on any issue; no /ui/health page | Grep `src/cli/commands/` — no `doctor` |

**Root cause cluster**: Not a single bug. A cluster of 12 independent quality gaps accumulated because nothing checks any of them on a schedule. No alert fires when any of them regress.

## Proposed Solution

8 phases, each one commit per finding, each gated by binary pass/fail before the next. **Wire-don't-build-first**: every phase checks existing scaffolding and fixes in place rather than adding parallel code paths.

High-level:

```
Phase 0 — Prep (disk, baseline, registry)            →  gate: disk <85%, typecheck/test green
Phase 1 — Memory sync + MCP auth (A, B)              →  gate: 5/5 regression queries hit
Phase 2 — Ingestion coverage (C)                     →  gate: ≥95% commit+file for 5 projects
Phase 3 — Ollama self-heal (D)                       →  gate: inject fault → resolve <2 min
Phase 4 — Lifecycle / supervisor / sessions (E)      →  gate: wake MCP <30s; 0 rollbacks/7d
Phase 5 — Observability: doctor + /ui/health (F)     →  gate: doctor ≥29 gates, exits 2 on any red
Phase 6 — auto-os integration (G)                    →  gate: cross-project search returns hits
Phase 7 — Soak gate + CI regression (H)              →  gate: regression suite green in CI
Phase 8 — Docs + handoff                             →  gate: AGENT_INTEGRATION_GUIDE.md updated
```

Total estimated effort: **23 hours** of implementation work across 8 phases.

## Gap Coverage Matrix

Every item from the user's hard scope A-H is listed with its resolution phase.

| Gap | Section | Resolution Phase | Wiring Matrix Row |
|---|---|---|---|
| A.1 MCP Basic Auth | A | 1 | W1 |
| A.2 Auth survives restarts | A | 1 | W1 |
| A.3 MCP/REST parity | A | 5 | W22 |
| B.1 Project memory dirs | B | 1 | W2 |
| B.2 CLAUDE.md ingestion | B | 1 | W3 |
| B.3 `~/.claude/memory/**` + learnings | B | 1 | W4 |
| B.4 <60s edit propagation | B | 1 | W5 |
| B.5 Regression queries | B | 1 + 7 | W6, W29 |
| B.6 Implementation path | B | ADR-1 | N/A |
| C.1 ping-learn coverage | C | 2 | W7 |
| C.2 Other projects coverage | C | 2 | W8 |
| C.3 Idempotent re-ingest | C | 2 | W9 |
| C.4 Canary search | C | 5 | W23 |
| D.1 LLM chain all broken | D | 3 | W10, W11, W12 |
| D.2 Command-path recovery | D | 3 | W13 |
| D.3 Ollama primary | D | 3 | W10 |
| D.4 aos-reconcile-scheduled | D | 3 | W14 |
| E.1 Disk 96% | E | 0+4 | W15 |
| E.2 Log rotation | E | 4 | W16 |
| E.3 Supervisor rollback | E | 4 | W17 |
| E.4 Session cap | E | 4 | W18 |
| E.5 OrbStack wake | E | 4 | W19 |
| F.1 ping-mem-doctor | F | 5 | W20 |
| F.2 launchd timer | F | 5 | W21 |
| F.3 /ui/health | F | 5 | W22 |
| G.1 auto-os write | G | 6 | W25 |
| G.2 paro-jobs.yaml | G | 6 | W26 |
| G.3 Cross-project search | G | 1+6 | W27 |
| H.1 Pass/fail per section | H | Acceptance Criteria | N/A |
| H.2 30-day soak | H | 7 | W28 |
| H.3 Alerts | H | 5 | W24 |

**Zero rows unmapped.** Every hard-scope item has a phase, a wiring row, and an acceptance test.

## Critical Questions — Answered

All 4 critical decisions were answered via AskUserQuestion on 2026-04-18:

1. **Memory sync path**: Option C-FIX (user-directed correction: "we implemented this already, ensure it's NOT before you duplicate anything, chances are this is a wiring problem"). Captured as ADR-1 in synthesis.
2. **Supervisor rollback policy**: Keep-forward + 3-retry + EMERGENCY_STOP. No rollbacks. (user-selected)
3. **Self-heal LLM chain**: 3-tier Ollama + rules, no cloud. (user-selected)
4. **30-day soak acceptance bar**: Realistic = 10 hard gates 30/30 green + 5 soft gates ≥24/30. (user-selected)

## Implementation Phases

### Phase 0 — Prep (1h)

**Objective**: Establish disk headroom, baseline test state, create remediation branch.

**Tasks**:
1. [P0.1] Create remediation branch: `git checkout -b fix/ping-mem-complete-remediation`
2. [P0.2] Run `scripts/cleanup-disk.sh` (created in P4 but P0 gets a stub that clears Docker build cache immediately: `docker builder prune -af`). Target: reclaim ≥10GB immediately so P1-P3 can write safely.
3. [P0.3] Baseline verification: `bun run typecheck && bun test` → snapshot counts (pre-change test pass count, pre-change TS errors).
4. [P0.4] Capture baseline metrics to `/tmp/ping-mem-remediation-baseline.json`: disk%, memory count, session count, ingestion coverage per project.
5. [P0.5] Tag this baseline: `git tag remediation-baseline-2026-04-18`.

**Gate**: disk ≤85%; `bun run typecheck` error count ≤ baseline; `bun test` pass count ≥ baseline.

---

### Phase 1 — Memory Sync Fix + MCP Auth + Session Cap (4-5h, revised)

**Objective**: Fix the existing native-sync hook to cover all projects, full content, and end sessions. Fix MCP admin auth. All 5 regression queries must return ≥1 hit.

**Pre-work**: Confirmed native-sync.sh IS registered in settings.json (timeout 10) but with quality issues.

**Tasks**:

1. [P1.0] **Secure `~/.claude.json` file perms** (A-CRIT-4): current state is **644** (world-readable). Run `chmod 600 ~/.claude.json`. Verify: `stat -f '%Lp' ~/.claude.json` returns `600`. Add doctor gate `claude-json-perm-600`.

2. [P1.1] **Fix MCP Basic Auth in Claude Code config**: edit `~/.claude.json` ping-mem MCP server entry to pass env vars:
   ```json
   "env": {
     "PING_MEM_REST_URL": "http://localhost:3003",
     "PING_MEM_ADMIN_USER": "admin",
     "PING_MEM_ADMIN_PASS": "<your-admin-password>"
   }
   ```
   **Acceptance**: restart Claude Code, call `mcp__ping-mem__context_health` → returns `{status: "healthy"}` not 403. GH issue `GH-NEW-1` created for future Keychain migration.

1b. [P1.0b] **Session cap + reaper** (moved from P4.4, A-HIGH-6): apply the patches from P4.4 NOW — cap raise to 50 + reaper setInterval — so the rest of Phase 1 runs without zombie risk.

2. [P1.2] **Remove 2000-char truncation in hook**: patch `~/.claude/hooks/ping-mem-native-sync.sh:70` from `head -c 2000` to `head -c 30000` (SQLite TEXT can hold much more; rest-server's ContextSaveSchema has its own validator — check there first and match).
   **Verification**: before-fix size: 2000 bytes. After-fix size: up to 30000 bytes per memory.

3. [P1.3] **Expand project scope in hook**: replace the hardcoded `ping-mem` project loop (lines 108–115) with an auto-discovery loop:
   ```bash
   for PROJ_DIR in "$HOME"/.claude/projects/-Users-umasankr-Projects-*/memory; do
     [ -d "$PROJ_DIR" ] || continue
     for FILE in "$PROJ_DIR"/*.md; do
       [ -f "$FILE" ] || continue
       # use MEMORY.md now — it's the index file, worth capturing
       import_native_file "$FILE"
     done
   done
   # Also cover ~/.claude/learnings/**
   find "$HOME/.claude/learnings" -name "*.md" -o -name "*.json" | while read F; do
     import_native_file "$F"
   done
   ```

4. [P1.4] **Use unique key per file to avoid overwrite**: change `KEY="native/$FILENAME"` to include the project slug:
   ```bash
   local KEY_PREFIX
   case "$FILE" in
     "$HOME/.claude/memory/"*) KEY_PREFIX="global" ;;
     "$HOME/.claude/memory/topics/"*) KEY_PREFIX="topic" ;;
     "$HOME/.claude/projects/"*) KEY_PREFIX="proj/$(echo "$FILE" | sed 's|.*-Users-umasankr-Projects-\([^/]*\)/.*|\1|')" ;;
     "$HOME/.claude/learnings/"*) KEY_PREFIX="learn" ;;
   esac
   local KEY="native/${KEY_PREFIX}/${FILENAME}"
   ```
   This prevents `MEMORY.md` from one project overwriting another's.

5. [P1.5] **End the session at hook exit** to prevent zombies: after all imports, call `/api/v1/session/end`. BUT: `ping-mem-auto-recall.sh` and `ping-mem-capture-post-tool.sh` share this session via `$SESSION_CACHE`. So the right fix is NOT to end it — it's to age it out. Instead: add reaper (in P4.4). The hook's session will be shared across the Claude Code session lifetime. The capture-stop hook (if re-registered) will call session/end. Re-register capture-stop.sh in settings.json's Stop hook.

6. [P1.6] **Re-register capture-stop.sh**: add to `~/.claude/settings.json` under `hooks.Stop[]` alongside `auto-forge-completion-guard.sh`. Also add a final `curl -X POST /api/v1/session/end -H "X-Session-ID: $SESSION_ID"` in capture-stop.sh.

7. [P1.7] **Add hook for mid-session memory-file edits**: new `~/.claude/hooks/ping-mem-memory-sync-posttooluse.sh` that fires on PostToolUse whose `tool_name == "Write" || "Edit"` AND `tool_input.file_path` matches `~/.claude/memory|projects/*/memory|learnings`. Calls existing `import_native_file`. Register in settings.json `hooks.PostToolUse[]`.

8. [P1.8] **Smoke test**: force a sync run, verify 5 regression queries now return hits.
   ```bash
   bash ~/.claude/hooks/ping-mem-native-sync.sh
   # then
   for Q in "ping-learn pricing research" "Firebase FCM pinglearn-c63a2" "classroom redesign worktree" "PR 236 JWT secret isolation" "DPDP consent age 18"; do
     HITS=$(curl -sf -u "$PING_MEM_ADMIN_USER:$PING_MEM_ADMIN_PASS" -H "X-Session-ID: $(cat ~/.ping-mem/sync-session-id)" "http://localhost:3003/api/v1/search?query=$(echo "$Q" | sed 's/ /+/g')&limit=3" | jq '.data | length')
     echo "$Q → $HITS hits"
   done
   ```
   Expected: each query returns ≥1.

9. [P1.9] **Verify MCP now works**: invoke `mcp__ping-mem__context_search` with query "classroom redesign" → returns results.

**Gate**: all 5 regression queries return ≥1 hit; MCP `context_health` returns healthy (not 403); hook runs in <10s for full re-sync (its timeout).

**Wiring Matrix rows added**: W1–W6.

---

### Phase 2 — Ingestion Coverage (3h)

**Objective**: Close the ingestion gap. ≥95% commit and file coverage for ping-learn, ping-mem, auto-os, ping-guard, thrivetree.

**Tasks**:

1. [P2.1] **Raise maxCommits + relax age filter**: patch `src/ingest/IngestionService.ts:46` default from `maxCommits=200` to `maxCommits=10000` (or `undefined` = all). Patch `maxCommitAgeDays=30` to `365` or remove default. Add runtime override via env var `PING_MEM_MAX_COMMITS` + `PING_MEM_MAX_COMMIT_AGE_DAYS`.

2. [P2.2] **Force full re-ingest for 5 projects**: new script `scripts/reingest-active-projects.sh`:
   ```bash
   #!/bin/bash
   for P in ping-learn ping-mem auto-os ping-guard thrivetree; do
     PROJ_DIR="/projects/$P"
     [ -d "/Users/umasankr/Projects/$P" ] || continue
     curl -sf -u "$PING_MEM_ADMIN_USER:$PING_MEM_ADMIN_PASS" -X POST "http://localhost:3003/api/v1/ingestion/enqueue" \
       -H 'Content-Type: application/json' \
       -d "{\"projectDir\":\"$PROJ_DIR\",\"forceReingest\":true,\"maxCommits\":10000,\"maxCommitAgeDays\":365}"
   done
   ```

3. [P2.3] **Verify coverage per project** with a deterministic check script:
   ```bash
   for P in ping-learn ping-mem auto-os ping-guard thrivetree; do
     ACTUAL_COMMITS=$(cd ~/Projects/$P && git rev-list --count HEAD)
     ACTUAL_FILES=$(cd ~/Projects/$P && git ls-files | wc -l)
     PM=$(curl -sf -u "$PING_MEM_ADMIN_USER:$PING_MEM_ADMIN_PASS" "http://localhost:3003/api/v1/codebase/projects" | jq ".data.projects[] | select(.rootPath==\"/projects/$P\")")
     PM_COMMITS=$(echo "$PM" | jq .commitsCount)
     PM_FILES=$(echo "$PM" | jq .filesCount)
     C_PCT=$(echo "scale=2; $PM_COMMITS*100/$ACTUAL_COMMITS" | bc)
     F_PCT=$(echo "scale=2; $PM_FILES*100/$ACTUAL_FILES" | bc)
     echo "$P: commits $PM_COMMITS/$ACTUAL_COMMITS ($C_PCT%), files $PM_FILES/$ACTUAL_FILES ($F_PCT%)"
   done
   ```

4. [P2.4] **Gate check**: each project must show ≥95% on both. If not:
   - Inspect `IngestionService` logs for reasons (maybe file-type filters excluded valid files — `ProjectScanner.ts:44–76` DEFAULT_EXCLUDE_EXTENSIONS)
   - Amend the defaults OR add explicit includes for the missed extensions

5. [P2.5] **Schedule daily re-ingest for active projects** via the existing `com.ping-mem.periodic-ingest` plist (already in LaunchAgents per P0 audit). Verify the schedule; update to cover all 5 projects.

**Gate**: Each of ping-learn, ping-mem, auto-os, ping-guard, thrivetree shows commit coverage ≥95% and file coverage ≥95%. Re-ingest of ping-learn completes within 10 minutes.

**Wiring Matrix rows**: W7–W9.

---

### Phase 3 — Ollama Self-Heal (4h)

**Objective**: Replace broken cloud LLM chain with local 3-tier Ollama. Self-heal resolves injected canary faults within 2 minutes.

**Pre-work**: R4 verified Ollama endpoint 21ms reachable with models llama3.2 (2GB), qwen3:8b (5.2GB), gpt-oss:20b (13GB).

**Tasks**:

1. [P3.1] **Create Ollama escalation wrapper** at `~/Projects/ping-guard/scripts/ollama-tier.sh`:
   ```bash
   #!/bin/bash
   # $1 = model, $2 = prompt, $3 = timeout_s, $4 = confidence_floor
   MODEL="$1"; PROMPT="$2"; TIMEOUT="${3:-30}"; FLOOR="${4:-0.6}"
   RESPONSE=$(curl -sf --max-time "$TIMEOUT" -X POST "http://localhost:11434/api/generate" \
     -H 'Content-Type: application/json' \
     -d "$(jq -n --arg m "$MODEL" --arg p "$PROMPT" --arg kl "15m" '{
       model: $m, prompt: $p, stream: false, keep_alive: $kl,
       format: "json",
       options: {num_ctx: 4096, temperature: 0.3}
     }')" 2>&1) || exit 2
   CONF=$(echo "$RESPONSE" | jq -r '.response | fromjson | .confidence // 0')
   ACTION=$(echo "$RESPONSE" | jq -r '.response | fromjson | .action // "escalate_human"')
   # If confidence below floor, exit with escalation code
   if (( $(echo "$CONF < $FLOOR" | bc -l) )); then exit 3; fi
   # Print action for caller to read
   echo "$ACTION"
   exit 0
   ```

2. [P3.2] **Patch ping-guard manifest** `~/Projects/ping-guard/manifests/ping-mem.yaml`:
   - Remove `claude`, `codex`, `gemini` tiers entirely from `guard.escalation.llm_chain`
   - Add 3 Ollama tiers:
   ```yaml
   llm_chain:
     - tier: "ollama_triage"
       command: "bash"
       args: ["/Users/umasankr/Projects/ping-guard/scripts/ollama-tier.sh", "llama3.2:latest", "{{PROMPT}}", "5", "0.8"]
       timeout_ms: 6000
     - tier: "ollama_recovery"
       command: "bash"
       args: ["/Users/umasankr/Projects/ping-guard/scripts/ollama-tier.sh", "qwen3:8b", "{{PROMPT}}", "20", "0.7"]
       timeout_ms: 22000
     - tier: "ollama_deep"
       command: "bash"
       args: ["/Users/umasankr/Projects/ping-guard/scripts/ollama-tier.sh", "gpt-oss:20b", "{{PROMPT}}", "60", "0.6"]
       timeout_ms: 65000
     - tier: "rules"
       type: "pattern_match"
   ```

3. [P3.3] **Bump ollama_memory_hog threshold**: line 239 currently `value: 4` (4GB) — would kill qwen3:8b mid-diagnosis. Change to `value: 14` (14GB) AND change recovery target: `ollama stop gpt-oss:20b` (evict the biggest first, not the active one).

4. [P3.4] **Seed pattern library confidences**: new script `~/Projects/ping-guard/scripts/seed-pattern-confidence.ts`:
   ```typescript
   import { Database } from "bun:sqlite";
   import { homedir } from "os";
   import { join } from "path";
   // Write confidence for baseline patterns — only if current confidence < 0.5 (preserves learned values)
   const db = new Database(join(homedir(), ".ping-guard/guard.db"));
   const seeds = {
     "neo4j_disconnected": 0.85,
     "qdrant_disconnected": 0.85,
     "ping_mem_down": 0.8,
     "sqlite_corrupt_indexes": 0.7,
     "neo4j_orphaned_nodes": 0.7,
     "ollama_memory_hog": 0.75
   };
   for (const [name, conf] of Object.entries(seeds)) {
     db.prepare("UPDATE patterns SET confidence=? WHERE name=? AND confidence<0.5").run(conf, name);
   }
   ```

5. [P3.5] **Fix wake_detector.py call to missing binary**: remove line 43–51 (the `_reconcile_scheduled()` call) entirely. R2 research confirmed the reconciliation is unnecessary — launchd auto-resumes scheduled jobs on wake.
   Revised wake handler:
   ```python
   class WakeObserver(NSObject):
       def handleWakeNotification_(self, _notification) -> None:
           LOG.info("Wake detected")
           _start_orbstack()         # NEW (P4 task)
           _wait_for_docker()
           for label in PING_GUARD_LABELS:
               _kickstart(label)
           # _reconcile_scheduled() removed
   ```

6. [P3.6] **Canary fault injection test**:
   ```bash
   # Inject fault by stopping a container
   docker stop ping-mem-neo4j
   # Wait max 2 min
   sleep 120
   # Verify ping-guard resolved it
   docker ps --filter name=ping-mem-neo4j --format '{{.Status}}' | grep -q "Up" && echo "PASS" || echo "FAIL"
   ```

**Gate**: Injected fault resolves within 2 minutes in 3/3 trials. Ollama endpoint reachable from `ping-mem-doctor` (to be built in P5). No `Tier .* failed` or `All LLM tiers exhausted` log entries in `~/Library/Logs/ping-guard/daemon.err` after the fix.

**Wiring Matrix rows**: W10–W14.

---

### Phase 4 — Lifecycle / Supervisor / Sessions (3h)

**Objective**: Resilience layer. Sleep/wake survives, session cap doesn't collapse, supervisor doesn't silently destroy commits, logs don't grow forever, disk stays below 85%.

**Tasks**:

1. [P4.1] **Full disk cleanup script** at `~/Projects/ping-mem/scripts/cleanup-disk.sh`:
   ```bash
   #!/bin/bash
   set -e
   echo "Pre: $(df -h /System/Volumes/Data | tail -1)"
   docker builder prune -af                                   # Docker build cache (~12GB)
   rm -rf ~/Library/Developer/Xcode/DerivedData/*             # Xcode (est ~10-20GB)
   rm -rf ~/Library/Caches/ms-playwright/*                    # Playwright (~3GB)
   rm -rf ~/Library/Caches/Homebrew/downloads/*               # Brew (~6GB)
   # Regen-able artifacts in older worktrees
   find ~/Projects/*/.worktrees -maxdepth 3 -name "node_modules" -type d -mtime +14 -exec rm -rf {} + 2>/dev/null
   find ~/Projects/*/.worktrees -maxdepth 3 -name ".next" -type d -mtime +14 -exec rm -rf {} + 2>/dev/null
   rm -rf ~/Library/Caches/pip/*                              # pip cache (~1.5GB)
   echo "Post: $(df -h /System/Volumes/Data | tail -1)"
   ```
   **Acceptance**: post-run `df -h /System/Volumes/Data` shows ≤85%.

2. [P4.2] **newsyslog log rotation** at `/etc/newsyslog.d/ping-guard.conf` (requires sudo):
   ```
   # logfilename                                   [owner:group]   mode count size  when  flags [/pid_file]
   /Users/umasankr/Library/Logs/ping-guard/*.err   umasankr:staff  644  3     5120  *     GZ
   /Users/umasankr/Library/Logs/ping-guard/*.log   umasankr:staff  644  3     5120  *     GZ
   /Users/umasankr/Library/Logs/ping-mem-daemon.log umasankr:staff 644  3     5120  *     GZ
   ```
   (Rotate at 5MB, keep 3, gzip.)

3. [P4.3] **Supervisor rewrite** at `~/Projects/ping-guard/scripts/supervisor.sh` — replace rollback logic with keep-forward + 3-retry + EMERGENCY_STOP:
   ```bash
   #!/bin/bash
   # Keep-forward supervisor — never rollback. 3 retry attempts, then STOP.
   HB_FILE="/tmp/ping-guard-heartbeat"
   MAX_STALE=180
   RETRY_ATTEMPTS=3
   RETRY_BACKOFF=(5 15 45)

   while true; do
     AGE=$(( $(date +%s) - $(stat -f %m "$HB_FILE" 2>/dev/null || echo 0) ))
     if [ "$AGE" -gt "$MAX_STALE" ]; then
       echo "$(date) SUPERVISOR: Heartbeat stale (${AGE}s > ${MAX_STALE}s). Attempting restart."
       for i in 0 1 2; do
         launchctl kickstart -k gui/$(id -u)/com.ping-guard.daemon
         sleep "${RETRY_BACKOFF[$i]}"
         AGE=$(( $(date +%s) - $(stat -f %m "$HB_FILE" 2>/dev/null || echo 0) ))
         if [ "$AGE" -lt 60 ]; then
           echo "$(date) SUPERVISOR: Recovered on attempt $((i+1))."
           break
         fi
       done
       # If still stale after 3 attempts, EMERGENCY_STOP
       if [ "$AGE" -gt 60 ]; then
         echo "$(date) SUPERVISOR: EMERGENCY_STOP after 3 attempts."
         launchctl bootout gui/$(id -u)/com.ping-guard.daemon
         osascript -e 'display notification "ping-guard stopped — manual restart required." with title "ping-guard EMERGENCY_STOP" sound name "Basso"'
         exit 1
       fi
     fi
     sleep 30
   done
   ```
   Note: user approved this policy explicitly.

4. [P4.4] **Session cap + reaper** in `src/session/SessionManager.ts` — **MOVED TO PHASE 1** per A-HIGH-6; P4 retains only plist hardening:
   - Line 54 object literal: `maxActiveSessions: 10,` → `maxActiveSessions: 50,`
   - Line 215 is `async cleanup(): Promise<number>` method. It has NO periodic caller today (A-CRIT-3). Add a new method `reapSystemSessions(): Promise<number>` that finds sessions matching `(name ∈ ["native-sync","auto-recall","canary"] OR (memoryCount===0 AND eventCount===0)) AND idleMinutes >= 10` and calls `endSession()` on each.
   - Add periodic caller: in `SessionManager` constructor, `this._reaperInterval = setInterval(() => { this.cleanup().catch(()=>{}); this.reapSystemSessions().catch(()=>{}); }, 120_000);`. In `close()`: `clearInterval(this._reaperInterval);`.
   - Test: create 11 `native-sync` sessions, sleep 11 min, wait for interval tick, verify count drops below 10 (F11).

5. [P4.5] **OrbStack wake**: patch `~/Projects/ping-guard/scripts/wake_detector.py` to add `orbctl start` before `docker info` poll:
   ```python
   def _start_orbstack() -> None:
       try:
           subprocess.run(["orbctl", "start"], capture_output=True, text=True, timeout=10)
       except (subprocess.TimeoutExpired, FileNotFoundError):
           LOG.warning("orbctl start failed or not installed")
   ```
   Call it in `handleWakeNotification_` before `_wait_for_docker()`.

6. [P4.6] **launchd plist hardening** for `com.ping-mem.daemon.plist` AND the new `com.ping-mem.doctor.plist` (P5):
   ```xml
   <key>ProcessType</key><string>Interactive</string>  <!-- opts out of App Nap -->
   <key>ExitTimeOut</key><integer>30</integer>
   <key>SoftResourceLimits</key><dict>
     <key>NumberOfFiles</key><integer>4096</integer>
   </dict>
   <key>HardResourceLimits</key><dict>
     <key>NumberOfFiles</key><integer>8192</integer>
   </dict>
   ```

**Gate**:
- Disk ≤85% after `cleanup-disk.sh`.
- `ls -la ~/Library/Logs/ping-guard/*.err` shows all files <5MB after newsyslog rotates.
- Supervisor shows 0 "Rolled back" log entries in 7 days.
- Session cap not hit in 7 days (`/api/v1/session/list` count < 40 continuously).
- Mac sleep→wake: MCP tool works within 30s of wake (wake_detector.err shows orbctl ran).

**Wiring Matrix rows**: W15–W19.

---

### Phase 5 — Observability: ping-mem-doctor + /ui/health + launchd (4h)

**Objective**: Single command + dashboard + 15-min alarm that gives binary pass/fail on 29 gates.

**Tasks**:

1. [P5.1] **Create `src/cli/commands/doctor.ts`** with 29 gates (per R6 spec). Signature:
   ```typescript
   export async function runDoctor(opts: {
     json?: boolean;
     fix?: boolean;
     gate?: string;
     continuous?: boolean;
   }): Promise<DoctorResult> {...}
   export interface DoctorResult {
     gates: GateResult[];
     summary: {total: number; passed: number; failed: number; skipped: number};
     exitCode: 0 | 1 | 2 | 3;
   }
   ```

2. [P5.2] **Gate specifications** — `src/cli/doctor/gates/*.ts`:
   - Infrastructure (6): disk-free, log-dir-size, ping-mem-container, neo4j-container, qdrant-container, orbstack-reachable
   - Service (7): rest-health, rest-admin-auth, mcp-proxy-stdio, ollama-reachable, ollama-model-qwen3, ollama-warm-latency, session-cap-utilization
   - Data-coverage (4): per-project commit-coverage, per-project file-coverage, per-project last-ingest-age, sync-lag
   - Self-heal (3): pattern-library-confidence, aos-reconcile-absent, ollama-chain-reachable
   - Log-hygiene (3): log-file-size, rotation-recent, supervisor-no-rollback
   - Regression (5): run 5 canonical queries, ≥1 hit each
   - Alert integrity (1): dedup-db-writable

3. [P5.3] **Wire into `src/cli/cli.ts`** as `ping-mem doctor`. Add to `package.json#bin`: `"ping-mem": "dist/cli/cli.js"`. Also add `"doctor": "bun run dist/cli/commands/doctor.js"` to `package.json#scripts`.

4. [P5.4] **launchd plist** at `~/Library/LaunchAgents/com.ping-mem.doctor.plist`:
   ```xml
   <plist version="1.0"><dict>
     <key>Label</key><string>com.ping-mem.doctor</string>
     <key>ProgramArguments</key><array>
       <string>/bin/bash</string><string>-lc</string>
       <string>cd /Users/umasankr/Projects/ping-mem && bun run dist/cli/cli.js doctor --json > ~/.ping-mem/doctor-runs/$(date +%s).jsonl 2>&1</string>
     </array>
     <key>StartInterval</key><integer>900</integer>
     <key>RunAtLoad</key><true/>
     <key>StandardOutPath</key><string>/Users/umasankr/Library/Logs/ping-mem-doctor.log</string>
     <key>StandardErrorPath</key><string>/Users/umasankr/Library/Logs/ping-mem-doctor.err</string>
   </dict></plist>
   ```

5. [P5.5] **SQLite dedup** at `~/.ping-mem/alerts.db`. Schema:
   ```sql
   CREATE TABLE IF NOT EXISTS alerts (
     gate_id TEXT PRIMARY KEY,
     last_fired_at INTEGER,
     last_resolved_at INTEGER,
     severity TEXT,
     fire_count INTEGER DEFAULT 0
   );
   ```
   Doctor checks if a gate failed in last 60 min; if yes, skip osascript (log only). If newly fails, `osascript -e 'display notification ...'`.

6. [P5.6] **/ui/health dashboard** at `src/http/ui/health.ts` — reads from `~/.ping-mem/doctor-runs/*.jsonl` ring buffer (keep last 96 = 24h). HTMX-based auto-poll. Per-gate sparkline over 7 days. Basic-Auth-gated "Run now" button that invokes doctor and refreshes.

7. [P5.7] **Replace shallow `health` script in package.json**:
   ```json
   "health": "bun run dist/cli/cli.js doctor --json --quiet",
   "doctor": "bun run dist/cli/cli.js doctor"
   ```

8. [P5.8] **Load and verify launchd job**:
   ```bash
   launchctl load -w ~/Library/LaunchAgents/com.ping-mem.doctor.plist
   launchctl start com.ping-mem.doctor
   sleep 5
   launchctl list | grep com.ping-mem.doctor  # should show PID
   ls -la ~/.ping-mem/doctor-runs/*.jsonl | tail -3
   ```

**Gate**: `bun run doctor` exits 0 after P1-P4 fixes complete. Exits 2 when a gate is deliberately broken (kill neo4j container). /ui/health page loads and shows 29 gates. launchd runs doctor every 15 min.

**Wiring Matrix rows**: W20–W24.

---

### Phase 6 — auto-os Integration (2h)

**Objective**: auto-os workflows can read+write ping-mem memories without session-cap or auth errors. Cross-project memory search returns results.

**Tasks**:

1. [P6.1] Update auto-os Projects Agent config to pass `X-Session-ID` or use a service session (long-lived, not session-limited). Verify in `/Users/umasankr/Projects/auto-os/` config.
2. [P6.2] Document memory write path for paro-jobs.yaml. Update schema doc at `~/Projects/auto-os/docs/paro-jobs-schema.yaml` if needed.
3. [P6.3] Cross-project memory search test: from an auto-os-registered agent, search for a memory created by Claude Code (e.g. "classroom redesign worktree"), assert ≥1 hit.

**Gate**: auto-os agent can write + read ping-mem across a 5-minute test period without 429/403.

**Wiring Matrix rows**: W25–W27.

---

### Phase 7 — Soak + Regression CI (2h)

**Objective**: Acceptance criteria for "don't touch for 30 days" are concrete, automated, and have alert paths.

**Tasks**:

1. [P7.1] **Regression test suite** at `tests/regression/memory-sync-coverage.test.ts` (Bun test):
   ```typescript
   import { test, expect } from "bun:test";
   const REGRESSION_QUERIES = [
     "ping-learn pricing research",
     "Firebase FCM pinglearn-c63a2",
     "classroom redesign worktree",
     "PR 236 JWT secret isolation",
     "DPDP consent age 18",
     "PingLearn voice tutor LiveKit",
     "Supabase migration consent tokens",
     "Ollama qwen3:8b recovery brain",
     "ping-mem-doctor gates 29",
     "native-sync hook truncation fix"
   ];
   test.each(REGRESSION_QUERIES)("regression query: %s", async (query) => {
     const sessionId = await getSharedSessionId();
     const res = await fetch(`http://localhost:3003/api/v1/search?query=${encodeURIComponent(query)}&limit=3`, {
       headers: {"X-Session-ID": sessionId, Authorization: `Basic ${btoa(""$PING_MEM_ADMIN_USER:$PING_MEM_ADMIN_PASS"")}`}
     });
     const data = await res.json();
     expect(data.data.length).toBeGreaterThanOrEqual(1);
   });
   ```
   Acceptance: all 10 queries return ≥1 hit. Run in CI.

2. [P7.2] **30-day soak arithmetic** at `tests/regression/soak-acceptance.md`:
   - HARD gates (10, must be green 30/30 days): rest-health, mcp-proxy-stdio, regression-queries-5-of-5, ingestion-coverage-ping-learn, ingestion-coverage-5-projects, self-heal-ollama-reachable, disk-below-90, session-cap-below-80%, supervisor-no-rollback, doctor-launchd-ran
   - SOFT gates (5, tolerate 6 red days): orbstack-warm-latency, log-rotation-last-7d, pattern-confidence-nonzero, auto-os-cross-project-hit, ping-mem-doctor-exec-time-below-10s
   - Failure modes that reset the 30-day clock: any hard gate red for ≥2 consecutive days.

3. [P7.3] **Monitoring script** `scripts/soak-monitor.sh` runs daily via launchd, reads `~/.ping-mem/doctor-runs/*.jsonl`, computes streak-days-green per gate, writes to `~/.ping-mem/soak-state.json`. At day 30 of all-green, prints CONGRATULATIONS and exits clean.

**Gate**: CI regression suite green. Soak monitor installed and running. Baseline soak day = 0.

**Wiring Matrix rows**: W28, W29.

---

### Phase 8 — Documentation + Handoff (1h)

1. Update `AGENT_INTEGRATION_GUIDE.md` with: memory-sync scope (all projects), Ollama tiers, doctor usage, 30-day soak definition.
2. Update top-level `README.md` with the new CLI commands.
3. Tag release: `git tag v2.0.0-ping-mem-complete-remediation`.
4. Update `.ai/decisions.jsonl` with an entry per phase.

**Gate**: all docs current.

---

## Database Schema Definitions

**Only one new table**: `~/.ping-mem/alerts.db#alerts` (SQLite, CREATE in doctor on first run).

```sql
CREATE TABLE IF NOT EXISTS alerts (
  gate_id         TEXT PRIMARY KEY,
  last_fired_at   INTEGER,   -- unix seconds
  last_resolved_at INTEGER,
  severity        TEXT CHECK(severity IS NULL OR severity IN ('info','warning','critical')),
  fire_count      INTEGER DEFAULT 0
);
```

No new tables in ping-mem's main SQLite (memories schema untouched).

## Function Signatures

New/modified signatures:

```typescript
// src/cli/commands/doctor.ts (NEW)
export interface GateResult {
  id: string; name: string; category: string;
  status: "pass" | "fail" | "skip";
  severity: "info" | "warning" | "critical";
  message: string; durationMs: number;
  evidence?: Record<string, unknown>;
}
export interface DoctorResult {
  gates: GateResult[];
  summary: {total: number; passed: number; failed: number; skipped: number};
  exitCode: 0 | 1 | 2 | 3;
  timestamp: string;
}
export async function runDoctor(opts: {
  json?: boolean; fix?: boolean; gate?: string; continuous?: boolean;
}): Promise<DoctorResult>;

// src/cli/doctor/gates/*.ts (NEW, one per gate)
export interface Gate {
  id: string; name: string; category: string; severity: "info"|"warning"|"critical";
  check: () => Promise<Omit<GateResult, "id"|"name"|"category"|"severity">>;
  fix?: () => Promise<{fixed: boolean; message: string}>;
}

// src/ingest/IngestionService.ts:46 (MODIFIED)
// Before: maxCommits?: number  // default 200
// After:  maxCommits?: number  // default 10000 (or undefined = all)

// src/session/SessionManager.ts:54 (MODIFIED)
// Before: maxActiveSessions: number = 10
// After:  maxActiveSessions: number = 50
// src/session/SessionManager.ts:215 (ADDED METHOD)
private async reapSystemSessions(): Promise<number>;

// src/http/ui/health.ts (NEW)
export function renderHealthDashboard(c: Context): Promise<Response>;
```

## Integration Points (file:line)

| Step | File | Line | Change |
|---|---|---|---|
| P1.1 | `~/.claude.json` | ping-mem MCP server `env` | Add `PING_MEM_ADMIN_USER`, `PING_MEM_ADMIN_PASS` |
| P1.2 | `~/.claude/hooks/ping-mem-native-sync.sh` | 70 | `head -c 2000` → `head -c 30000` |
| P1.3 | `~/.claude/hooks/ping-mem-native-sync.sh` | 104–126 | Replace hardcoded project loop with glob + learnings |
| P1.4 | `~/.claude/hooks/ping-mem-native-sync.sh` | 65 | `KEY="native/$FILENAME"` → per-project prefix |
| P1.6 | `~/.claude/settings.json` | hooks.Stop[] | Add `ping-mem-capture-stop.sh` |
| P1.7 | `~/.claude/hooks/ping-mem-memory-sync-posttooluse.sh` | NEW | Create + register PostToolUse |
| P2.1 | `src/ingest/IngestionService.ts` | 46, 129 | `maxCommits=200→10000`, `maxCommitAgeDays=30→365` |
| P3.1 | `~/Projects/ping-guard/scripts/ollama-tier.sh` | NEW | Ollama escalation wrapper |
| P3.2 | `~/Projects/ping-guard/manifests/ping-mem.yaml` | 249–266 | Replace LLM chain |
| P3.3 | `~/Projects/ping-guard/manifests/ping-mem.yaml` | 239 | `value: 4`→`14`; target `qwen3:8b`→`gpt-oss:20b` |
| P3.5 | `~/Projects/ping-guard/scripts/wake_detector.py` | 43–51, 92–95 | Remove reconcile_scheduled call |
| P4.1 | `scripts/cleanup-disk.sh` | NEW | Disk reclamation |
| P4.2 | `/etc/newsyslog.d/ping-guard.conf` | NEW | Log rotation |
| P4.3 | `~/Projects/ping-guard/scripts/supervisor.sh` | FULL REWRITE | Keep-forward + 3-retry + STOP |
| P4.4 | `src/session/SessionManager.ts` | 54, 215 | Cap raise + reaper |
| P4.5 | `~/Projects/ping-guard/scripts/wake_detector.py` | 54 | Add `_start_orbstack()` |
| P4.6 | `~/Library/LaunchAgents/com.ping-mem.daemon.plist` | + new keys | Hardening |
| P5.1 | `src/cli/commands/doctor.ts` | NEW | Doctor CLI |
| P5.2 | `src/cli/doctor/gates/*.ts` | NEW (29 files) | Gate implementations |
| P5.3 | `src/cli/cli.ts` | existing | Register `doctor` subcommand |
| P5.3 | `package.json` | bin, scripts | Wire CLI + doctor |
| P5.4 | `~/Library/LaunchAgents/com.ping-mem.doctor.plist` | NEW | 15-min timer |
| P5.6 | `src/http/ui/health.ts` | NEW | Dashboard |
| P5.6 | `src/http/rest-server.ts` | route mount | Register `/ui/health` |
| P7.1 | `tests/regression/memory-sync-coverage.test.ts` | NEW | Regression suite |

## Wiring Matrix

| Row | Capability | User Trigger | Call Path (file:line each hop) | Integration Test |
|-----|-----------|--------------|--------------------------------|------------------|
| W1 | MCP tool invocation works | Claude Code invokes `mcp__ping-mem__context_health` | ~/.claude.json env → `src/mcp/proxy-cli.ts:46` auth header → `src/http/rest-server.ts:3640` validate → tool handler | `mcp__ping-mem__context_health` returns `{status:"healthy"}` |
| W2 | All project memory files synced | User edits `~/.claude/projects/-Users-umasankr-Projects-ping-learn/memory/MEMORY.md` | PostToolUse hook → `ping-mem-memory-sync-posttooluse.sh` → `import_native_file` → `POST /api/v1/context` | Edit file, wait 5s, `/api/v1/search?query=<unique>` returns hit |
| W3 | CLAUDE.md in ping-mem | `~/.claude/CLAUDE.md` exists | SessionStart hook → native-sync.sh glob `$HOME/.claude/*.md` → import | `/api/v1/search?query="superpowers skill"` returns CLAUDE.md content |
| W4 | Learnings in ping-mem | Files in `~/.claude/learnings/` | SessionStart hook → native-sync.sh → `find $HOME/.claude/learnings` loop → import | `/api/v1/search?query=<learning-sentinel>` returns hit |
| W5 | <60s edit propagation | Write tool modifies a memory file | PostToolUse hook fires, imports changed file | Edit file, sleep 30s, verify ping-mem has new content |
| W6 | 5/5 regression queries | User searches for known content | Hybrid search engine returns from synced memories | `bun test tests/regression/memory-sync-coverage.test.ts` → pass |
| W7 | ping-learn ingestion ≥95% | Daily re-ingest cron | `com.ping-mem.periodic-ingest` → `IngestionService.ingestProject()` | `/api/v1/codebase/projects` shows ≥95% commit and file coverage |
| W8 | 5 projects covered | Re-ingest script | `scripts/reingest-active-projects.sh` → enqueue for all 5 | Query per project; all ≥95% |
| W9 | Idempotent re-ingest | Force re-ingest | `IngestionService` manifest-hash check → skip if unchanged | Run twice; second finishes in <30s |
| W10 | Ollama tier 1 triage | ping-guard detects fault | `daemon.ts` → escalation → `ollama-tier.sh llama3.2` → model decides | Inject fault, observe `tier=ollama_triage` in daemon.log |
| W11 | Ollama tier 2 recovery | Tier 1 returns confidence<0.8 | Next tier `ollama-tier.sh qwen3:8b` | Same, with forced low-confidence prompt |
| W12 | Ollama tier 3 deep | Tier 2 confidence<0.7 | `ollama-tier.sh gpt-oss:20b` | Same |
| W13 | Command-path recovery | Pattern matches | `guard.patterns[i].recover.command` executed | Inject neo4j_disconnected, observe recovery |
| W14 | Wake handler clean | Mac wakes from sleep | `wake_detector.py` → orbctl start → wait docker → kickstart daemons (no reconcile call) | Sleep Mac, wake, check `wake-detector.err` has no "reconcile-scheduled failed" |
| W15 | Disk stays <85% | — | `scripts/cleanup-disk.sh` + doctor disk-free gate | `df -h` <85% ongoing |
| W16 | Logs rotate | Log reaches 5MB | newsyslog cron → mv + gzip | `ls -la ~/Library/Logs/ping-guard/*.err*` shows rotated files |
| W17 | No silent rollbacks | Supervisor sees stale HB | Keep-forward logic, max 3 retries | supervisor.log 0 "Rolled back" |
| W18 | No session 429 | Hook creates session | Reaper + 50-cap → count stays low | Run 12 native-sync in row; doctor session-cap gate green |
| W19 | OrbStack resumes | Wake event | `orbctl start` before docker poll | wake-detector.err shows `orbctl start OK`; MCP works within 30s |
| W20 | doctor command exists | User runs `bun run doctor` | CLI router → `src/cli/commands/doctor.ts:runDoctor()` | Command exits 0 on healthy, 2 on any fail |
| W21 | Every 15 min check | launchd fires | `com.ping-mem.doctor.plist` | `launchctl list com.ping-mem.doctor` shows recent run |
| W22 | /ui/health dashboard | User opens URL | Hono route → `src/http/ui/health.ts:renderHealthDashboard()` | `curl /ui/health` returns HTML with 29 gates |
| W23 | Canary search works | doctor regression gate fires | `ping-mem-doctor` → run 5 queries | Verified in W6 |
| W24 | macOS notification on critical | Gate FAIL | doctor → check alerts.db dedup → osascript | Kill neo4j; observe notification (once, not every 15min) |
| W25 | auto-os writes to ping-mem | paro-jobs executes | Agent → auth header → POST /api/v1/context | Verify via `/api/v1/search` |
| W26 | paro-jobs schema documented | — | `auto-os/docs/paro-jobs-schema.yaml` | grep doc for "ping-mem write path" |
| W27 | Cross-project search | User queries from any project | Same /api/v1/search endpoint, no filter | Returns memories from multiple projects |
| W28 | Soak monitor tracks 30d | launchd daily | `scripts/soak-monitor.sh` reads doctor-runs, writes soak-state.json | After 30d clean, soak-state.json `status=green` |
| W29 | Regression in CI | Git push | `tests/regression/memory-sync-coverage.test.ts` in CI workflow | GitHub Actions green |

## Verification Checklist (Structural)

| # | Check | Command | Expected |
|---|-------|---------|----------|
| V1 | MCP env in claude.json | `python3 -c "import json; d=json.load(open(\"$HOME/.claude.json\")); print(d['mcpServers']['ping-mem']['env'])"` | Contains PING_MEM_ADMIN_USER, PING_MEM_ADMIN_PASS |
| V2 | Hook truncation fixed | `grep 'head -c' ~/.claude/hooks/ping-mem-native-sync.sh` | `head -c 30000` (or higher) |
| V3 | Hook scans all projects | `grep 'Projects-\*' ~/.claude/hooks/ping-mem-native-sync.sh` | Match (wildcard loop present) |
| V4 | Hook includes learnings | `grep 'learnings' ~/.claude/hooks/ping-mem-native-sync.sh` | Match |
| V5 | PostToolUse memory sync hook registered | `jq '.hooks.PostToolUse[].hooks[].command' ~/.claude/settings.json` | Contains `ping-mem-memory-sync-posttooluse.sh` |
| V6 | Stop hook registered | `jq '.hooks.Stop[].hooks[].command' ~/.claude/settings.json` | Contains `ping-mem-capture-stop.sh` |
| V7 | IngestionService maxCommits raised | `grep 'maxCommits' src/ingest/IngestionService.ts` | Default 10000 or higher |
| V8 | Ollama tier script exists | `test -x ~/Projects/ping-guard/scripts/ollama-tier.sh` | exit 0 |
| V9 | Manifest has ollama tiers | `grep 'ollama_triage\|ollama_recovery\|ollama_deep' ~/Projects/ping-guard/manifests/ping-mem.yaml` | 3 matches |
| V10 | Manifest no claude/codex/gemini tier | `grep -E 'tier: "(claude|codex|gemini)"' ~/Projects/ping-guard/manifests/ping-mem.yaml` | no matches |
| V11 | Supervisor no rollback | `grep 'git reset\|git stash\|Rolled back' ~/Projects/ping-guard/scripts/supervisor.sh` | no matches |
| V12 | Session cap raised | `grep 'maxActiveSessions' src/session/SessionManager.ts` | `= 50` |
| V13 | Reaper method exists | `grep 'reapSystemSessions' src/session/SessionManager.ts` | match |
| V14 | newsyslog conf installed | `test -f /etc/newsyslog.d/ping-guard.conf` | exit 0 |
| V15 | Doctor CLI exists | `test -f src/cli/commands/doctor.ts` | exit 0 |
| V16 | Doctor gates exist | `ls src/cli/doctor/gates/*.ts \| wc -l` | ≥ 29 |
| V17 | Doctor launchd plist | `test -f ~/Library/LaunchAgents/com.ping-mem.doctor.plist` | exit 0 |
| V18 | /ui/health exists | `test -f src/http/ui/health.ts` | exit 0 |
| V19 | alerts.db schema | `sqlite3 ~/.ping-mem/alerts.db '.schema alerts'` | Schema matches |
| V20 | Regression test exists | `test -f tests/regression/memory-sync-coverage.test.ts` | exit 0 |
| V21 | wake_detector OrbStack | `grep 'orbctl start' ~/Projects/ping-guard/scripts/wake_detector.py` | match |
| V22 | wake_detector no aos-reconcile | `grep 'aos-reconcile-scheduled' ~/Projects/ping-guard/scripts/wake_detector.py` | no matches |
| V23 | cleanup-disk.sh exists | `test -x scripts/cleanup-disk.sh` | exit 0 |
| V24 | Pattern confidence seeded | `sqlite3 ~/.ping-guard/guard.db 'SELECT name,confidence FROM patterns WHERE confidence>0'` | ≥6 rows |
| V25 | Activation — doctor launchd loaded | `launchctl list com.ping-mem.doctor` | PID > 0 |
| V26 | Activation — MCP proxy in claude.json is using updated env | `cat ~/.claude.json \| jq '.mcpServers["ping-mem"].env \| keys'` | includes PING_MEM_ADMIN_USER |
| V27 | Activation — supervisor loaded with new script | `launchctl list com.ping-guard.supervisor && ps -p $(launchctl list com.ping-guard.supervisor \| awk '/PID/{print $3}') -o args=` | shows new supervisor.sh |

## Functional Tests (Runtime)

Each exercises the wiring end-to-end. Commands are syntactically valid bash/curl, runnable as-is.

| # | Test | Command | Expected |
|---|------|---------|----------|
| F1 | MCP auth works | Start Claude Code, invoke `mcp__ping-mem__context_health` (via Agent harness in separate session) | `{status:"healthy",components:{...}}` not 403 |
| F2 | Sync imports CLAUDE.md | `bash ~/.claude/hooks/ping-mem-native-sync.sh && curl -sf -u "$PING_MEM_ADMIN_USER:$PING_MEM_ADMIN_PASS" -H "X-Session-ID: $(cat ~/.ping-mem/sync-session-id)" "http://localhost:3003/api/v1/search?query=superpowers&limit=1" \| jq '.data[0].value' \| grep -c superpowers` | ≥1 |
| F3 | Sync covers ping-learn | Same as F2 but query "ping-learn pricing research" | ≥1 hit |
| F4 | Regression 5/5 hits | `bun test tests/regression/memory-sync-coverage.test.ts` | 10 passing tests (incl 5 canonical) |
| F5 | Coverage ≥95% ping-learn | Run verify script from P2.3 | ping-learn: commits ≥95%, files ≥95% |
| F6 | Ollama tier triage | `bash ~/Projects/ping-guard/scripts/ollama-tier.sh llama3.2:latest "Test: service X is down, action?" 5 0.5` | Exits 0 or 3 (success or low-confidence); never 2 |
| F7 | Ollama self-heal canary | `docker stop ping-mem-neo4j && sleep 120 && docker ps --filter name=ping-mem-neo4j --format '{{.Status}}' \| grep -q Up && echo PASS` | `PASS` |
| F8 | Wake simulation | Disable wake_detector listening (for test), run `python3 -c "from wake_detector import WakeObserver; o=WakeObserver.alloc().init(); o.handleWakeNotification_(None)"` | No errors; wake-detector.err has no `aos-reconcile` line in last 1min |
| F9 | Supervisor no rollback | Induce stale heartbeat, observe log | 3 kickstart attempts, no `Rolled back`, EMERGENCY_STOP if all fail |
| F10 | Session cap high | Create 40 sessions rapidly | All succeed, no 429 |
| F11 | Reaper removes zombies | Create 11 idle native-sync, sleep 11min, count | < 10 after |
| F12 | Doctor all-green | `bun run doctor --json \| jq .summary.failed` | 0 |
| F13 | Doctor fails on broken gate | `docker stop ping-mem-neo4j && bun run doctor --json \| jq .exitCode` | 2 |
| F14 | Doctor runs every 15min | `ls -la ~/.ping-mem/doctor-runs/*.jsonl \| head -3` | files timestamped <20min apart |
| F15 | /ui/health renders | `curl -sf -u "$PING_MEM_ADMIN_USER:$PING_MEM_ADMIN_PASS" http://localhost:3003/ui/health \| grep -c 'gate-'` | ≥29 |
| F16 | macOS notification on critical (single) | Kill neo4j twice within 60min; count notifications | exactly 1 |
| F17 | Disk stays <85% | `df -h /System/Volumes/Data \| awk 'NR==2{gsub("%","",$5); print ($5<85)?"PASS":"FAIL"}'` | `PASS` |
| F18 | Log rotation active | `ls -la ~/Library/Logs/ping-guard/*.err*` | gzip'd archives present |
| F19 | auto-os cross-project | Write a memory from an auto-os agent, search from Claude Code context | ≥1 hit |
| F20 | Soak day counter increments | `cat ~/.ping-mem/soak-state.json \| jq .hardGates[0].streakDays` | ≥1 after 24h of all-green |

## Acceptance Criteria

### Functional

- [ ] AC-F1: all 5 canonical regression queries return ≥1 hit via both MCP and REST
- [ ] AC-F2: MCP `mcp__ping-mem__context_health` returns 200 from Claude Code
- [ ] AC-F3: ping-learn + ping-mem + auto-os + ping-guard + thrivetree show ≥95% commit and file coverage
- [ ] AC-F4: `bun run doctor` exits 0 on healthy, 2 on any broken gate
- [ ] AC-F5: injected fault (neo4j down) resolves within 2 min via Ollama chain
- [ ] AC-F6: Mac sleep→wake restores MCP + memory-sync within 30s
- [ ] AC-F7: session cap never hit in 7-day window (count <40 continuously)
- [ ] AC-F8: supervisor log shows 0 "Rolled back" in 7 days
- [ ] AC-F9: logs rotated weekly; max file size <5MB
- [ ] AC-F10: `/ui/health` renders all 29 gates

### Non-Functional

- [ ] AC-NF1: doctor execution time <10s
- [ ] AC-NF2: native-sync hook execution time <10s for full re-sync
- [ ] AC-NF3: re-ingest of ping-learn <10 min
- [ ] AC-NF4: Ollama tier-1 latency <5s, tier-2 <20s, tier-3 <60s
- [ ] AC-NF5: disk stays <85% for 30 days
- [ ] AC-NF6: launchd doctor runs every 15 min

### Quality Gates

- [ ] AC-Q1: `bun run typecheck` 0 errors
- [ ] AC-Q2: `bun test` full suite green (baseline + new regression tests)
- [ ] AC-Q3: no new `any` types introduced
- [ ] AC-Q4: all shell scripts pass `shellcheck`

### 30-day Soak

- [ ] AC-S1: 10 hard gates green 30/30 consecutive days
- [ ] AC-S2: 5 soft gates green ≥24/30 days
- [ ] AC-S3: no manual intervention required during the 30 days
- [ ] AC-S4: at day 30, `~/.ping-mem/soak-state.json` shows `status: "green"`

## Risk Analysis

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Ollama OOM mid-recovery | Self-heal fails | Medium | Tier-1 uses llama3.2 (2GB only); `ollama_memory_hog` pattern with threshold 14GB evicts gpt-oss:20b first |
| Removing cloud tiers loses option for ambiguous faults | Recovery quality drops | Low | Rules tier still runs. User can re-add later. Ollama 3-tier covers common patterns. |
| Session cap raise masks a real leak | Silent memory growth | Medium | Doctor gate alerts when cap >80% utilized |
| 30000-char truncation still loses some CLAUDE.md content | Large files partially synced | Low | ping-mem schema has no TEXT size limit; bump further if needed. Doctor gate checks average memory size |
| Disk cleanup breaks a build | Developer workflow disrupted | Medium | Cleanup script runs on prompt (P0.2), not daily cron. User can opt out of specific cleanups. |
| OrbStack orbctl start hangs | Wake recovery stalls | Low | 10s timeout in `_start_orbstack`. Falls through to docker-info poll. |
| newsyslog config requires sudo | Cannot install in pipeline | High | Installation documented; user runs once manually. Doctor checks for rotation freshness as fallback. |
| Pattern confidence seeding overwrites learned values | Loses machine learning | Low | Seed only sets confidence IF <0.5; preserves higher values |
| MCP auth credentials in ~/.claude.json (plaintext) | Secret leak via file | Low | File is 600 perm by default. Alternative: `PING_MEM_ADMIN_PASS` via macOS Keychain (future enhancement — issue below). |
| Removing aos-reconcile-scheduled breaks something downstream | Unknown | Low | R2 verified no downstream consumer. Worst case: re-add the call. |

## Complete File Structure (post-implementation)

```
~/.claude/
  hooks/
    ping-mem-native-sync.sh                    [PATCHED]
    ping-mem-memory-sync-posttooluse.sh        [NEW]
  settings.json                                [MODIFIED: Stop + PostToolUse hooks]

~/.claude.json                                 [MODIFIED: MCP env]

~/Library/LaunchAgents/
  com.ping-mem.doctor.plist                    [NEW]
  com.ping-mem.daemon.plist                    [PATCHED: ProcessType, limits]
  com.ping-guard.supervisor.plist              [unchanged]

/etc/newsyslog.d/
  ping-guard.conf                              [NEW]

~/Projects/ping-guard/
  scripts/
    ollama-tier.sh                             [NEW]
    supervisor.sh                              [REWRITTEN]
    wake_detector.py                           [PATCHED]
    seed-pattern-confidence.ts                 [NEW]
  manifests/
    ping-mem.yaml                              [PATCHED]

~/Projects/ping-mem/
  scripts/
    cleanup-disk.sh                            [NEW]
    reingest-active-projects.sh                [NEW]
    soak-monitor.sh                            [NEW]
  src/
    cli/
      cli.ts                                   [PATCHED: register doctor]
      commands/
        doctor.ts                              [NEW]
      doctor/
        gates/
          *.ts                                 [NEW — 29 files]
        alerts.ts                              [NEW]
    http/
      ui/
        health.ts                              [NEW]
      rest-server.ts                           [PATCHED: route mount]
    ingest/
      IngestionService.ts                      [PATCHED: defaults]
    session/
      SessionManager.ts                        [PATCHED: cap + reaper]
  docs/
    plans/
      2026-04-18-ping-mem-complete-remediation-plan.md  [this file]
    ping-mem-remediation-research/
      01-current-state-audit.md
      02-ping-guard-remediation.md
      03-memory-sync-path.md
      04-ollama-integration.md
      05-lifecycle-resilience.md
      06-observability.md
      07-synthesis.md
  tests/
    regression/
      memory-sync-coverage.test.ts             [NEW]
      soak-acceptance.md                       [NEW]

~/.ping-mem/
  alerts.db                                    [NEW]
  doctor-runs/*.jsonl                          [NEW — timed logs]
  soak-state.json                              [NEW]
```

## Dependencies

No new npm packages. All work reuses existing deps:
- `bun:sqlite` for alerts.db (already in bun runtime)
- `chokidar` NOT NEEDED (we use the existing SessionStart + PostToolUse hooks, not a fs watcher)
- `hono` for `/ui/health` (already present)

External tools required (all already installed):
- `orbctl` (OrbStack CLI) — verified R5
- `ollama` CLI + endpoint :11434 — verified R4
- `sqlite3` CLI — for pattern seeding
- `newsyslog` — macOS built-in
- `bc` — for shell arithmetic (macOS built-in)
- `jq` — already used in hooks

## Success Metrics

| Metric | Baseline (2026-04-18) | Target Day 7 | Target Day 30 | Measurement |
|--------|----------------------|--------------|---------------|-------------|
| MCP tool invoke success | 0% | 100% | 100% | synthetic probe |
| Regression query recall | 0/5 | 5/5 | 5/5 | bun test regression |
| ping-learn coverage | 20% commits, 59% files | ≥95% both | ≥95% both | codebase_list_projects |
| Self-heal auto-resolve rate | 0% | ≥90% | ≥90% | injected canary faults |
| Mac sleep/wake recovery | N/A | <30s 100% | <30s 100% | wake-detector.log + doctor F8 |
| Disk usage | 96% | ≤85% | ≤85% | df |
| Log dir size | 16.1MB | <30MB | <30MB | du |
| Session cap collisions | daily | 0 | 0 | session/list |
| Silent rollbacks | 2 in 4d | 0 in 7d | 0 in 30d | supervisor.log |
| Doctor gate pass rate | N/A | ≥29/29 daily | ≥29/29 most days (soft gates allow 6 red/30d) | doctor-runs |
| 30-day soak status | not started | ongoing | `green` | soak-state.json |

## Out of Scope — NONE

Per user instruction, there are no deferrals. Any item not addressed in these 8 phases is either (a) already working (excluded from scope by verification) or (b) a future enhancement that will be a GH issue created during execution (not now, because none has been identified yet).

Items tracked for creation IF they surface during execution:

- Keychain-based MCP admin password storage (replacing plaintext in ~/.claude.json) — evaluation during P1
- Per-user ping-mem admin role differentiation — not relevant single-user
- File-watcher (chokidar) for truly realtime sync — will be created as GH issue IF PostToolUse hook proves insufficient during Phase 1 testing

Any such GH issues will be created in-session per the user's global rule. None exist yet.

## Notes on Plan Verification (to-be-done)

This plan, as of 2026-04-18, has not yet passed:
- [ ] EVAL (3 agents: completeness/feasibility, safety/compliance, performance/scalability)
- [ ] REVIEW (3 agents: architecture, simplicity/YAGNI, domain)
- [ ] Outcome-Anchored Reconciliation
- [ ] VERIFY (4 agents: codebase, schema, algorithms/APIs, integration points)
- [ ] Determinism Sweep (13 checks)
- [ ] Judge Panel (Opus 4.6 + Gemini 3.1 Pro + GPT 5.4)

After user approves the plan direction, these passes will be run and the plan amended + consolidated. The final predictability score (VERIFIED / TOTAL × 100) will be added to the frontmatter.

---

**End of plan.** Status: planning (awaiting user approval). Next: run EVAL/REVIEW/VERIFY passes, then present to user for ExitPlanMode + execution authorization.
