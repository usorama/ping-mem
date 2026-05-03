# S012 LaunchAgent Hygiene

## Outcome

S012 is complete. The read-only status command exists, active LaunchAgents were classified, and the hidden write-capable launchd baseline was disabled after explicit user approval.

All six `com.ping-mem.*` LaunchAgents were backed up, moved out of the top-level LaunchAgents scan path, and booted out of the active user launchd domain.

## Read-Only Status Command

Command:

```bash
bun run src/cli/index.ts agent status --json --read-only --evidence-dir docs/evidence/ground-up-local-trust/S012-status
```

Result:

- Exit code: `0`
- Status: `available`
- Runtime health: `sqlite`, `neo4j`, `qdrant`, and `diagnostics` healthy
- Runtime target: `http://localhost:3003`
- Evidence: `docs/evidence/ground-up-local-trust/S012-status/status.json`

## LaunchAgent Inventory

Command:

```bash
find /Users/umasankr/Library/LaunchAgents -maxdepth 1 -name 'com.ping-mem*.plist' -print
```

Found six active user LaunchAgent plists:

| Label | State | Target | Target exists | Credentials | Write behavior | Logs | Rollback / action |
|---|---|---|---|---|---|---|---|
| `com.ping-mem.daemon` | disabled; `launchctl print` exit `113` | `bun run dist/cli/index.js daemon start --foreground` | yes | `PING_MEM_REST_URL` only | write-capable daemon/session tracking | `/Users/umasankr/Library/Logs/ping-mem-daemon.log` | backed up, moved to disabled dir, booted out |
| `com.ping-mem.doctor` | disabled; `launchctl print` exit `113` | `bun run dist/cli/index.js doctor --quiet` | yes | `PING_MEM_ADMIN_USER`; `PING_MEM_ADMIN_PASS` redacted in evidence | status job; writes doctor run output/logs | `/Users/umasankr/Library/Logs/ping-mem/doctor.log`, `.err` | backed up, moved to disabled dir, booted out |
| `com.ping-mem.periodic-cognition` | disabled; `launchctl print` exit `113` | `scripts/periodic-cognition.sh` | yes | `PING_MEM_ENV_FILE=.env` | write-capable cognition/memory job | `/Users/umasankr/Library/Logs/ping-mem/periodic-cognition.log`, `.err` | backed up, moved to disabled dir, booted out |
| `com.ping-mem.periodic-ingest` | disabled; `launchctl print` exit `113` | `scripts/periodic-ingest.sh` | yes | `PING_MEM_REST_URL` only | write-capable ingest job | `/Users/umasankr/Library/Logs/ping-mem/periodic-ingest.log`, `.err` | backed up, moved to disabled dir, booted out |
| `com.ping-mem.soak-monitor` | disabled; `launchctl print` exit `113` | `scripts/soak-monitor.sh` | yes | no secret env found | monitoring/log-writing job | `/Users/umasankr/Library/Logs/ping-mem/soak-monitor.log`, `.err` | backed up, moved to disabled dir, booted out |
| `com.ping-mem.system-ready` | disabled; `launchctl print` exit `113` | `scripts/system-ready.ts --touch-heartbeat` | yes | `PING_MEM_ADMIN_USER`; `PING_MEM_ADMIN_PASS` redacted in evidence | write-capable heartbeat/status job | `/Users/umasankr/Library/Logs/ping-mem/system-ready.log`, `.err` | backed up, moved to disabled dir, booted out |

Sanitized per-label `launchctl print` and plist excerpts are stored under:

```text
docs/evidence/ground-up-local-trust/S012-launchctl/
```

Reconciliation evidence is stored under:

```text
docs/evidence/ground-up-local-trust/S012-launchagent-reconciliation/
```

Machine-local backup directory:

```text
/Users/umasankr/Library/LaunchAgents/.ping-mem-backups/20260430-215056
```

Machine-local disabled directory:

```text
/Users/umasankr/Library/LaunchAgents/.ping-mem-disabled-20260430-215056
```

## Verification

```bash
rg -n 'system-ready|watchdog|recover|doctor|launchd|LaunchAgent|PING_MEM_ADMIN_PASS|ping-mem-dev-local' scripts config launchagents src docs
bun test src/cli src/doctor src/observability
bun run typecheck
```

Results:

- `bun test src/cli src/doctor src/observability`: `91 pass`, `0 fail`.
- `bun run typecheck`: passed.

## Reconciled Baseline

- Top-level `/Users/umasankr/Library/LaunchAgents/com.ping-mem*.plist` count: `0`
- Each known label returns `launchctl print` exit `113` with "Could not find service".
- Hidden write-capable recovery/maintenance jobs are disabled before S013 scenario proof.

## Allowed Claim

Allowed: read-only status proof, LaunchAgent classification, reversible backup, and clean launchd baseline are complete.

Still separate: S013 scenario recovery proof and S014 observability/doctor alignment.
