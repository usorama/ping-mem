# ping-mem Remediation — Synthesis

**Date**: 2026-04-18
**Objective**: Take ping-mem from "daily band-aid" to "don't touch for 30 days" with mathematical certainty.
**Author**: Opus 4.7 (orchestrator) via /deterministic-plan

---

## Founding Principles (non-negotiable)

1. **Wire-don't-build-first**: The user already has substantial scaffolding — `ping-mem-native-sync.sh`, `ping-mem-auto-recall.sh`, `ping-mem-capture-post-tool.sh`, `ping-mem-capture-stop.sh`, MCP proxy auth code, LLMProxy Ollama integration, HealthMonitor, ingestion orchestrator, 14 /ui/* pages. Every fix must first check "does code already exist?" before adding new code.
2. **Outcome-anchored, not component-anchored**: The test is "user searches 'ping-learn pricing research' and gets ≥1 hit in ping-mem" — not "the ingestion function returns a value." Every section's acceptance criterion must be a user-observable outcome.
3. **Local-first with cloud-excluded-by-default**: Ollama is primary. Claude/Codex/Gemini are removed from self-heal chain (they are broken, and even if fixed introduce external dependency that hurts the 30-day goal).
4. **Deterministic over speculative**: Every config path verified with shell commands, every signature verified with grep. No "should work" reasoning.
5. **Surgical, idempotent, reversible**: Each phase is one commit per finding. Each script is idempotent. Rollback = git revert one commit.
6. **No silent failures**: Every error path emits a signal consumable by `ping-mem-doctor` and a macOS notification when critical.
7. **One source of truth per capability**: Memory sync goes through REST API only. Self-heal goes through Ollama only. Session cache lives in one place. No parallel write pathways.
8. **Observability drives everything**: `ping-mem-doctor` exists before fixes ship. If a fix breaks a gate, we see it within 15 minutes.

---

## Measurable Outcomes Table

| # | Outcome | Baseline (2026-04-18) | Target (after remediation) | Measurement |
|---|---------|----------------------|----------------------------|-------------|
| O1 | MCP tool invoke from Claude Code | 403 Forbidden (100%) | 200 OK (100%) | `mcp__ping-mem__context_health` returns healthy |
| O2 | Regression query recall | 0/5 hit (0%) | 5/5 hit (100%) | 5 canonical queries return ≥1 relevant result |
| O3 | Claude Code auto-memory files in ping-mem | ping-mem project only, truncated to 2000 chars | ALL projects, full content | `GET /api/v1/search?query=<sentinel>` finds whole memory |
| O4 | ping-learn ingestion coverage | 133/653 commits (20%), 1360/2314 files (59%) | ≥95% of both | `/api/v1/codebase/projects` stats vs `git rev-list --count` |
| O5 | Self-heal actually heals | 0% (all 4 tiers fail) | ≥90% resolution rate on canary faults | Inject fault → ping-guard resolves within 5 min |
| O6 | ping-mem survives sleep/wake | Containers yes, access via MCP no | Full capability restored within 30s of wake | Wake Mac, MCP tool works within 30s |
| O7 | Disk capacity | 96% full (17Gi free) | ≤80% full, stays ≤85% for 30 days | `df -P /System/Volumes/Data` |
| O8 | Session cap collisions | 10-cap hit within hours | 0 collisions in 30 days | `/api/v1/session/list` never shows `Maximum active sessions` error |
| O9 | Supervisor silent rollbacks | 2 in last 4 days | 0 (EMERGENCY_STOP replaces rollback) | `supervisor.log` grep "Rolled back" |
| O10 | Days no-touch (soak) | undefined | 30 calendar days, 10 hard gates 30/30 green, 5 soft gates ≥24/30 | `ping-mem-doctor` daily logs |

---

## Architecture Decision Records

### ADR-1: Memory-sync implementation = fix existing hook (not new watcher)

**Decision**: Fix and extend `~/.claude/hooks/ping-mem-native-sync.sh` + restore its registration in `~/.claude/settings.json`. Do NOT build `src/memory/sync/*` module.

**Why**: Research agent R3 recommended Option C (custom watcher). But user flagged "I believe we implemented this already." Verification confirmed:
- Hook exists (4,244 bytes, executable).
- SHA-256 change detection is implemented.
- REST POST/PUT integration is implemented.
- Session caching at `~/.ping-mem/sync-session-id` exists (26 hash markers).
- The hook has been running (sync-session-id is current).

