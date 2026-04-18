---
phase-id: P8
title: "Documentation + release tagging + handoff — shortest phase"
status: pending
effort_estimate: 1h
dependent-on: [P1, P2, P3, P4, P5, P6, P7]
owns_wiring: []
owns_outcomes: ["contributes to O10"]
blocks: []
parent: overview.md
---

# Phase 8 — Documentation + Release Tagging + Handoff

## Phase Goal

P8 is the smallest phase in the plan (~1h) and the only phase that writes zero product code. It closes the remediation by making the three canonical ping-mem docs (`docs/AGENT_INTEGRATION_GUIDE.md`, `README.md`, `CHANGELOG.md`) current with the capabilities P1–P7 shipped, tags a release (`v2.1.0-remediation`), records one decision-jsonl line per phase (P0–P8) so future sessions can reconstruct the "why", and removes the superseded single-file plan once the user approves.

P8 does NOT change any wiring — it only contributes to **O10** (30-day soak green) indirectly: docs that accurately describe the 3-tier Ollama chain, the `bun run doctor` CLI, the `/ui/health` dashboard, the native-sync hook chain, and the session reaper allowlist mean that when something goes sideways during the 30-day soak, the next operator (or agent) rediscovers the intended behavior in minutes, not hours. Documentation drift is a soak-breaker; this phase prevents it.

## Pre-conditions

P8 is the final phase. ALL of the following must hold before it starts:

- **P1 gate green** — `~/.claude/hooks/ping-mem-native-sync.sh` patched, `~/.claude/hooks/lib/ping-mem-sync-lib.sh` extracted, PostToolUse hook installed, `SessionManager` cap raised to 50 with reaper wiring, MCP Basic Auth credentials wired in `~/.claude.json`. F1–F6 pass.
- **P2 gate green** — 5 projects re-ingested to ≥95% coverage (both commits and files). F7–F9 pass.
- **P3 gate green** — Ollama 3-tier self-heal chain live in `~/Projects/ping-guard/manifests/ping-mem.yaml`, `ollama-tier.sh` wrapper installed, pattern confidences seeded ≥0.3, `_reconcile_scheduled()` removed from `wake_detector.py`. F10–F12 pass.
- **P4 gate green** — `scripts/cleanup-disk.sh` with `pgrep` guards, newsyslog + launchd log rotation, supervisor rewrite (keep-forward + 3-retry + EMERGENCY_STOP), `com.ping-guard.watchdog.plist` loaded, `wake_detector.py` `_start_orbstack()` wired. F15–F19 pass.
- **P5 gate green** — `src/cli/commands/doctor.ts` registered in `src/cli/index.ts`, `src/doctor/gates.ts` registry + 7 grouped check files, `com.ping-mem.doctor.plist` installed at 15-min cadence, `src/http/ui/health.ts` + `POST /ui/health/run`, `~/.ping-mem/alerts.db` schema present. F20–F24 pass.
- **P6 gate green** — auto-os service session pattern wired, `paro-jobs.yaml` schema doc updated, cross-project memory search verified. F25–F27 pass.
- **P7 gate green** — `tests/regression/memory-sync-coverage.test.ts` committed and green locally, `scripts/soak-monitor.sh` installed, `~/.ping-mem/soak-state.json` initialized, CI regression workflow green. F6 (CI variant) + F28 definition present.

**Verification before starting P8**: `git log --oneline remediation-baseline-2026-04-18..HEAD` shows at minimum one merge commit per phase P0-P7. If any phase is unmerged, P8 aborts and escalates.

---

## Tasks

### P8.1 — Update `~/Projects/ping-mem/docs/AGENT_INTEGRATION_GUIDE.md`

**Why here, not README**: `docs/AGENT_INTEGRATION_GUIDE.md` is marked "single source of truth for integrating AI agents with ping-mem" (line 7-8). All operator-facing behavior additions from P1–P5 belong here.

**Edit target**: `/Users/umasankr/Projects/ping-mem/docs/AGENT_INTEGRATION_GUIDE.md`.

**Edits**:

1. Bump frontmatter `**Version**: 2.0.0` → `**Version**: 2.1.0` and `**Last Updated**: 2026-02-13` → `**Last Updated**: <date P8 runs, YYYY-MM-DD>`.
2. Append the following new section **at the end of the document**, after the final heading. The section header anchors link from README and CHANGELOG.

