# S014 Observability And Doctor Alignment

## Outcome

S014 is complete. The active status surfaces now distinguish runtime health from broader doctor health, and the doctor no longer treats direct MCP binary/file presence as proxy readiness.

## Cross-Surface Matrix

| Surface | Evidence | Current result | Meaning |
|---|---|---|---|
| `/health` | `S014-status-samples/health.json`, `final-health.json` | `status=ok`; sqlite/neo4j/qdrant/diagnostics healthy | Runtime components are healthy |
| `agent status --read-only` | `S014-status-samples/agent-status.json` | `ok=true`, `status=available` | Approved REST status target is reachable without repair |
| `doctor --json --quiet` | `S014-status-samples/doctor.json` | `23/34 pass`, exit `2` | Broader status is not fully green because stale sync/regression gates fail |
| `/ui/health` | `S014-status-samples/ui-health.html` | shows `23/34 pass` and doctor failure rows | UI mirrors doctor instead of hiding failures |
| `/api/v1/observability/status` | `S014-status-samples/observability-status.json` | monitor running, active alerts empty at sample time | Alert monitor and runtime health agree at sample time |
| Logs | `S014-status-samples/app-logs-tail.txt` | dependency warnings recorded during recovery/doctor load | logs contain actionable source/layer names for transient dependency issues |

## Doctor Gate Change

Replaced the stale gate:

- Removed behavior: `service.mcp-proxy-stdio` passed if `ping-mem-mcp` or `dist/mcp/cli.js` existed.
- New behavior: `service.agent-approved-status` checks the approved REST status target and does not inspect direct MCP binaries, start Docker, or repair anything.

## Known Non-Green Doctor Rows

The live doctor run is intentionally not forced green:

- `data.sync-lag` fails because sync heartbeat/markers are stale.
- Several regression gates time out under the current doctor total budget.
- Data coverage gates skipped because their project list fetch did not complete inside the gate budget.

These are reported as doctor/UI failures, not hidden behind `/health`.

## Verification

```bash
bun test src/doctor src/observability src/http/ui src/http/__tests__/rest-api-new-routes.test.ts
bun run typecheck
curl -sf http://localhost:3003/health
bun run src/cli/index.ts doctor --json --quiet
curl -sf http://localhost:3003/ui/health
bun run src/cli/index.ts agent status --json --read-only
```

Results:

- Targeted tests: `158 pass`, `0 fail`
- Typecheck: passed
- Runtime health: `ok`
- Agent status: `available`
- Doctor/UI: not fully green, matching each other

## Allowed Claim

Allowed: runtime health, agent status, doctor, UI health, logs, and observability status now have explicit, non-contradictory evidence for the sampled state, and doctor no longer proves readiness through direct MCP binary presence.

Blocked broader claim: doctor is not fully green; stale sync and regression timeout remediation remain outside S014.
