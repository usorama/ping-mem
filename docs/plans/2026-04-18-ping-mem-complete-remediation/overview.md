---
title: "fix: ping-mem complete remediation — 30-day no-touch quality"
tier: T3
type: fix
date: 2026-04-18
status: planning
github_issues: []
github_pr: null
research: docs/ping-mem-remediation-research/ (7 documents: R1-R6 + synthesis)
synthesis: docs/ping-mem-remediation-research/07-synthesis.md
previous_plan: docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md (single-file, FAILED Judge Panel 2026-04-18 due to amendments-over-body anti-pattern — superseded by this multi-file rebuild)
eval_iteration: 0
review_iteration: 0
verification_iteration: 0
verification_method: "pending — per-phase EVAL+VERIFY + final 3-judge panel on whole directory"
predictability: "pending"
allowed-tools: AskUserQuestion, TodoWrite, TaskCreate, WebSearch, WebFetch
---

# ping-mem Complete Remediation — Multi-File Plan (T3)

**Scope**: Take ping-mem from "daily band-aid" to "don't touch for 30 days" quality. 8 phases, ~32h implementation.

**Why multi-file**: T3 work (≥3 subsystems, multi-day, ≥8 phases). Single-file was attempted 2026-04-18 AM; 3-judge panel found 5 of 6 HIGH amendments lived only in the amendments log, not in the body — anti-pattern #46. This rebuild uses `/deterministic-plan v3.0` T3 structure: overview.md (this file — orchestrator-owned, outcomes + wiring + ADRs) + one phase file per surgery (self-contained, independently executable).

**Authoring rule** (non-negotiable): overview.md is the single source of truth for **outcomes, wiring matrix, ADRs, gap coverage**. Phase files expand but never contradict. Amendments land via targeted body edits + `CHANGELOG.md` commit-SHA entries. No amendments-over-body.

---

## Problem Statement

ping-mem is "technically up" (health endpoint green, Neo4j/Qdrant/SQLite all healthy) but **delivers <20% of its intended capability**. Concrete failures measured on 2026-04-18:

| # | Symptom | Measurement | Evidence |
|---|---------|------------|----------|
| 1 | MCP from Claude Code 100% failure | `mcp__ping-mem__context_health` → 403 Forbidden | `~/.claude.json` has `PING_MEM_REST_URL` but no admin creds env; REST enforces Basic Auth on `/api/v1/tools/*/invoke` |
| 2 | Memory recall returns zero hits | 5/5 canonical queries → `{"data":[]}` | `GET /api/v1/search?query=<Q>` for "ping-learn pricing research", "Firebase FCM pinglearn-c63a2", "classroom redesign worktree", "PR #236 JWT secret isolation", "DPDP consent age 18" |
| 3 | Native sync truncates content | `head -c 2000` at `~/.claude/hooks/ping-mem-native-sync.sh:78` → 87% of CLAUDE.md lost | Hook source |
| 4 | Native sync scope narrow | Covers `~/.claude/memory/` + one hardcoded ping-mem project dir. Misses ping-learn, auto-os, ping-guard, thrivetree | Hook lines 108-131 |
| 5 | Zombie sessions | 10-cap hit daily. `SessionManager.cleanup()` has NO periodic caller today | `GET /api/v1/session/list` + `SessionManager.ts:54, 215` |
| 6 | Ingestion truncated | ping-learn: 133/653 commits (20%), 1360/2314 files (59%) | `codebase_list_projects` vs `git rev-list`. Root cause: `GitHistoryReader.ts:61` default `maxCommits=200` + `maxCommitAgeDays=30` |
| 7 | Self-heal chain 100% broken | Claude exit 1; Codex `--prompt` flag wrong; Gemini missing creds; rules have confidence 0 | `auto-os.err` + `manifests/ping-mem.yaml` |
| 8 | Supervisor silent rollbacks | 2 in last 4 days, reverts ping-guard daemon to mid-March commit | `supervisor.log` lines 2-8 |
| 9 | Disk 96% full | `/System/Volumes/Data` 412Gi used, 17Gi free | `df -h` |
| 10 | Log rotation nil | `auto-os.err` 9.4MB; `daemon.err` 6.7MB growing | `ls -la ~/Library/Logs/ping-guard/` |
| 11 | OrbStack wake gap | containers often suspended; `wake_detector.py` only polls `docker info`, doesn't call `orbctl start` | R5 research |
| 12 | Observability gap | No single command exits non-zero on any issue; no /ui/health page | Grep `src/cli/commands/` — no `doctor` subcommand |