```markdown
---

## 11. Claude Code Memory Sync (v2.1.0)

ping-mem v2.1.0 ships a complete Claude Code memory sync chain. Three cooperating pieces ensure every `~/.claude/**/*.md` file is ingested in full content within 60s of edit.

### 11.1 Hooks

Two shell hooks registered in `~/.claude/settings.json` under `hooks`:

- **SessionStart** (`~/.claude/hooks/ping-mem-native-sync.sh`) — full re-sync on every Claude Code session start. Walks `~/.claude/memory/`, `~/.claude/memory/topics/`, `~/.claude/learnings/`, AND every `~/.claude/projects/*/memory/*.md` (all projects, not only ping-mem). Uploads complete file content up to the server's `ContextSaveSchema.value.max(1_000_000)` ceiling — the hook `head -c 1000000` cap matches the schema so nothing truncates silently. SHA-256 marker files under `~/.ping-mem/sync-markers/` skip unchanged files.
- **PostToolUse** (`~/.claude/hooks/ping-mem-memory-sync-posttooluse.sh`) — runs detached (`setsid … & disown`) after any `Write`/`Edit`/`MultiEdit` tool call that touches `~/.claude/**/*.md`. Bounded sync latency <60s without a long-running file watcher. Sources `~/.claude/hooks/lib/ping-mem-sync-lib.sh` (function-only; no top-level exec).

### 11.2 Shared Library

`~/.claude/hooks/lib/ping-mem-sync-lib.sh` holds the sync functions both hooks source. **Function-only file**: no top-level `exit 0`, safe to `source` from multiple hook scripts. Keys are namespaced `native/<project>/<filename>` so two projects can have a `MEMORY.md` without collision.

### 11.3 Session Reaper Allowlist

`src/session/SessionManager.ts` caps active sessions at 50 (up from 10) and runs `cleanup()` every 2 min via `setInterval` (stored in the `_reaperInterval` field for strict-mode TS). The reaper's allowlist — an inline literal `["native-sync", "auto-recall", "canary", "auto-os-paro", "auto-os-worker"]` inside `reapSystemSessions()` — preserves long-lived service sessions so they never count toward the 50-cap. Named service sessions have a 15-min idle threshold; empty-name sessions use a 10-min threshold.

**Verification**:
```bash
# Edit any memory file
echo "$(date): test" >> ~/.claude/memory/core.md
# Wait <60s then search
curl -s "http://localhost:3003/api/v1/search?query=$(date +%Y-%m-%d)" | jq '.data | length'
# Expect: >= 1
```

## 12. Ollama 3-Tier Self-Heal Chain (v2.1.0)

ping-guard's self-heal LLM chain is now 100% local. All 3 tiers reach Ollama (`http://localhost:11434`) via `~/Projects/ping-guard/scripts/ollama-tier.sh`. Manifest at `~/Projects/ping-guard/manifests/ping-mem.yaml#guard.escalation.llm_chain`:

| Tier | Model | Timeout | Confidence gate | Purpose |
|------|-------|---------|-----------------|---------|
| 1 (triage) | `llama3.2:latest` | 5s | ≥0.8 | Fast pattern classification |
| 2 (recovery) | `qwen3:8b` | 20s | ≥0.7 | Concrete recovery command synthesis |
| 3 (deep) | `gpt-oss:20b` | 60s | ≥0.6 | Ambiguous-fault deep reasoning |
| fallback | rules | n/a | — | Seeded patterns (≥0.3 confidence) |

Resource protection: `ollama_memory_hog` threshold is 14 GB (was 4 GB) and eviction order targets `gpt-oss:20b` first (never `qwen3:8b`, which is the active recovery model). See ADR-2 in `docs/plans/2026-04-18-ping-mem-complete-remediation/overview.md`.

## 13. `ping-mem doctor` CLI

Gated health check covering 31 invariants across 7 groups (infrastructure/service/data-coverage/self-heal/log-hygiene/regression/alerts). Exit codes (single canonical taxonomy, mirrored in P5.3 and overview AC-F9):

- `0` — all gates green
- `1` — at least one gate warning (soft red, not critical)
- `2` — at least one critical gate red (hard fail)
- `3` — doctor could not reach ping-mem REST (unreachable)

```bash
bun run doctor                    # run all gates, human-readable
bun run doctor --json             # machine output for dashboards
bun run doctor --gate <name>      # run a single gate
bun run doctor --verbose          # print gate source paths
```

Gates live in `src/doctor/gates.ts` (registry) + `src/doctor/checks/*.ts` (7 grouped files: `infrastructure.ts`, `service.ts`, `data.ts`, `selfheal.ts`, `log-hygiene.ts`, `regression.ts`, `alerts.ts`). Each run writes a JSONL line to `~/.ping-mem/doctor-runs/<ISO8601>.jsonl`. launchd plist `~/Library/LaunchAgents/com.ping-mem.doctor.plist` triggers every 15 min.

## 14. `/ui/health` Dashboard

