# 30-Day Soak Acceptance — Phase 7

**Plan**: `docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md` §662-665
**Phase**: 7 — Soak + Regression CI (E2E Gate)
**Status**: baseline — day 0 starts when `scripts/soak-monitor.sh` first writes `~/.ping-mem/soak-state.json`

---

## Purpose

Define the deterministic acceptance criteria that prove ping-mem meets the
"don't touch for 30 days" bar. The daily `com.ping-mem.soak-monitor` launchd
job reads `~/.ping-mem/doctor-runs/*.jsonl` and computes per-gate green-streak
counters. When all HARD gates are green for 30 consecutive days and SOFT gates
are green for ≥24/30 days, the soak is declared clean.

Monotonic rules:
1. Any **HARD gate red for ≥2 consecutive days** → `soak_start` resets to today.
2. A single red day on a HARD gate → warning only, no reset.
3. SOFT gate reds are tolerated up to 6 days out of 30.

---

## Hard Gates (10) — must be green 30/30 days

Each acceptance ID below maps to one or more doctor gate IDs (`<group>.<id>`
in the JSONL). The monitor script computes `streak_green_days` by walking
JSONL runs chronologically and counting consecutive days where every doctor
gate in the mapping was `pass` in at least one run that day.

| Acceptance ID                      | Doctor gate IDs (from doctor-runs JSONL)                                                                                                                                                                                                                                                        | Why it matters                                                                                                                                      |
|------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| `rest-health`                      | `service.rest-health`, `service.rest-admin-auth`                                                                                                                                                                                                                                                  | Proves ping-mem REST server is serving `/health` and admin auth round-trips.                                                                          |
| `mcp-proxy-stdio`                  | `service.mcp-proxy-stdio`                                                                                                                                                                                                                                                                          | Proves the MCP proxy CLI binary exists and is loadable — consumers depend on stdio transport.                                                         |
| `regression-queries-10-of-10`      | `regression.q1-…`, `regression.q2-…`, `regression.q3-…`, `regression.q4-…`, `regression.q5-…`, `regression.q6-…`, `regression.q7-…`, `regression.q8-…`, `regression.q9-…`, `regression.q10-…` (all 10 canonical queries from `src/doctor/util.ts#CANONICAL_QUERIES`)                             | Proves all 10 canonical queries still return ≥1 hit — the primary E2E gate. Upgraded from 5 to 10 in Phase 7.                                         |
| `ingestion-coverage-ping-learn`    | `data.commit-coverage`, `data.file-coverage` (ping-learn in detail string)                                                                                                                                                                                                                        | Proves the weakest project's coverage is still ≥95%. Monitor inspects `detail` string for project name.                                               |
| `ingestion-coverage-5-projects`    | `data.commit-coverage`, `data.file-coverage` (any project red counts against this)                                                                                                                                                                                                                | Proves all 5 canonical projects still meet the 95% floor.                                                                                             |
| `self-heal-ollama-reachable`       | `service.ollama-reachable`, `service.ollama-model-qwen3`, `selfheal.ollama-chain-reachable`                                                                                                                                                                                                       | Proves Ollama plus `qwen3:8b` is reachable for the self-heal tier-1 path.                                                                             |
| `disk-below-90`                    | `infra.disk-free`                                                                                                                                                                                                                                                                                  | Proves host disk usage < 90% (i.e. `availGi` above the 5 GiB floor).                                                                                  |
| `session-cap-below-80%`            | `service.session-cap-utilization`                                                                                                                                                                                                                                                                  | Proves active session count / cap < 80%. Gate fails if utilization threatens cap.                                                                     |
| `supervisor-no-rollback`           | `loghyg.supervisor-no-rollback`                                                                                                                                                                                                                                                                    | Proves no rollback/revert lines in daemon logs in the last 24h — daemon isn't looping.                                                                |
| `doctor-launchd-ran`               | (implicit: JSONL file present for that day under `~/.ping-mem/doctor-runs/`)                                                                                                                                                                                                                      | Proves `com.ping-mem.doctor` launchd job actually ran. Missing day = red.                                                                             |

---

## Soft Gates (5) — tolerate 6 red days out of 30

| Acceptance ID                       | Doctor gate IDs                                                                                                                                                            | Tolerance policy                                                                                                                 |
|-------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------|
| `orbstack-warm-latency`             | `service.ollama-warm-latency`                                                                                                                                                | ≤6 red days (burst traffic or LLM cold starts).                                                                                 |
| `log-rotation-last-7d`              | `loghyg.rotation-recent`, `loghyg.log-file-size`                                                                                                                             | ≤6 red days — rotation happens asynchronously, occasional slip is tolerable.                                                     |
| `pattern-confidence-nonzero`        | `selfheal.pattern-library-confidence`                                                                                                                                        | ≤6 red days — low-confidence patterns shouldn't block release, but sustained flatlining indicates learning loop is broken.      |
| `auto-os-cross-project-hit`         | Looks for any hit in `data.commit-coverage`/`data.file-coverage` detail that references `auto-os` with coverage ≥95%. Phase-6 addition — proves auto-os was re-ingested.      | ≤6 red days.                                                                                                                     |
| `ping-mem-doctor-exec-time-below-10s` | `durationMs` on the top-level JSONL record (not a gate, but derivable). Red if `durationMs > 10_000`.                                                                     | ≤6 red days.                                                                                                                     |

---

## Failure modes that reset the 30-day clock

- **Any HARD gate red ≥2 consecutive days** → reset `soak_start` to today, append event to `~/.ping-mem/soak-events.log`.
- Monitor script is idempotent — running it twice on the same day does not double-count.

## Acceptance arithmetic

```
days_green = (today - soak_start)  [bounded 0..30]

status =
  - "green"  if days_green >= 30 AND all hard gates currently pass AND soft-gate red-days <= 6
  - "red"    if any hard gate currently pass=false AND same gate was red yesterday (consecutive red)
  - "yellow" otherwise (ramp-up, or single-day red, or soft-gate red-days in 3..6 range)
```

At day 30 all-green, the monitor prints `CONGRATULATIONS: 30-day soak clean` and exits 0.

---

## Evidence paths

| Artifact                                  | Purpose                                                                 |
|-------------------------------------------|-------------------------------------------------------------------------|
| `~/.ping-mem/doctor-runs/*.jsonl`         | Raw doctor runs — source of truth for gate pass/fail.                   |
| `~/.ping-mem/soak-state.json`             | Current soak state (streak counters, status, days_to_30).               |
| `~/.ping-mem/soak-events.log`             | Append-only log of clock resets and soft-gate exceedances.               |
| `~/Library/Logs/ping-mem-soak.log`        | launchd stdout — human-readable daily summary.                          |
| `~/Library/Logs/ping-mem-soak.err`        | launchd stderr.                                                         |
| `tests/regression/memory-sync-coverage.test.ts` | Independent verifier — can be run manually or in CI to cross-check. |