**Root cause cluster**: Not a single bug. Cluster of 12 independent quality gaps accumulated because nothing checks any of them on a schedule, no alert fires when any regress, and the existing self-heal never actually heals.

---

## Stated Outcomes (the binary tests for delivery)

| # | Outcome | Baseline (2026-04-18) | Target Day 7 | Target Day 30 | Measurement |
|---|---------|----------------------|--------------|---------------|-------------|
| **O1** | MCP tool invoke from Claude Code | 403 (100% fail) | 200 (100%) | 200 (100%) | `mcp__ping-mem__context_health` returns healthy JSON |
| **O2** | 5/5 canonical regression queries hit | 0/5 | 5/5 | 5/5 | `GET /api/v1/search?query=<Q>` returns ≥1 hit per query |
| **O3** | All Claude Code auto-memory files in ping-mem | ping-mem project only, 2000-char truncation | ALL projects, full content | ALL projects, full content | `/api/v1/search` returns complete file content for any `~/.claude/projects/*/memory/*.md` |
| **O4** | ≥95% commit + file coverage for 5 active projects | ping-learn 20%/59% | ≥95%/≥95% | ≥95%/≥95% | `codebase_list_projects` per project vs `git rev-list --count` / `git ls-files \| wc -l` |
| **O5** | ≥90% self-heal auto-resolve rate on injected faults | 0% (all 4 tiers fail) | ≥90% | ≥90% | Inject fault → ping-guard resolves within 2 min (canary suite) |
| **O6** | Mac sleep/wake restores capability <30s | containers yes, MCP no | <30s 100% | <30s 100% | Sleep Mac, wake, invoke MCP within 30s — succeeds |
| **O7** | Disk stays ≤85% | 96% | ≤85% | ≤85% | `df -P /System/Volumes/Data` |
| **O8** | 0 session-cap 429 collisions in 30 days | daily hits | 0 in 7d | 0 in 30d | `/api/v1/session/list` + error log grep |
| **O9** | 0 silent supervisor rollbacks in 30 days | 2 in 4d | 0 in 7d | 0 in 30d | `supervisor.log` grep "Rolled back" |
| **O10** | 30-day soak green | undefined | — | 14 hard gates 30/30 + 5 soft gates ≥24/30 | `~/.ping-mem/soak-state.json` status=green |

**Acceptance rule**: A capability is delivered ONLY if its outcome test passes. "Code is written" is not delivery. "Component works in isolation" is not delivery. Outcome is measured from the user's entry point.

---

## Architecture Decision Records (affect multiple phases)

### ADR-1: Memory sync = FIX existing hook, not new module
**Status**: user-confirmed 2026-04-18 ("we implemented this already, chances are it's a wiring problem")
**Decision**: Patch `~/.claude/hooks/ping-mem-native-sync.sh` in place. Do NOT build `src/memory/sync/*` module. Extract shared logic to `~/.claude/hooks/lib/ping-mem-sync-lib.sh` (function-only, no top-level exec) so PostToolUse and SessionStart hooks can both source it safely.
**Why**: Hook exists (4244 bytes, executable, already registered in `~/.claude/settings.json`), SHA-256 change detection is implemented, session caching + REST POST already work. Gaps are in-place patches (truncation, scope, per-project prefix, marker collision, session end), not net-new code.
**Impact**: Phase 1 owns all hook + lib + PostToolUse + flock + migration work. Saves ~15h vs rebuild.

### ADR-2: Self-heal = 3-tier Ollama + rules, no cloud LLMs
**Status**: user-selected 2026-04-18 (via AskUserQuestion)
**Decision**: Replace `claude`/`codex`/`gemini` tiers in `~/Projects/ping-guard/manifests/ping-mem.yaml#guard.escalation.llm_chain` with `ollama_triage` (llama3.2:latest, 5s, conf≥0.8) → `ollama_recovery` (qwen3:8b, 20s, conf≥0.7) → `ollama_deep` (gpt-oss:20b, 60s, conf≥0.6) → rules fallback.
**Why**: All 3 cloud tiers measurably broken (Claude exit 1, Codex `--prompt` flag invalid, Gemini creds path wrong). Ollama reachable in 21ms. User constraint: local-first, no external deps that hurt 30-day goal. Ambiguous faults still need deep-reasoning path — 2-tier is insufficient for O5.
**Impact**: Phase 3 owns LLM chain + pattern confidence seeding + ollama-tier.sh wrapper + memory-hog threshold bump (4GB→14GB) + evict target switch (qwen3→gpt-oss-20b).