Hono route `GET /ui/health` at `src/http/ui/health.ts` reuses `src/http/ui/partials/health.ts` to render the current gate state. HTMX `POST /ui/health/run` triggers a fresh doctor run and swaps the fragment. Auth: same Basic Auth as `/api/v1/tools/*/invoke` (`PING_MEM_ADMIN_USER` / `PING_MEM_ADMIN_PASS`).

```bash
# Local
open http://localhost:3003/ui/health
```

## 15. 30-Day Soak Definition

See `docs/plans/2026-04-18-ping-mem-complete-remediation/overview.md#30-day-soak-acceptance`. 10 hard gates must be green 30/30 consecutive days; 5 soft gates tolerate ≤6 red days. Clock reset: any hard gate red on any day resets the counter to 0. State file: `~/.ping-mem/soak-state.json` (`status: green|running|failed`).

## 16. Full Architecture Reference

For the full remediation design (outcomes, wiring matrix, ADRs, gap coverage matrix, per-phase implementation), see:

- `docs/plans/2026-04-18-ping-mem-complete-remediation/overview.md` — source of truth for outcomes + architecture decisions
- `docs/plans/2026-04-18-ping-mem-complete-remediation/phase-0-prep.md` … `phase-8-docs-handoff.md` — per-phase implementation detail
- `docs/plans/2026-04-18-ping-mem-complete-remediation/CHANGELOG.md` — commit-SHA-indexed plan amendments
```

**Command**:

```bash
# Version + date header edits via sed (deterministic in-place)
sed -i.bak \
  -e 's/^\*\*Version\*\*: 2\.0\.0$/**Version**: 2.1.0/' \
  -e "s/^\*\*Last Updated\*\*: 2026-02-13$/**Last Updated**: $(date +%Y-%m-%d)/" \
  /Users/umasankr/Projects/ping-mem/docs/AGENT_INTEGRATION_GUIDE.md
rm /Users/umasankr/Projects/ping-mem/docs/AGENT_INTEGRATION_GUIDE.md.bak

# Append section 11–16 via heredoc
cat >> /Users/umasankr/Projects/ping-mem/docs/AGENT_INTEGRATION_GUIDE.md <<'EOF'
<paste sections 11–16 from above verbatim>
EOF
```

---

### P8.2 — Update `~/Projects/ping-mem/README.md`

**Edits**:

1. Bump the version badge line (line 5) from `version-2.0.1-blue` to `version-2.1.0-blue`.
2. In the "Development" section (line 281–287), add `bun run doctor` as the first command. Concrete patch:

**Before** (README.md lines 281–287):

```bash
bun install          # Install deps
bun run build        # Compile TypeScript
bun test             # Run tests (2000+)
bun run typecheck    # Type check (0 errors required)
bun run start        # Start server
```

**After**:

```bash
bun install          # Install deps
bun run build        # Compile TypeScript
bun test             # Run tests (2000+)
bun run typecheck    # Type check (0 errors required)
bun run start        # Start server
bun run doctor       # Run 29-gate health check (exit 0/2/3) — see docs/AGENT_INTEGRATION_GUIDE.md §13
```

3. In the Quick Examples section, replace the existing bare health check (line 195: `curl http://localhost:3003/health`) with a callout pointing readers to the new doctor CLI and dashboard. Add this immediately after the existing line 195:

```markdown
For a gated multi-subsystem health check (REST, MCP, ingestion coverage, self-heal, log hygiene, disk), prefer:

- CLI: `bun run doctor` (exits non-zero on any red gate)
- Dashboard: `GET /ui/health` — human-readable, HTMX-powered
```

**Commands**:

```bash
# Version badge bump
sed -i.bak 's|version-2\.0\.1-blue|version-2.1.0-blue|' /Users/umasankr/Projects/ping-mem/README.md
rm /Users/umasankr/Projects/ping-mem/README.md.bak

# The "Development" section and health callout additions are manual edits
# (sed for multi-line insert is error-prone; use the Edit tool in one patch).
```

---

### P8.3 — Update `~/Projects/ping-mem/CHANGELOG.md` (root, NOT plan dir)

**Target file**: `/Users/umasankr/Projects/ping-mem/CHANGELOG.md` (the project-root Keep-a-Changelog file, currently at v1.0.0 / 2026-02-14).

**Prepend** the following entry immediately after the `# Changelog` / preamble block (before the `## [1.0.0]` entry):

