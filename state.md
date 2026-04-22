# ping-mem — Project State

**Last updated**: 2026-04-22
**Phase**: deterministic capability closure in progress
**Source of truth**:
- `docs/plans/2026-04-22-fix-deterministic-capability-grounding-plan.md`
- `docs/plans/2026-04-22-deterministic-capability-execution-waves.md`
- umbrella issue `#133`

## Current reality

The earlier “8 of 8 phases closed / all green / merged remediation complete” story was overstated.

Current live OrbStack state is materially better and now trustworthy on the main runtime path:
- `/health` is `ok`
- `bun run doctor -- --json` is `34/34` green
- `bash scripts/test-all-capabilities.sh` is `54/54`
- `bash scripts/agent-path-audit.sh` is all green
- `bash scripts/mcp-smoke-test.sh` is `58/58`

Deterministic runtime capabilities now verified live:
- canonical 5-project ingestion coverage is back to `100%` commits and files
- registered continuity repos are reconciled in live state
- project-scoped ingestion identity is live
- low-memory Neo4j project deletion is live
- Python structural analysis is live
- diagnostics ingestion is idempotent
- default project inventory now returns the registered/canonical set only
- `scope=all` exposes stale/ad hoc project rows explicitly

## Wave status

### Wave 0
Grounding and scope freeze completed.

### Wave 1
Operational truth materially completed on the live service.
- health semantics, doctor behavior, SSE parity, restart persistence, and durability fixes are live

### Wave 2
State convergence materially completed for the live OrbStack path.
- `#114` closed
- `#132` closed
- `#134` closed
- canonical + registered-set ingestion state is reconciled
- stale project inventory no longer pollutes the default operator view

### Wave 3
Capability correctness and acceptance materially completed for the local deployed system.
- `#94` closed
- `#95` closed
- `#118` closed
- local regression/capability acceptance is green

### Wave 4
Declared-surface and deployment-parity work materially advanced.
- `#96`, `#97`, `#98`, `#99`, `#101`, `#102`, `#121`, `#122` closed
- unified `/mcp` transport security/rate-limit parity is live
- periodic cognition and recall-miss consumer wiring are live

### Wave 5
Documentation truth is still being reconciled.
- active entry-point docs are mostly current
- `state.md` is now corrected
- older historical remediation documents remain historical artifacts, not current status

## Open issues that still matter

| Issue | Status | Why it is still open |
|-------|--------|----------------------|
| `#133` | open | umbrella tracking for final closure and remaining doc/external truth |
| `#126` | open | regression workflow file exists, but first green GitHub Actions run on the self-hosted runner is still external to this local repo state |

Open but not part of the current deterministic-closure path:
- `#116` multi-model second-opinion skill
- `#90` multi-user tenancy model

## What is still left

1. Final documentation reconciliation under `#133`
2. External GitHub runner activation and first green remote run for `#126`
3. Optional cleanup of stale unregistered project rows using:
   `bash scripts/reconcile-project-inventory.sh --delete`

## Operator notes

- Default project inventory:
  `GET /api/v1/codebase/projects`
  returns the registered/canonical set only.
- Full ingest history:
  `GET /api/v1/codebase/projects?scope=all`
  returns all ingested rows, including stale/ad hoc worktrees.
- Stale-row maintenance:
  `bash scripts/reconcile-project-inventory.sh`
  reports unregistered rows and supports `--delete`.

## Key verification commands

```bash
bun run doctor -- --json
bash scripts/test-all-capabilities.sh
bash scripts/agent-path-audit.sh
set -a && source .env && set +a && bash scripts/mcp-smoke-test.sh
set -a && source .env && set +a && bash scripts/verify-ingestion-coverage.sh
```
