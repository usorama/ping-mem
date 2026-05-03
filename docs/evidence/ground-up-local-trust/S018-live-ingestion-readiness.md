# S018 Live Ingestion Readiness And Honest Health

Generated: 2026-05-03T11:46:07Z

GitHub issue: https://github.com/usorama/ping-mem/issues/136

## Result

- `/health` returns `status=ok` with `neo4j=healthy` and `qdrant=healthy`.
- `/api/v1/codebase/projects?scope=registered` returns HTTP 200 with the approved registered roots:
  `/projects/vunderstory` and `/projects/codex-corpus`.
- `/Users/umasankr/.codex/bin/ping-mem-codex codebase projects --scope registered --json`
  exits 0 and returns the same two roots.
- Live scorecard regenerated at `docs/evidence/ground-up-local-trust/capability-scorecard-live/`
  with `54/54` metrics passing.

## Honest Health Guardrail

`probeSystemHealth()` now degrades the overall health snapshot when `NEO4J_URI`
or `QDRANT_URL` declares a dependency but the matching runtime client is not
wired. SQLite-only deployments still report `ok` when only SQLite is configured.

## Verification

- `bun test src/observability/__tests__/health-probes.test.ts`
- `bun test src/http/__tests__/rest-api-new-routes.test.ts`
- `node --check scripts/capability-scorecard.mjs`
- `node scripts/capability-scorecard.mjs --live --out-dir=docs/evidence/ground-up-local-trust/capability-scorecard-live`
- `bun run typecheck`