```markdown
## [2.1.0-remediation] - <date P8 runs, YYYY-MM-DD>

### Added
- Claude Code memory sync chain: SessionStart hook + PostToolUse hook + shared `ping-mem-sync-lib.sh` library. Full-content ingestion of `~/.claude/memory/**`, `~/.claude/learnings/**`, and every `~/.claude/projects/*/memory/*.md` (all projects, not only ping-mem). Per-project key prefix prevents collision.
- Ollama 3-tier local self-heal chain (`llama3.2` → `qwen3:8b` → `gpt-oss:20b`) with rules fallback — replaces the broken Claude/Codex/Gemini cloud chain. See ADR-2.
- `ping-mem doctor` CLI (`bun run doctor`) — 29-gate health check, exits 0/2/3. 15-min launchd schedule (`com.ping-mem.doctor.plist`). JSONL ring buffer at `~/.ping-mem/doctor-runs/`.
- `GET /ui/health` dashboard + `POST /ui/health/run` HTMX trigger. Basic Auth via `PING_MEM_ADMIN_USER` / `PING_MEM_ADMIN_PASS`.
- 30-day soak monitor (`scripts/soak-monitor.sh` + `~/.ping-mem/soak-state.json`) with 10 hard gates + 5 soft gates.
- Watchdog plist `com.ping-guard.watchdog.plist` — re-bootstraps ping-guard after Mac reboot so supervisor EMERGENCY_STOP is recoverable.
- Regression test suite at `tests/regression/memory-sync-coverage.test.ts` (CI-gated).

### Changed
- `~/.claude.json` permission hardened to `600` (was `644`). MCP Basic Auth credentials (`PING_MEM_ADMIN_USER`, `PING_MEM_ADMIN_PASS`) added to the ping-mem MCP env block.
- `src/session/SessionManager.ts` — `maxActiveSessions` raised 10 → 50; `cleanup()` now runs every 2 min via `setInterval` (`_reaperInterval` field); inline service-session allowlist (`["native-sync","auto-recall","canary","auto-os-paro","auto-os-worker"]`) inside `reapSystemSessions()` with differentiated idle thresholds (15 min named / 10 min empty-name).
- `src/ingest/IngestionService.ts` and `src/ingest/GitHistoryReader.ts` defaults — removed the 200-commit / 30-day ceiling; full-history ingestion now the default. Idempotent re-ingest (skip-if-unchanged) finishes in <30s.
- ping-guard supervisor (`~/Projects/ping-guard/scripts/supervisor.sh`) — rewritten to keep-forward + 3-retry + EMERGENCY_STOP, no more silent rollbacks.
- `~/Projects/ping-guard/wake_detector.py` — `_start_orbstack()` wired on wake event; broken `_reconcile_scheduled()` call removed.

### Fixed
- MCP tool invocation from Claude Code returning 403 Forbidden (missing Basic Auth credentials in `~/.claude.json`).
- Memory sync hook truncating content to 2000 chars (`head -c 2000`) — raised to 30000 to match `ContextSaveSchema.value.max`.
- Session-cap 429 collisions (daily occurrence) caused by missing periodic `cleanup()` caller.
- ping-learn codebase ingestion coverage (was 20% commits / 59% files) — now ≥95% / ≥95%.
- Supervisor silent rollbacks (2 in 4 days pre-remediation) that reverted ping-guard to mid-March state.

### Security
- `~/.claude.json` world-readable bit cleared. GH issue tracked for Keychain-backed password migration (future hardening).

### Technical Details
- Complete design + measurement plan: `docs/plans/2026-04-18-ping-mem-complete-remediation/`.
- 8 phases, ~32h implementation, 29 wiring rows, 10 outcomes (O1–O10).
```

**Command**:

```bash
# Manual Edit tool call — sed/awk multi-line prepend is fragile. Use one Edit operation
# keyed off the "## [1.0.0] - 2026-02-14" anchor line so the new entry lands immediately above it.
```

---

### P8.4 — Tag release `v2.1.0-remediation`

**Run only after all phase merge commits are on `main` AND P8.1–P8.3 are committed.**

```bash
cd /Users/umasankr/Projects/ping-mem

# Pre-check: confirm every phase merged
git log --oneline remediation-baseline-2026-04-18..HEAD | grep -E 'Phase [0-7]' || \
  { echo "FAIL — not every phase is merged. Abort tag."; exit 1; }

# Confirm clean tree
test -z "$(git status --porcelain)" || { echo "FAIL — dirty tree, commit P8.1–P8.3 first"; exit 1; }

# Annotated tag
git tag -a v2.1.0-remediation -m "$(cat <<'EOF'
ping-mem 2.1.0-remediation

30-day no-touch remediation landed. Full scope + measurements in:
  docs/plans/2026-04-18-ping-mem-complete-remediation/overview.md

Outcomes delivered (see overview.md §Stated Outcomes):
- O1: MCP tool invoke 100% from Claude Code
- O2: 5/5 canonical regression queries return hits
- O3: All Claude Code auto-memory files synced in full content
- O4: ≥95% commit + file coverage across 5 active projects
- O5: ≥90% self-heal auto-resolve rate (Ollama 3-tier)
- O6: Mac sleep/wake restores MCP <30s
- O7: Disk stays ≤85%
- O8: 0 session-cap 429 collisions in 7d
- O9: 0 silent supervisor rollbacks in 7d
- O10: 30-day soak monitor live (acceptance verified at day 30)

Tag scheme for this repo going forward:
  vMAJOR.MINOR.PATCH            — standard release
  vMAJOR.MINOR.PATCH-<suffix>   — named milestone (e.g. -remediation,
                                  -security-hardening) for plans that
                                  span multiple PRs and need one
                                  canonical rollback point.

Rollback target: remediation-baseline-2026-04-18 (local-only tag,
captured at P0).
EOF
)"

# Push tag to origin (this is the user-visible release marker; the baseline tag stays local)
git push origin v2.1.0-remediation

# Verification
git tag -l v2.1.0-remediation                     # expect: v2.1.0-remediation
git for-each-ref refs/tags/v2.1.0-remediation --format='%(objectname) %(subject)'
```

**Tag scheme decision (documented here so future phases pick it up)**: this repo uses `vMAJOR.MINOR.PATCH` for stock releases and `vMAJOR.MINOR.PATCH-<suffix>` for named milestones that span multi-PR plans. `-remediation`, `-security-hardening`, `-migration` are reserved suffixes.

---

### P8.5 — Append P0–P8 decisions to `.ai/decisions.jsonl`

**Target file**: `/Users/umasankr/Projects/ping-mem/.ai/decisions.jsonl`. Existing format (confirmed): one JSON object per line with fields `date`, `type`, `what`, `status`.

**Command**:

```bash
DATE_ISO=$(date +%Y-%m-%dT%H:%M:%S%z | sed 's/\(..\)$/:\1/')

cat >> /Users/umasankr/Projects/ping-mem/.ai/decisions.jsonl <<EOF
{"date":"$DATE_ISO","type":"decision","what":"P0 — Baseline tag remediation-baseline-2026-04-18 + ~/.claude.json chmod 600 + kill stale judge processes + 3 GH issues for tracked deferrals","status":"completed"}
{"date":"$DATE_ISO","type":"decision","what":"P1 — Fix (not rebuild) ~/.claude/hooks/ping-mem-native-sync.sh: raise truncation 2000->30000, widen scope to all ~/.claude/projects/*/memory, extract lib to ping-mem-sync-lib.sh, add PostToolUse hook, inject MCP Basic Auth creds in ~/.claude.json, raise SessionManager cap 10->50 + wire reaper setInterval. Owns O1+O2+O3+O8. Per ADR-1.","status":"completed"}
{"date":"$DATE_ISO","type":"decision","what":"P2 — Remove 200-commit / 30-day ingestion defaults in IngestionService.ts + GitHistoryReader.ts; enqueue + poll runId to completion; re-ingest 5 projects to >=95% coverage (both commits and files). Owns O4.","status":"completed"}
{"date":"$DATE_ISO","type":"decision","what":"P3 — Replace broken 4-tier cloud LLM self-heal chain (Claude/Codex/Gemini) with 3-tier local Ollama (llama3.2/qwen3:8b/gpt-oss:20b) + rules fallback. Write ollama-tier.sh wrapper, seed pattern confidences >=0.3, bump ollama_memory_hog 4GB->14GB, switch evict target qwen3->gpt-oss-20b, remove _reconcile_scheduled() from wake_detector.py. Owns O5. Per ADR-2.","status":"completed"}
{"date":"$DATE_ISO","type":"decision","what":"P4 — Guarded scripts/cleanup-disk.sh (pgrep before destructive rm), newsyslog + launchd log rotation, supervisor rewrite (keep-forward + 3-retry + EMERGENCY_STOP notification), com.ping-guard.watchdog.plist for post-reboot re-bootstrap, wake_detector.py _start_orbstack() wired. Owns O6+O7+O9. Per ADR-4 + ADR-5.","status":"completed"}
{"date":"$DATE_ISO","type":"decision","what":"P5 — Observability: src/cli/commands/doctor.ts (citty defineCommand) registered in src/cli/index.ts subCommands, src/doctor/gates.ts registry + 7 grouped check files, com.ping-mem.doctor.plist (15-min cadence, uses dist/cli/index.js — NOT a new cli.ts), src/http/ui/health.ts dashboard + POST /ui/health/run HTMX, SQLite ~/.ping-mem/alerts.db dedup, parallel gate exec via Promise.all + per-gate AbortController 5s. Per ADR-3.","status":"completed"}
{"date":"$DATE_ISO","type":"decision","what":"P6 — auto-os integration: service-session pattern for paro-jobs agent write path, paro-jobs.yaml schema doc updated, cross-project memory search smoke test passes.","status":"completed"}
{"date":"$DATE_ISO","type":"decision","what":"P7 — tests/regression/memory-sync-coverage.test.ts with dedicated test session (beforeAll/afterAll), scripts/soak-monitor.sh computes streak math against ~/.ping-mem/soak-state.json schema, CI regression workflow green. Defines O10 acceptance at day 30.","status":"completed"}
{"date":"$DATE_ISO","type":"decision","what":"P8 — Docs + tag: AGENT_INTEGRATION_GUIDE.md sections 11–16 (memory sync, Ollama chain, doctor CLI, /ui/health, 30-day soak, architecture refs); README.md version + bun run doctor callout; CHANGELOG.md v2.1.0-remediation entry; git tag v2.1.0-remediation pushed; superseded single-file plan docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md deleted after user approval.","status":"completed"}
EOF