### ADR-3: Observability = `ping-mem-doctor` CLI + launchd 15-min + `/ui/health` dashboard + SQLite dedup
**Decision**: Single `src/cli/commands/doctor.ts` (citty `defineCommand`) registered in `src/cli/index.ts` `subCommands`. Gates in `src/doctor/gates.ts` as a registry + 7 grouped files in `src/doctor/checks/*.ts` (infrastructure/service/data/selfheal/loghygiene/regression/alerts). SQLite dedup at `~/.ping-mem/alerts.db`. launchd plist `com.ping-mem.doctor.plist` runs every 15 min. Hono route `GET /ui/health` at `src/http/ui/health.ts` reuses `src/http/ui/partials/health.ts` fragment. POST `/ui/health/run` triggers fresh doctor run for HTMX swap.
**Why**: User's F.3 scope explicitly requires a dashboard. JSONL ring buffer at `~/.ping-mem/doctor-runs/` feeds both dashboard and `soak-monitor.sh`. Registry pattern avoids 29 scattered files.
**Non-negotiable**: `package.json#bin` already points to `./dist/cli/index.js` — do NOT create `src/cli/cli.ts` or change bin path.
**Impact**: Phase 5 owns doctor CLI + gates registry + launchd plist + /ui/health page + alerts.db schema + soak-monitor.sh.

### ADR-4: Supervisor = keep-forward + 3-retry + EMERGENCY_STOP + watchdog re-bootstrap
**Status**: user-selected 2026-04-18 (via AskUserQuestion)
**Decision**: Rewrite `~/Projects/ping-guard/scripts/supervisor.sh` (~40 lines). On stale heartbeat: 3 `launchctl kickstart` attempts with backoff (5s, 15s, 45s). If all fail: `launchctl bootout` + `osascript` notification + exit 1. NEW: install `~/Library/LaunchAgents/com.ping-guard.watchdog.plist` (RunAtLoad=true, KeepAlive=true) that re-bootstraps ping-guard after Mac reboot so EMERGENCY_STOP is recoverable. Doctor gate `supervisor-watchdog-loaded` asserts plist is registered.
**Why**: Current rollback destroys recent remediation work (confirmed 2x in 4 days). EMERGENCY_STOP without watchdog = permanent trap door; watchdog closes it.
**Impact**: Phase 4 owns supervisor rewrite + watchdog plist definition + activation gate.

### ADR-5: Disk cleanup = guarded, non-destructive-by-default
**Decision**: `scripts/cleanup-disk.sh` adds `pgrep -f <proc>` guards before every destructive `rm -rf`. Guards: `ms-playwright` (playwright active), `.next` (next dev active), `DerivedData` (xcodebuild active). Targets: Docker build cache, Xcode DerivedData, Playwright cache, Homebrew downloads, pip cache, regen-able node_modules/.next in worktrees >14 days old. Expected recovery: 15-50 GB depending on what's active.
**Impact**: Phase 4 owns cleanup-disk.sh with guards + doctor disk gate + `~/.claude.json` chmod 600.

---

## Gap Coverage Matrix (every hard-scope item → phase)