**Root-cause gaps** (not rebuild needed, just fix):
1. Hook truncates content to **2000 chars** (line 70 `head -c 2000`). CLAUDE.md is ~15KB. 87% data loss.
2. Hook only scans `~/.claude/memory/`, `~/.claude/memory/topics/`, and `~/.claude/projects/-Users-umasankr-Projects-ping-mem/memory/`. Misses ping-learn, auto-os, ping-guard, thrivetree memory dirs.
3. Hook creates session but never calls `/api/v1/session/end` → zombie sessions → 10-cap hit.
4. Hook is SessionStart-only. No watcher for mid-session edits.

**Revised path**: "Option C — FIX mode" = 6 targeted patches to the existing hook + re-register it + add a lightweight file-watcher ONLY if SessionStart cadence proves insufficient (gate decision at Phase 1 end).

**Saved**: ~15 hours of net-new implementation. Eliminates src/memory/sync/ new module risk.

### ADR-2: Self-heal LLM chain = 3-tier Ollama only (remove cloud tiers)

**Decision**: Replace `claude`/`codex`/`gemini` tiers in `~/Projects/ping-guard/manifests/ping-mem.yaml#guard.escalation.llm_chain` with Ollama tiers only (llama3.2 → qwen3:8b → gpt-oss:20b → rules).

**Why**:
- User explicitly requested Ollama (constraint).
- All 3 cloud tiers are broken (claude exit 1, codex wrong flags, gemini missing creds).
- Ollama reachable in 21ms on this host (R4 measured).
- Cloud tiers introduce external deps that make the 30-day goal harder.
- Confidence-gated escalation: tier 1 acts if confidence ≥0.8; tier 2 acts ≥0.6; tier 3 deep-reason if <0.6; rules fallback if even tier 3 uncertain.

**Trade-off accepted**: If Ollama itself is down (OOM, disk full), no LLM help. Mitigation: rules tier + `ping-mem-doctor` alert fires within 15 min, user intervenes once.

### ADR-3: Observability = single `ping-mem-doctor` CLI + launchd timer + /ui/health dashboard

**Decision**: Build per R6 design — 29 gates across 6 categories in a single CLI (`src/cli/commands/doctor.ts`), scheduled by `com.ping-mem.doctor.plist` every 15 minutes. Dashboard at `src/http/ui/health.ts`. Dedup via SQLite at `~/.ping-mem/alerts.db`.

**Why**: A single script means one place to add gates. launchd means it runs whether or not Claude Code is open. SQLite dedup means alerts don't repeat every 15 min.

### ADR-4: Supervisor rollback removed → replaced with keep-forward + 3-retry + EMERGENCY_STOP

**Decision** (user-approved): Patch `~/Projects/ping-guard/scripts/supervisor.sh` to NEVER rollback. On stale heartbeat: 3 kickstart attempts with exponential backoff (5s, 15s, 45s). If all 3 fail: STOP the daemon, `osascript` notification, halt.

**Why**: Current rollback silently reverts ping-guard to mid-March commit, destroying all recent remediation work. Unacceptable for 30-day goal.

### ADR-5: Disk cleanup = one-shot ~50GB recovery (R5 identified)

**Decision**: Ship `scripts/cleanup-disk.sh` that reclaims Docker build cache (12GB), Xcode DerivedData (est. 10-15GB), Playwright caches (3GB), archived node_modules in stale worktrees (3.5GB), regen-able `.next` dirs (1.3GB), pip cache (1.5GB), Homebrew cache (6GB), `.Trash` (11GB if user approves).

**Why**: R5 verified 15.6GB safely recoverable and additional 30+ GB likely from Xcode/caches. 92% disk fail-gate in doctor will fire again if disk creeps up.

---

## Gap Analysis (current → target)