# Verify: 9 new rows, each parseable
tail -9 /Users/umasankr/Projects/ping-mem/.ai/decisions.jsonl | jq -c 'select(.type and .what and .status) | .what' | wc -l
# Expect: 9
```

---

### P8.6 — Remove superseded single-file plan (USER APPROVAL GATE)

**Target file**: `/Users/umasankr/Projects/ping-mem/docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md` (referenced in `overview.md#previous-plan` as the failed 3-judge-panel attempt).

**Gate**: DO NOT delete until the user explicitly confirms in the P8 execution session. P0.7 created the expectation that this file would be retained for reference; P8.6 closes it once the multi-file plan is the proven source of truth.

**Commands** (run ONLY after user approval):

```bash
cd /Users/umasankr/Projects/ping-mem

# Confirm the target exists + we are on the remediation branch
test -f docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md || \
  { echo "Already removed or never existed — skip"; exit 0; }
git rev-parse --abbrev-ref HEAD
# expect: main (post-merge) OR fix/ping-mem-complete-remediation (pre-merge)

# Remove + commit
git rm docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md
git commit -m "$(cat <<'EOF'
docs(plan): remove superseded single-file plan

The single-file plan failed its 3-judge panel on 2026-04-18 AM due to
the amendments-over-body anti-pattern (5 of 6 HIGH amendments lived
only in the amendments log). It was retained through plan execution
for diff reference and to preserve the amendment audit trail.

With v2.1.0-remediation tagged and all 8 phases landed, the multi-file
plan at docs/plans/2026-04-18-ping-mem-complete-remediation/ is the
proven source of truth. Removing the superseded file eliminates an
attractive-but-stale document that would otherwise mislead future
operators.

Ref: docs/plans/2026-04-18-ping-mem-complete-remediation/overview.md
Ref: docs/plans/2026-04-18-ping-mem-complete-remediation/CHANGELOG.md (final entry)
EOF
)"

# Update overview.md#previous-plan paragraph to reflect removal:
# Before: "... Old file retained for reference and diff comparison; to be deleted by user after approval of this overview."
# After:  "... Old file removed at P8.6 after v2.1.0-remediation landed. Git history preserves the diff if needed: git log --follow docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md"
```

