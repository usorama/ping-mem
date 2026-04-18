# ping-mem — Project State

**Last updated**: 2026-04-18 (end of Phase 4 session)
**Phase**: Remediation plan execution — 4 of 8 phases closed
**Health**: All subsystems green. 5/5 memory regression queries PASS. 5/5 project ingestion coverage ≥95%. 3/3 canary self-heal trials PASS ≤120s.

## Active work

**Plan**: `docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md` (1051 lines, 8 phases)
**PR**: #125 on `fix/ping-mem-complete-remediation-plan`
**Session memory** (for orientation): `~/.claude/projects/-Users-umasankr-Projects-ping-learn/memory/project_ping_mem_remediation.md`

### Closed phases (commits pushed to origin)

| Phase | Focus | Commits | Gate evidence |
|-------|-------|---------|---------------|
| 1 | Memory sync + MCP auth + session cap | ping-mem@6872209 | 5/5 canonical queries return ≥1 hit (was 0/5). MCP healthy. |
| 2 | Ingestion coverage ≥95% for 5 projects | ping-mem@66d3f1f | 5/5 projects pass. |
| 3 | Ollama self-heal 3-tier | ping-guard@63cd321+06bdaee, ping-mem@472b918 | 3/3 canary ≤120s. tier_errs 16→0. |
| 4 | Lifecycle + supervisor + plist | ping-mem@38a51cd+0095bc8, ping-guard@ef21186 | Disk 83% ≤85%. Daemon ProcessType=Interactive. Supervisor keep-forward. |

### Pending phases (resume here)

- **Phase 5** — ping-mem-doctor CLI (29 gates, 7 groups) + /ui/health HTMX dashboard + com.ping-mem.doctor.plist. Plan §532-611.
- **Phase 6** — auto-os integration (service session, cross-project memory). Plan §614-626.
- **Phase 7** — Soak + regression CI (10 canonical queries as bun test). Plan §630-671. **This is the E2E test** — user flagged ping-mem isn't e2e-tested yet.
- **Phase 8** — Docs + handoff + tag v2.0.0.

## Bugs found & fixed in-phase (not in the plan — surfaced during execution)

1. **MemoryManager SQL alias bug** (Phase 1, commit 6872209): `findRelatedAcrossSessions` had unaliased outer `events` table; SQLite resolved `payload` inside NOT EXISTS to inner `e2` → self-referential → filtered every memory out → all recall queries returned 0 hits. Fixed both fallback and main branches.
2. **Verify script denominator wrong** (Phase 2, commit 66d3f1f): raw `git ls-files | wc -l` compared ingested to untrackable PDFs/images/binaries. Rewrote to replicate scanner filter (exclude-exts + ignore-dirs + .gitignore/.pingmemignore prefixes + ≤1MB + `git log --all`).
3. **HealthMonitor fast-tick 60s lag** (Phase 3, commit 472b918): /health component snapshot was 60s behind actual service state, so canary trials missed the 120s gate by 1-3s. Fast-tick 60s→10s.
4. **ping-guard Ollama chain** (Phase 3, ping-guard@63cd321): prompt didn't instruct models to emit JSON schema → confidence=0 → all tiers exited 3 → fallthrough to rules. Added JSON-schema preamble to ollama-tier.sh. Also fixed manifest detect values (`ok`→`healthy`), removed broken warm-up curl, tightened cadence.

## Known follow-ups (to be handled in remaining phases, NOT technical debt)

- 8 orphan `native/<filename>` rows in ping-mem events table from pre-Phase-1 test writes → sweep in Phase 8 cleanup
- WatchEngine canary-cycle re-entrant skipping (ping-guard side) observed during Phase 3 trials → watch for recurrence in Phase 7 soak
- periodic-ingest.sh duplicating queue entries during concurrent manual re-ingest → add flock guard in Phase 2 follow-up

## What changed this session (2026-04-18)

Started session on top of an existing PR #125 with 5 commits of plan docs; session added 5 code commits across ping-mem and 3 across ping-guard. Orchestrator dispatched 2 per-phase sub-agents (Phase 2 + 3 + 4) and fixed 2 bugs directly (SQL alias, HealthMonitor tick). Hook changes outside the repo also landed: `~/.claude/hooks/ping-mem-native-sync.sh`, `ping-mem-capture-stop.sh`, `ping-mem-memory-sync-posttooluse.sh` (NEW), and `phase-gate-reminder.sh` (Stop hook reminder).

## Next Actions

1. Begin Phase 5 sub-agent with the prepared prompt (last session had it queued but user interrupted — it's in session transcript or re-derive from plan §532-611).
2. After Phase 5: continue Phase 6, 7, 8 per the same workflow.
3. Don't declare remediation complete until Phase 7's 10 canonical bun-test queries pass (the real E2E gate).