| Hard-Scope Item | Current | Gap | Severity | Phase |
|-----------------|---------|-----|----------|-------|
| A.1 MCP Basic Auth | Claude Code doesn't pass creds | Update `~/.claude.json` env block | CRITICAL | 1 |
| A.2 Config survives restarts | Env vars hard-coded in file | File-based, not runtime | LOW | 1 |
| A.3 MCP/REST contract parity | No parity test | New test in `src/__tests__/` | MEDIUM | 5 |
| B.1 Project memory dirs | Only ping-mem covered | Patch hook loop | CRITICAL | 1 |
| B.2 CLAUDE.md ingestion | Not included | Add paths to hook | HIGH | 1 |
| B.3 `~/.claude/memory/**` + `learnings/**` | Partial (memory yes, learnings no) | Extend hook | MEDIUM | 1 |
| B.4 Edit propagation <60s | SessionStart-only (minutes-hours) | Add PostToolUse-memory-change hook | MEDIUM | 1 |
| B.5 Regression queries | 0/5 | 5/5 | CRITICAL | 1 |
| B.6 Path choice | Research done (C-fix) | ADR-1 applies | N/A | — |
| C.1 ping-learn coverage | 20% commits, 59% files | Raise maxCommits, re-ingest | HIGH | 2 |
| C.2 Other projects | Unknown | Ingest all | HIGH | 2 |
| C.3 Idempotent re-ingest | Yes (tree hash) | Verify | LOW | 2 |
| C.4 Canary search | No | New canaries | MEDIUM | 5 |
| D.1 LLM chain | All broken | Replace with Ollama | CRITICAL | 3 |
| D.2 Command-path for patterns | Some exist | Keep, augment with confidence | LOW | 3 |
| D.3 Ollama primary | LLMProxy uses it for UI only | Wire into ping-guard | HIGH | 3 |
| D.4 aos-reconcile-scheduled | Missing | Remove call (R2 recommendation) | MEDIUM | 3 |
| E.1 Disk 96% | 17Gi free | Reclaim ≥50GB | CRITICAL | 4 |
| E.2 Log rotation | None | newsyslog config | HIGH | 4 |
| E.3 Supervisor rollback | Silent rollback | Keep-forward + 3-retry + STOP | CRITICAL | 4 |
| E.4 Session cap | 10 hit | Raise to 50 + reaper + hook end-session fix | CRITICAL | 4 |
| E.5 OrbStack wake | Polls docker info | `orbctl start` pre-step | HIGH | 4 |
| F.1 ping-mem-doctor | Doesn't exist | New CLI command | CRITICAL | 5 |
| F.2 launchd timer | Doesn't exist | New plist | HIGH | 5 |
| F.3 /ui/health | Doesn't exist | New src/http/ui/health.ts | MEDIUM | 5 |
| G.1 auto-os write path | Broken (session 429) | Fixed by E.4 + A.1 | MEDIUM | 6 |
| G.2 paro-jobs.yaml | Undefined | Doc + verify | LOW | 6 |
| G.3 Cross-project search | Empty | Fixed by B | HIGH | 6 |
| H.1 Pass/fail per section | Defined in this doc | N/A | — | — |
| H.2 30-day soak | Undefined | Acceptance bar defined | CRITICAL | 7 |
| H.3 Alerts | None | Doctor + osascript | HIGH | 5 |

---

## Implementation Phases (high-level, detailed in plan)

| Phase | Scope | Effort | Gate |
|-------|-------|--------|------|
| 0 | Prep: disk cleanup, typecheck+test baseline | 1h | Disk <85%, tests pass |
| 1 | Memory sync fix (B.*) + MCP auth (A.*) | 3h | All 5 regression queries return ≥1 hit |
| 2 | Ingestion coverage (C.*) | 3h | ≥95% coverage for 5 active projects |
| 3 | Ollama self-heal chain (D.*) | 4h | Inject fault → Ollama resolves within 2 min |
| 4 | Lifecycle/supervisor/session-cap (E.*) | 3h | Wake test: MCP works within 30s; 0 rollbacks in 7 days |
| 5 | ping-mem-doctor + /ui/health + launchd (F.*) | 4h | Doctor returns 0 on green, 2 on any red |
| 6 | auto-os + cross-project integration (G.*) | 2h | `/api/v1/search` from auto-os worker returns hits |
| 7 | 30-day soak + regression CI (H.*) | 2h | Regression suite in CI, soak monitor active |
| 8 | Documentation + handoff | 1h | AGENT_INTEGRATION_GUIDE.md updated |
| **Total** | | **23h** | |

---

## Outcome → Capability → Component Map

```
O1 MCP works  → Capability: AI agent queries memory via MCP → Claude Code .claude.json + src/mcp/proxy-cli.ts
O2 Regression → Capability: User searches for known content → HybridSearchEngine + memory sync
O3 Full sync  → Capability: All files in ping-mem → native-sync.sh + PUT /api/v1/context/:key
O4 Coverage   → Capability: Code questions answered accurately → IngestionService + re-ingest trigger
O5 Self-heal  → Capability: Auto-recover from fault → Ollama in ping-guard manifest
O6 Wake       → Capability: System resumes cleanly → wake_detector.py + orbctl
O7 Disk       → Capability: Writes don't fail → cleanup script + doctor gate
O8 Sessions   → Capability: No 429 → SessionManager cap raise + reaper + hook end
O9 Rollbacks  → Capability: Commits survive → supervisor.sh patch
O10 Soak      → Capability: Autonomous operation → doctor + launchd + CI regression
```

Every component has a Wiring Matrix row in the plan. Every row has a Functional Test that runs the component end-to-end.

---

**Provenance**: R1-R6 research agents (saved in this directory) + 4 user-confirmed decisions (memory-sync path, supervisor policy, LLM chain, soak bar) + direct code inspection by orchestrator.