**If user withholds approval**: skip P8.6. The file stays. P8.7 still runs, but its CHANGELOG entry reads "superseded single-file plan retained per user preference" instead of "removed".

---

### P8.7 — Close plan CHANGELOG

**Target file**: `/Users/umasankr/Projects/ping-mem/docs/plans/2026-04-18-ping-mem-complete-remediation/CHANGELOG.md`.

**Append** one final dated entry:

```markdown
## <date P8 runs, YYYY-MM-DD>

- **Final**: Plan body consolidated. All 9 phases (P0–P8) landed on `main` and tagged `v2.1.0-remediation`. Superseded single-file plan at `docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md` removed per P8.6 (user approved). Multi-file plan at this directory is the permanent source of truth for the 30-day no-touch remediation.
- Tracked deferrals (GH-NEW-1 keychain, GH-NEW-2 chokidar watcher, GH-NEW-3 multi-user) remain open; their GH issue numbers are recorded in `/tmp/ping-mem-remediation-deferral-issues.json` and linked from ADR-1/ADR-3 as appropriate.
- Soak clock started at P7 landing. Day-30 acceptance monitored via `~/.ping-mem/soak-state.json`.
```

If P8.6 was skipped (user withheld approval), substitute "Superseded single-file plan at `docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md` retained per user preference" for the removal clause.

