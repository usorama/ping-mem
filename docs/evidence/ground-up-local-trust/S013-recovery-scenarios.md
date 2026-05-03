# S013 Recovery Scenarios

## Outcome

S013 is complete for the approved local recovery scenarios that can run in-session without a Mac sleep/reboot. Sleep/wake and reboot/login are recorded as `not-run-HITL` because they require a scheduled user-controlled machine event.

## Scenario Matrix

| Scenario | Result | Detection | Recovery / blocker | Evidence |
|---|---|---|---|---|
| ping-mem REST restart | passed | `RUNTIME_UNAVAILABLE` at first detection poll after controlled stop | healthy at recovery poll 1 after start | `S013-logs/rest-restart/` |
| Neo4j restart | passed | `neo4j: unhealthy` at first detection poll after controlled stop | `neo4j: healthy` at recovery poll 6 | `S013-logs/neo4j-stop-start/` |
| Qdrant restart | passed | `qdrant: unhealthy` at detection poll 4 | `qdrant: healthy` at recovery poll 9 | `S013-logs/qdrant-stop-start/` |
| Docker/OrbStack unavailable simulation | passed | unavailable REST target returns `RUNTIME_UNAVAILABLE` | no Docker/OrbStack auto-start or repair attempted | `S013-logs/docker-unavailable/` |
| Auth/config drift simulation | passed | unauthorized proof returns `UNAUTHORIZED` | no secrets recreated; `repairsAttempted: false` | `S013-logs/auth-config-drift/` |
| launchd/watchdog stale state | passed | all known `com.ping-mem.*` labels return `launchctl print` exit `113`; top-level plists count is `0` | hidden jobs remain disabled per S012 rollback evidence | `S013-logs/launchd-stale/` |
| Mac sleep/wake | not-run-HITL | requires user-controlled sleep/wake window | blocked until scheduled | this report |
| Mac reboot/login | not-run-HITL | requires user-controlled reboot/login window | blocked until scheduled | this report |

## Final Runtime State

```bash
curl -sf http://localhost:3003/health
docker ps --format '{{.Names}} {{.Status}}'
```

Final health:

- `sqlite`: healthy
- `neo4j`: healthy
- `qdrant`: healthy
- `diagnostics`: healthy

Final containers:

- `ping-mem`: healthy
- `ping-mem-neo4j`: running/healthy
- `ping-mem-qdrant`: running/healthy

## Verification

```bash
bun test src/observability src/doctor src/cli
bun run typecheck
```

Results:

- Targeted tests: `94 pass`, `0 fail`
- Typecheck: passed

## Safety Notes

- The read-only status command did not repair, restart, recreate secrets, or re-enable LaunchAgents.
- Container restart actions were explicit S013 triggers.
- Docker/OrbStack unavailable was simulated through an unreachable REST URL rather than stopping the local Docker engine.
- Sleep/wake and reboot/login are not silently claimed.

## Allowed Claim

Allowed: ping-mem REST, Neo4j, Qdrant, Docker-unavailable simulation, auth/config drift simulation, and stale LaunchAgent state have bounded recovery or actionable blocker evidence.

Blocked broader claim: sleep/wake and reboot/login remain unproven until a scheduled HITL machine-event run.
