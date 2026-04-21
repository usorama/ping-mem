# ping-mem — Project State

**Last updated**: 2026-04-19 (PR #125 merged; remediation shipped)
**Phase**: Remediation plan execution — **8 of 8 phases closed + /pr-zero 3-cycle clean + MERGED**
**Health**: All gates green. Doctor 34/34 pass. 10/10 E2E regression queries pass (~9s). Full bun suite clean. Baseline soak day 0.

## Active work

**Plan**: `docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md` — CLOSED
**PR #125**: MERGED 2026-04-19T16:49:39Z as squash commit **9e35b30**. Branch auto-deleted.
**Tag**: `v2.0.0-ping-mem-complete-remediation` pushed to origin
**/pr-zero cycles**: 3 cycles run. Final verdict clean across code-reviewer + silent-failure-hunter + security-sentinel. 5 fix commits squashed into 9e35b30: cycle-1 code findings + docs findings, cycle-2 critical NUL-detection bug + TimeoutError class + injection-hardening, cycle-3 residual creds + stderr visibility + admin-bucket test, plus workflow permissions fix.
**Session memory** (for orientation): `~/.claude/projects/-Users-umasankr-Projects-ping-learn/memory/project_ping_mem_remediation.md`

### All phases closed — evidence table

| Phase | Focus | Commits | Gate evidence |
|-------|-------|---------|---------------|
| 1 | Memory sync + MCP auth + session cap | ping-mem@6872209 | 5/5 canonical queries return ≥1 hit (was 0/5). MCP healthy with admin auth. |
| 2 | Ingestion coverage ≥95% for 5 projects | ping-mem@66d3f1f | 5/5 projects (ping-mem, ping-learn, ping-guard, auto-os, understory) pass verify. |
| 3 | Ollama self-heal 3-tier | ping-guard@63cd321+06bdaee, ping-mem@472b918 | 3/3 canary trials ≤120s end-to-end. tier_errs 16→0. |
| 4 | Lifecycle + supervisor + plist | ping-mem@38a51cd+0095bc8, ping-guard@ef21186 | Disk 83%≤85%. Daemon ProcessType=Interactive. Supervisor keep-forward verified. |
| 5 | Observability — doctor CLI + /ui/health + launchd | ping-mem@191cb0e | 34 gates (up from 29 planned). Exit 0 all-pass, exit 2 on deliberate break. launchd 15-min cadence. |
| 6 | auto-os integration (service session) | auto-os@921ac91 | pingmem_client + deep_search + schema persist. 50-cycle soak 0 errors. |
| 7 | E2E regression CI + 30-day soak | ping-mem@72a3989+07e7e28 | 10/10 canonical queries pass (8.09s). Full suite 1973/0/0. soak-monitor installed, day 0. |
| 8 | Docs + decisions + orphan sweep + tag + handoff | ping-mem@<phase8-sha> | Integration guide §14 added. README op-CLI section. 11 orphan native/* rows swept. Tag v2.0.0 pushed. |

### Baseline soak

- **soak_start**: 2026-04-19
- **target_day_30**: 2026-05-19
- **Hard gates** (10, must be green 30/30): rest-health, mcp-proxy-stdio, regression-queries-10-of-10, ingestion-coverage-ping-learn, ingestion-coverage-5-projects, self-heal-ollama-reachable, disk-below-90, session-cap-below-80%, supervisor-no-rollback, doctor-launchd-ran
- **Soft gates** (5, tolerate 6 red days): orbstack-warm-latency, log-rotation-last-7d, pattern-confidence-nonzero, auto-os-cross-project-hit, ping-mem-doctor-exec-time-below-10s
- Live state: `~/.ping-mem/soak-state.json` (updated daily by `com.ping-mem.soak-monitor`)

## Open GH issues (follow-ups, queued for 2026-04-20 brainstorm)

| Issue | Repo | Summary |
|-------|------|---------|
| [ping-mem#126](https://github.com/usorama/ping-mem/issues/126) | ping-mem | Wire regression suite into a GitHub Actions workflow on the self-hosted runner (currently local-only). |
| [ping-mem#127](https://github.com/usorama/ping-mem/issues/127) | ping-mem | Triage the uncommitted `/system-execute-2026-04-13` diff carried in the working tree — decide to commit, cherry-pick, or discard. |
| [ping-mem#128](https://github.com/usorama/ping-mem/issues/128) | ping-mem | CI hardening — Diagnostics Collection workflow hangs (no Ollama on runner, no step timeout). Needs `timeout-minutes`, either Ollama service or mock, and branch protection on main (currently none). |
| [auto-os#168](https://github.com/usorama/auto-os/issues/168) | auto-os | Wire paro-jobs runner to consume ping-mem `deep_search` output via cron-adjacent scheduler. |

## Next actions (tomorrow 2026-04-20)

1. **Brainstorm with user** (explicit mandate): ping-mem#126, #127, #128, auto-os#168 — decide priority + sequencing.
2. **Soak watch** (daily): `cat ~/.ping-mem/soak-state.json`. Day-30 target 2026-05-19.
3. Consider enabling branch protection on main (per #128) requiring benchmark + CodeRabbit green.

## Artifacts index

| File | Purpose |
|------|---------|
| `docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md` | Source plan (1051 lines, 8 phases) |
| `docs/AGENT_INTEGRATION_GUIDE.md` §14 | Operational subsystems reference (memory-sync, Ollama 3-tier, doctor, soak, service session) |
| `README.md` — Operational CLI section | `bun run doctor`, `bun run health`, regression test command |
| `tests/regression/memory-sync-coverage.test.ts` | 10-query bun test regression suite |
| `tests/regression/soak-acceptance.md` | 30-day soak hard/soft gate contract |
| `src/cli/commands/doctor.ts` | Doctor CLI entry point (34 gates) |
| `src/doctor/` | Gate modules (service, data, selfheal, infra, loghyg, regression, etc.) |
| `src/http/ui/health.ts` | `/ui/health` HTMX dashboard |
| `scripts/soak-monitor.sh` | Daily soak state computation |
| `~/.ping-mem/doctor-runs/YYYYMMDD.jsonl` | Doctor run history (ring buffer 96 slots / 24h at 15-min cadence) |
| `~/.ping-mem/soak-state.json` | Current soak state (days_green, hard gate streaks) |
| `.ai/decisions.jsonl` | Per-phase JSONL decisions log (8 entries appended in Phase 8) |