**Commands**:

```bash
cat >> /Users/umasankr/Projects/ping-mem/docs/plans/2026-04-18-ping-mem-complete-remediation/CHANGELOG.md <<EOF

## $(date +%Y-%m-%d)

- **Final**: Plan body consolidated. All 9 phases (P0–P8) landed on \`main\` and tagged \`v2.1.0-remediation\`. Superseded single-file plan at \`docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md\` removed per P8.6 (user approved). Multi-file plan at this directory is the permanent source of truth for the 30-day no-touch remediation.
- Tracked deferrals (GH-NEW-1 keychain, GH-NEW-2 chokidar watcher, GH-NEW-3 multi-user) remain open; their GH issue numbers are recorded in \`/tmp/ping-mem-remediation-deferral-issues.json\` and linked from ADR-1/ADR-3 as appropriate.
- Soak clock started at P7 landing. Day-30 acceptance monitored via \`~/.ping-mem/soak-state.json\`.
EOF
```

---

## Integration Points

Files edited by P8 (exhaustive list; no others touched):

| # | File | Edit kind |
|---|------|-----------|
| 1 | `/Users/umasankr/Projects/ping-mem/docs/AGENT_INTEGRATION_GUIDE.md` | Version+date header bump; append sections 11–16 |
| 2 | `/Users/umasankr/Projects/ping-mem/README.md` | Version badge bump; `bun run doctor` added to Development; `/ui/health` callout after line 195 |
| 3 | `/Users/umasankr/Projects/ping-mem/CHANGELOG.md` | Prepend `[2.1.0-remediation]` entry before `[1.0.0]` |
| 4 | `/Users/umasankr/Projects/ping-mem/.ai/decisions.jsonl` | Append 9 new lines (P0–P8 decisions) |
| 5 | `/Users/umasankr/Projects/ping-mem/docs/plans/2026-04-18-ping-mem-complete-remediation/CHANGELOG.md` | Append final entry |
| 6 | `/Users/umasankr/Projects/ping-mem/docs/plans/2026-04-18-ping-mem-complete-remediation/overview.md` | One-paragraph edit to `#previous-plan` if P8.6 executes |
| 7 | `/Users/umasankr/Projects/ping-mem/docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md` | DELETED (P8.6, user-gated) |

Git artifacts produced: annotated tag `v2.1.0-remediation` (pushed to origin), commit(s) for the doc edits, optional commit for P8.6 removal.

No product source code (`src/**/*.ts`) is touched by P8.

---

## Verification Checklist (structural)

- **V8.1** — AGENT_INTEGRATION_GUIDE.md version updated. `grep -cE '^\*\*Version\*\*: 2\.1\.0$' /Users/umasankr/Projects/ping-mem/docs/AGENT_INTEGRATION_GUIDE.md` returns `1`. (covers P8.1)
- **V8.2** — AGENT_INTEGRATION_GUIDE.md sections 11–16 present. `grep -cE '^## 1[1-6]\. ' /Users/umasankr/Projects/ping-mem/docs/AGENT_INTEGRATION_GUIDE.md` returns `6`. (covers P8.1)
- **V8.3** — README.md version badge bumped. `grep -c 'version-2\.1\.0-blue' /Users/umasankr/Projects/ping-mem/README.md` returns `1`. (covers P8.2)
- **V8.4** — README.md mentions `bun run doctor`. `grep -c 'bun run doctor' /Users/umasankr/Projects/ping-mem/README.md` returns `>=1`. (covers P8.2)
- **V8.5** — Root CHANGELOG.md contains 2.1.0-remediation entry. `grep -c '^## \[2\.1\.0-remediation\]' /Users/umasankr/Projects/ping-mem/CHANGELOG.md` returns `1`. (covers P8.3)
- **V8.6** — Tag exists locally AND on origin. `git tag -l v2.1.0-remediation` returns `v2.1.0-remediation`; `git ls-remote --tags origin v2.1.0-remediation` returns one row. (covers P8.4)
- **V8.7** — `.ai/decisions.jsonl` has 9 new valid JSON lines. `tail -9 /Users/umasankr/Projects/ping-mem/.ai/decisions.jsonl | jq -c 'select(.type==\"decision\" and .what and .status==\"completed\")' | wc -l` returns `9`. (covers P8.5)
- **V8.8** — Plan CHANGELOG.md has final entry. `tail -5 /Users/umasankr/Projects/ping-mem/docs/plans/2026-04-18-ping-mem-complete-remediation/CHANGELOG.md | grep -c 'Plan body consolidated'` returns `1`. (covers P8.7)
- **V8.9** — Superseded plan handled. Either `test ! -f /Users/umasankr/Projects/ping-mem/docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md` (P8.6 executed) OR the plan CHANGELOG final entry explicitly notes retention. Exactly one of the two must hold. (covers P8.6)
- **V8.10** — Working tree clean after all edits. `git status --porcelain` returns empty after the P8 commits land.

