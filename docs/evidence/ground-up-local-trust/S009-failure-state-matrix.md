# S009 Failure-State Matrix

## Outcome

S009 is complete. Approved CLI/proof paths now emit distinct blocked JSON for negative states instead of returning empty success or attempting repair.

## Matrix

| Scenario | Command | Exit | JSON code | Layer | Repair attempted | Evidence |
|---|---|---:|---|---|---|---|
| Missing identity | `agent proof memory-lifecycle --project ...` | 2 | `MISSING_AGENT` | input | no | `S009-negative-samples/missing-identity.json` |
| Unavailable runtime | `PING_MEM_REST_URL=http://127.0.0.1:9 agent status --timeout-ms 1000` | 2 | `RUNTIME_UNAVAILABLE` | runtime | no | `S009-negative-samples/unavailable-runtime.json` |
| Unauthorized | `agent proof memory-lifecycle --simulate unauthorized` | 2 | `UNAUTHORIZED` | runtime | no | `S009-negative-samples/unauthorized.json` |
| Dependency down | `agent proof codebase-grounding --simulate dependency-down` | 2 | `DEPENDENCY_DOWN` | runtime | no | `S009-negative-samples/dependency-down.json` |
| Stale data | `agent proof codebase-grounding --simulate stale` | 2 | `STALE_DATA` | runtime | no | `S009-negative-samples/stale-data.json` |
| Missing data | `agent proof memory-lifecycle --simulate missing-data` | 2 | `MISSING_DATA` | runtime | no | `S009-negative-samples/missing-data.json` |
| Timeout | `agent proof codebase-grounding --simulate timeout --timeout-ms 1000` | 2 | `RUNTIME_TIMEOUT` | runtime | no | `S009-negative-samples/timeout.json` |

## Verification

```bash
bun test src/http src/cli src/mcp/__tests__/proxy-cli.test.ts src/observability
bun run typecheck
```

Results:

- Targeted tests: `353 pass`, `0 fail`
- Typecheck: passed

## Runtime Safety

The simulated proof states do not stop services, destroy credentials, restart Docker, create auth files, or mutate product data. Each simulated output includes `repairsAttempted: false`.

The unavailable-runtime sample uses an unreachable loopback target and proves read-only failure reporting. It does not attempt to start Docker or repair the runtime.

## Allowed Claim

Allowed: approved CLI/proof paths distinguish missing identity, unavailable runtime, unauthorized, dependency-down, stale data, missing data, and timeout as blocked JSON states with exit code `2`.

Blocked broader claims: recovery scenario behavior remains S013, and UI/doctor/log agreement remains S014.