| Gap | Section | Resolution Phase | Wiring Matrix Row | Acceptance Test |
|-----|---------|------------------|-------------------|-----------------|
| A.1 MCP Basic Auth | A | P1 | W1 | F1 (mcp__ping-mem__context_health = 200) |
| A.2 Auth survives restarts | A | P1 | W1 | F1 repeated post-restart |
| A.3 MCP/REST contract parity | A | P5 | W22 | F22 (CLI and REST return identical health JSON) |
| B.1 All project memory dirs | B | P1 | W2 | F2 (edit ping-learn MEMORY.md, search finds content) |
| B.2 CLAUDE.md ingestion | B | P1 | W3 | F3 (search "superpowers skill" returns hit) |
| B.3 `~/.claude/memory/**` + learnings/** | B | P1 | W4 | F4 (search learnings sentinel returns hit) |
| B.4 <60s edit propagation | B | P1 | W5 | F5 (edit file, sleep 30s, search returns new content) |
| B.5 5/5 regression queries | B | P1 + P7 | W6, W29 | F6 (bun test regression suite all green) |
| B.6 Path choice | B | ADR-1 | n/a | n/a |
| C.1 ping-learn ≥95% coverage | C | P2 | W7 | F7 (verify script shows ≥95% both axes) |
| C.2 5 projects ≥95% | C | P2 | W8 | F8 (same for ping-mem, auto-os, ping-guard, thrivetree) |
| C.3 Idempotent re-ingest | C | P2 | W9 | F9 (second re-ingest finishes <30s) |
| C.4 Coverage canary in doctor | C | P5 | W23 | F23 (doctor coverage gate fires when coverage<95%) |
| D.1 LLM chain all broken | D | P3 | W10, W11, W12 | F10 (inject fault → ollama tier resolves) |
| D.2 Command-path recovery | D | P3 | W13 | F11 (manifest command recoveries still execute) |
| D.3 Ollama primary | D | P3 | W10 | F10 (same) |
| D.4 aos-reconcile-scheduled | D | P3 | W14 | F12 (wake-detector.err no longer logs "reconcile-scheduled failed") |
| E.1 Disk ≤85% | E | P0 + P4 | W15 | F15 (df shows <85% post-cleanup AND doctor disk gate green 30d) |
| E.2 Log rotation | E | P4 | W16 | F16 (rotated .gz archives exist; log sizes <5MB) |
| E.3 Supervisor no rollback | E | P4 | W17 | F17 (supervisor.log has 0 "Rolled back" for 7d; watchdog plist loaded) |
| E.4 Session cap + reaper | E | P1 (moved per ADR) | W18 | F18 (session cap never hit in 7d; reaper runs via setInterval) |
| E.5 OrbStack wake | E | P4 | W19 | F19 (wake-detector.err shows `orbctl start OK`; MCP works within 30s of wake) |
| F.1 ping-mem-doctor exists | F | P5 | W20 | F20 (`bun run doctor` runs, exits 0/1/2/3 correctly) |
| F.2 launchd 15-min timer | F | P5 | W21 | F21 (doctor-runs/*.jsonl files timestamped every 15min) |
| F.3 /ui/health dashboard | F | P5 | W22 | F22 (curl /ui/health returns HTML with ≥29 gate indicators) |
| G.1 auto-os write path | G | P6 | W25 | F25 (auto-os agent writes memory, search returns hit) |
| G.2 paro-jobs.yaml path | G | P6 | W26 | F26 (doc updated; sample write via paro-jobs verified) |
| G.3 Cross-project search | G | P1 + P6 | W27 | F27 (query from one project context returns hits from another) |
| H.1 Pass/fail per section | H | overview AC | n/a | all AC-* below |
| H.2 30-day soak | H | P7 | W28 | F28 (soak-state.json status=green at day 30) |
| H.3 Alerts fire correctly | H | P5 | W24 | F24 (fault injection → single osascript notification, dedup works) |

**Zero rows unmapped.** Every hard-scope item has a phase + wiring row + test.

---

## Global Wiring Matrix (W1–W29)

Each phase file expands its own rows with file:line precision. This table is the global map; phase files are authoritative for call paths.

| # | Capability | User Trigger | Owning Phase | Functional Test |
|---|-----------|--------------|--------------|-----------------|
| W1 | MCP tool invocation works from Claude Code | invoke `mcp__ping-mem__*` | P1 | F1 |
| W2 | All project memory files synced (full content) | edit any `~/.claude/projects/*/memory/*.md` | P1 | F2 |
| W3 | CLAUDE.md ingested | SessionStart | P1 | F3 |
| W4 | Learnings ingested | SessionStart | P1 | F4 |
| W5 | <60s edit propagation | Write/Edit tool on memory file | P1 | F5 |
| W6 | 5/5 regression queries return hits | user searches for known content | P1 | F6 |
| W7 | ping-learn coverage ≥95% | daily re-ingest | P2 | F7 |
| W8 | 5 projects all ≥95% coverage | manual re-ingest run | P2 | F8 |
| W9 | Idempotent re-ingest (skip-if-unchanged) | re-run re-ingest | P2 | F9 |
| W10 | Ollama tier 1 triage | ping-guard detects fault | P3 | F10 |
| W11 | Ollama tier 2 recovery | tier 1 confidence<0.8 | P3 | F10 |
| W12 | Ollama tier 3 deep reasoning | tier 2 confidence<0.7 | P3 | F10 |
| W13 | Command-path recovery | pattern match hit | P3 | F11 |
| W14 | Wake handler clean (no aos-reconcile-scheduled error) | Mac wake event | P3 | F12 |
| W15 | Disk stays <85% | continuous | P4 | F15 |
| W16 | Logs rotate | size threshold hit | P4 | F16 |
| W17 | Supervisor never rollbacks, EMERGENCY_STOP recoverable | supervisor detects stale heartbeat | P4 | F17 |
| W18 | Session cap + reaper | session activity | P1 (reaper moved here per ADR) | F18 |
| W19 | OrbStack resumes on wake | Mac wake event | P4 | F19 |
| W20 | doctor CLI exists and exits correctly | user runs `bun run doctor` | P5 | F20 |
| W21 | doctor runs every 15min | launchd timer | P5 | F21 |
| W22 | /ui/health dashboard renders | user opens URL | P5 | F22 |
| W23 | Coverage canary gate | doctor runs | P5 | F23 |
| W24 | macOS notification dedup | gate fails repeatedly | P5 | F24 |
| W25 | auto-os writes to ping-mem | paro-jobs tick | P6 | F25 |
| W26 | paro-jobs.yaml schema documented | paro-jobs reader | P6 | F26 |
| W27 | Cross-project memory search | user queries across projects | P1 + P6 | F27 |
| W28 | 30-day soak counter increments correctly | launchd daily | P7 | F28 |
| W29 | Regression suite green in CI | git push | P7 | F6 (CI variant) |

---

## Phase Index (status + pointer to phase file)

| # | Phase | Scope | Effort | Gate | File | Status |
|---|-------|-------|--------|------|------|--------|
| P0 | Prep | Worktree + disk cleanup stub + test baseline + `~/.claude.json` chmod 600 + kill stale processes | 1h | disk <85%, typecheck clean, test count baseline snapshot | `phase-0-prep.md` | pending |
| P1 | Memory sync + MCP auth + session cap | A + B + E.4. Fix native-sync.sh (truncation 2000→1000000, scope, per-project prefix, marker hash-path, flock guard). Extract `ping-mem-sync-lib.sh`. Add PostToolUse hook detached. Migrate old keys (P1.4a). Update `~/.claude.json` env. SessionManager cap→50 + reaper + setInterval + _reaperInterval field. Hook cap matches REST `ContextSaveSchema.value.max(1_000_000)` — no silent truncation below 1 MB. | 5h | F1–F6 pass; O1+O2+O3+O8 green | `phase-1-memory-sync-mcp-auth.md` | pending |
| P2 | Ingestion coverage | C. Patch `IngestionService.ts:46` comment + `IngestionService.ts:129` age default + `GitHistoryReader.ts:61` runtime commit default. Add per-request scanner overrides (`ignoreDirs`, `excludeExtensions`) to `IngestProjectOptions` + `IngestionEnqueueSchema` + `ProjectScanner.scanProject` (P2.6.a-c). Update reingest script to re-include `docs/` + text extensions for 5 active projects (P2.6.d). Enqueue + poll `runId` until `completed`. Re-ingest 5 projects. Verify schema shape of `/api/v1/codebase/projects`. | 5h | F7–F9 pass; O4 green (files AND commits ≥95% on all 5 projects) | `phase-2-ingestion-coverage.md` | pending |
| P3 | Ollama self-heal | D. Write `ollama-tier.sh` (`--arg kl "15m"` not `--argjson`). Update manifest 3-tier chain. Seed pattern confidences (`path.join(homedir(),...)`, `WHERE confidence<0.5`). Remove `_reconcile_scheduled()` function (lines 40-51 + call at line 95). Bump `ollama_memory_hog` threshold 4→14 GB; evict `gpt-oss:20b` first. | 4h | F10–F12 pass; O5 green | `phase-3-ollama-selfheal.md` | pending |
| P4 | Lifecycle + supervisor + OrbStack + logs | E.1–E.3, E.5. `cleanup-disk.sh` with pgrep guards. newsyslog conf + user-space launchd fallback. Supervisor rewrite (keep-forward + 3-retry + STOP). `com.ping-guard.watchdog.plist` defined + loaded. `wake_detector.py` `_start_orbstack()` added at ~line 52 + call at ~line 91. launchd plist hardening (ProcessType=Interactive for daemon, Background+LowPriorityIO for doctor). | 4h | F15–F19 pass; O6+O7+O9 green | `phase-4-lifecycle-supervisor.md` | pending |
| P5 | Observability: doctor + /ui/health + alerts + watchdog gate | F. `src/cli/commands/doctor.ts` citty defineCommand registered in `src/cli/index.ts` subCommands. `src/doctor/gates.ts` registry + 7 grouped files. `com.ping-mem.doctor.plist` (uses `dist/cli/index.js` — NOT cli.js). `src/http/ui/health.ts` + POST `/ui/health/run`. SQLite `alerts.db` schema. Parallel gate execution via `Promise.all` + per-gate AbortController (5s). | 5h | F20–F24 pass | `phase-5-observability-doctor.md` | pending |
| P6 | auto-os integration | G. Service session pattern for auto-os agent. paro-jobs.yaml schema doc update. Cross-project memory search verified. | 2h | F25–F27 pass | `phase-6-auto-os.md` | pending |
| P7 | 30-day soak + CI regression | H. `tests/regression/memory-sync-coverage.test.ts` with dedicated test session (beforeAll/afterAll). `soak-monitor.sh` computes streak math. `soak-state.json` schema. CI workflow. | 3h | F6 green in CI; F28 defined | `phase-7-soak-regression.md` | pending |
| P8 | Documentation + handoff | README + AGENT_INTEGRATION_GUIDE.md + this overview's changelog + release tag. | 1h | docs current | `phase-8-docs-handoff.md` | pending |
| **Σ** | | | **29h** | | | |

**Effort note**: 29h implementation. Orchestration + validation adds 3-4h. Total ~32h.

---

## Success Metrics

| Metric | Baseline | Day 7 Target | Day 30 Target | Owner Phase |
|--------|----------|-------------|---------------|-------------|
| MCP tool invoke success rate | 0% | 100% | 100% | P1 |
| Regression query recall | 0/5 | 5/5 | 5/5 | P1 |
| ping-learn coverage | 20% c / 59% f | ≥95%/≥95% | ≥95%/≥95% | P2 |
| Self-heal auto-resolve rate | 0% | ≥90% | ≥90% | P3 |
| Wake recovery time | N/A | <30s 100% | <30s 100% | P4 |
| Disk usage | 96% | ≤85% | ≤85% | P0 + P4 |
| Log dir size | 16.1 MB | <30 MB | <30 MB | P4 |
| Session cap collisions | daily | 0 | 0 | P1 |
| Silent rollbacks | 2 / 4d | 0 / 7d | 0 / 30d | P4 |
| Doctor gates passing | N/A | 29/29 daily | ≥29/29 most days (5 soft gates tolerate 6 red/30d) | P5 |
| Soak status | not started | ongoing | `green` | P7 |

---

## 30-Day Soak Acceptance (user-selected: Realistic bar)

All gate IDs below are **P5 gate registry IDs**. P7's `scripts/soak-monitor.sh` matches on `.id` (not `.name`) and maps P5's emitted `status: pass|fail|skip` to `green|red` (pass→green; fail/skip→red). This is the single source of truth — if P5 adds/renames a gate, update this list in the same PR.

**HARD gates** (all 14 must be green 30/30 consecutive days — any red day resets clock):
1. `rest-health-200` (ping-mem REST returns `{"status":"ok"}`)
2. `mcp-proxy-stdio` (MCP proxy responds to JSON-RPC initialize within 3s)
3. `query-ping-learn-pricing` (canonical query 1 returns ≥1 hit)
4. `query-firebase-fcm` (canonical query 2)
5. `query-classroom-redesign` (canonical query 3)
6. `query-pr-236-jwt` (canonical query 4)
7. `query-dpdp-consent-18` (canonical query 5)
8. `coverage-commits-ge-95pct` (≥95% across 5 active projects)
9. `coverage-files-ge-95pct` (≥95% across 5 active projects)
10. `ollama-reachable` (`/api/tags` returns ≥1 model)
11. `disk-below-85` (df ≤85%)
12. `session-cap-below-80pct` (<40 active sessions)
13. `supervisor-no-rollback-24h` (0 "Rolled back" in last 24h)
14. `doctor-launchd-ran` (newest `~/.ping-mem/doctor-runs/*.jsonl` mtime <20 min old)

**SOFT gates** (5 must be green ≥24/30 days — tolerate up to 6 red days):
1. `orbstack-warm-latency` (health round-trip ≤2s post-wake)
2. `log-rotation-last-7d` (rotation event in last 7d)
3. `pattern-confidence-nonzero` (≥5 patterns with confidence ≥0.3)
4. `auto-os-cross-project-hit` (cross-project search smoke test passes)
5. `ping-mem-doctor-exec-time-below-10s` (doctor runs complete in <10s)

**Clock reset rule**: any HARD gate red on any day resets the 30-day counter to 0. SOFT gates tolerate spikes; only hard gates enforce the soak.

**Note on gate count**: this expands from 10 collapsed hard gates to 14 explicit gates because regression queries and coverage axes are separated — P5's registry has these as separate gates, and collapsing them at the soak layer would hide which specific canonical query or coverage axis regressed.

---

## Acceptance Criteria

### Functional
- [ ] AC-F1: O1 met — MCP `context_health` returns healthy from Claude Code
- [ ] AC-F2: O2 met — 5/5 regression queries hit via MCP and REST
- [ ] AC-F3: O3 met — all project memory dirs fully synced, no truncation
- [ ] AC-F4: O4 met — ≥95% coverage across 5 projects
- [ ] AC-F5: O5 met — injected fault resolves within 2 min (canary)
- [ ] AC-F6: O6 met — Mac sleep→wake restores MCP within 30s
- [ ] AC-F7: O8 met — 0 session-cap collisions in 7d
- [ ] AC-F8: O9 met — 0 supervisor rollbacks in 7d
- [ ] AC-F9: `bun run doctor` exits with canonical taxonomy — `0`=all green, `1`=soft-red (warning), `2`=hard-red (critical fail), `3`=ping-mem REST unreachable. This taxonomy is the single source of truth; P5.3 and P8 §13 mirror it verbatim.
- [ ] AC-F10: `/ui/health` renders all gates

### Non-Functional
- [ ] AC-NF1: doctor run <10s (parallel gate execution)
- [ ] AC-NF2: native-sync hook full re-sync <10s
- [ ] AC-NF3: ping-learn re-ingest <20 min
- [ ] AC-NF4: Ollama tier latencies t1<5s, t2<20s, t3<60s
- [ ] AC-NF5: disk ≤85% for 30 days
- [ ] AC-NF6: doctor launchd runs every 15 min

### Quality Gates
- [ ] AC-Q1: `bun run typecheck` 0 errors
- [ ] AC-Q2: `bun test` full suite green
- [ ] AC-Q3: no new `any` types
- [ ] AC-Q4: shell scripts pass `shellcheck`
- [ ] AC-Q5: `~/.claude.json` perm ≤600 (doctor gate asserts)

### 30-day Soak (O10)
- [ ] AC-S1: 14 hard gates green 30/30 consecutive days
- [ ] AC-S2: 5 soft gates green ≥24/30 days
- [ ] AC-S3: no manual intervention required during 30 days
- [ ] AC-S4: `soak-state.json` status=green at day 30

---

## Deferrals

No untracked deferrals. Items surfacing during execution that are genuinely out of scope get a GH issue created in-session per the user's capability-first rule. Three pre-approved tracked items (GH issues to be created during P0, not as deferrals but as future enhancements):

- **GH-NEW-1**: Keychain-backed MCP admin password (replaces plaintext in `~/.claude.json` — acceptable for dev, should upgrade for long-term security). Label: `security`, `ping-mem`.
- **GH-NEW-2**: File-watcher (chokidar) for true realtime sync — only created if P1 testing shows SessionStart + PostToolUse cadence is insufficient (sync-lag gate fails >10% of 30d).
- **GH-NEW-3**: Per-user ping-mem admin role differentiation — currently single-user; track for future multi-user.

---

## CHANGELOG

See `CHANGELOG.md` for commit-SHA-indexed amendment history. This file (overview.md) is the body; the body is always current.

## Previous Plan

`docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md` is the single-file T2-shaped attempt from earlier today. It FAILED 3-judge panel due to amendments-over-body anti-pattern (5 of 6 HIGH amendments lived only in the amendments log). This multi-file rebuild supersedes it. Old file retained for reference and diff comparison; to be deleted by user after approval of this overview.