## Functional Tests (runtime)

- **F8.1** — Docs describe actual shipped behavior. Spot-check: `grep -c 'llama3.2.*qwen3.*gpt-oss' /Users/umasankr/Projects/ping-mem/docs/AGENT_INTEGRATION_GUIDE.md` returns `>=1` AND the same model names appear in the active `~/Projects/ping-guard/manifests/ping-mem.yaml`. Proves doc claim matches deployed artifact.
- **F8.2** — `bun run doctor` callout in README resolves. Follow the link in README to `docs/AGENT_INTEGRATION_GUIDE.md#13`; section 13 exists and describes the CLI. `grep -c '^## 13\. ' /Users/umasankr/Projects/ping-mem/docs/AGENT_INTEGRATION_GUIDE.md` returns `1`.
- **F8.3** — Tag resolves to a commit that contains all P8 edits. `git show --stat v2.1.0-remediation -- docs/AGENT_INTEGRATION_GUIDE.md README.md CHANGELOG.md .ai/decisions.jsonl` shows non-zero insertions for all four files (confirms tag was placed AFTER P8.1–P8.5 commits, not before).
- **F8.4** — Superseded plan is gone OR explicitly retained. `test ! -f /Users/umasankr/Projects/ping-mem/docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md && echo REMOVED || echo RETAINED` prints one of the two tokens. Whichever it prints must match the final CHANGELOG.md entry in the plan dir.
- **F8.5** — Decisions jsonl is machine-readable end-to-end. `jq -sc 'length' /Users/umasankr/Projects/ping-mem/.ai/decisions.jsonl` returns an integer (no parse errors on the 9 new lines or any prior line).

## Gate Criterion (binary — P8 passes or fails)

**P8 passes iff ALL of the following hold.** Any single failure = P8 FAIL; plan is not considered fully delivered until P8 is green.

- [ ] V8.1 through V8.10 all pass.
- [ ] F8.1 through F8.5 all pass.
- [ ] Tag `v2.1.0-remediation` is annotated (not lightweight), message contains the outcome list O1–O10, and is pushed to origin.
- [ ] No file outside the integration-points table is modified.
- [ ] No product source code (`src/**/*.ts`, `src/**/*.sh`) touched.

## Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|-----------|
| R8.1 | `git push origin v2.1.0-remediation` rejected (branch protection on tags or missing perms) | Low | Low — doc-only | Pre-check with `git remote -v` + `gh auth status`. If rejected, open a ticket, keep the tag local, log in CHANGELOG.md until unblocked. |
| R8.2 | User withholds P8.6 approval | Medium | Low | P8.6 is already gated behind explicit user confirmation. The plan CHANGELOG final entry has two documented variants (removed vs retained); neither blocks V8.9. |
| R8.3 | `sed -i.bak` version bump on a macOS/BSD vs GNU sed discrepancy corrupts the file | Low | Medium | Commands above use `-i.bak` (portable form that works on macOS BSD sed). Rollback: `git checkout -- <file>`. |
| R8.4 | AGENT_INTEGRATION_GUIDE.md section 11–16 append goes into the wrong location (e.g. before the footer link block) | Low | Low | The guide has no footer link block; appending at EOF is unambiguous. V8.2 asserts the six headings exist — if they don't, re-append. |
| R8.5 | `.ai/decisions.jsonl` contains a non-JSON line from an earlier session, so `jq -sc 'length'` fails | Low | Low | F8.5 explicitly surfaces this. If pre-existing corruption is found, fix it with `jq -c . /Users/umasankr/Projects/ping-mem/.ai/decisions.jsonl > /tmp/clean.jsonl && mv /tmp/clean.jsonl /Users/umasankr/Projects/ping-mem/.ai/decisions.jsonl` before appending P8's 9 lines. |
| R8.6 | Phase file ordering: P8 commits land before P7 merges, so the tag captures an incomplete state | Low | High (misleading tag) | P8.4 pre-check `git log remediation-baseline-2026-04-18..HEAD \| grep Phase [0-7]` aborts the tag if any phase is missing. |

## Dependencies

**Blocking**: P1, P2, P3, P4, P5, P6, P7 all merged to `main` and gates green. P0's baseline tag `remediation-baseline-2026-04-18` must still resolve (used as the "before" reference in the tag message).

**Blocks**: nothing. P8 is terminal. The 30-day soak clock, already started by P7, continues independently.
