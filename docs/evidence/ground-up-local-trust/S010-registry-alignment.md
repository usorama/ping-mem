# S010 Runtime Project Registry Alignment

## Outcome

S010 is complete. Static code surfaces are aligned and live runtime proof now agrees across REST and agent CLI.

## Implemented Alignment

- REST `/api/v1/codebase/projects` already defaults to `scope=registered` and forwards explicit `scope=all`.
- `codebase projects` now forwards `scope=registered` by default and accepts `--scope all`.
- `agent codebase projects --scope registered --json` now calls `/api/v1/codebase/projects?scope=registered&limit=1000`.
- UI ingestion view now loads registered project rows from `ingestionService.listProjects({ scope: "registered" })`.
- UI reingest authorization now fail-closes against the same runtime registered-project inventory instead of reading `~/.ping-mem/registered-projects.txt` directly.

## Verification Completed

```bash
rg -n 'registered-projects|scope=registered|codebase/projects|~/.ping-mem/registered-projects.txt' src scripts docs
bun test src/ingest/__tests__/registered-projects.test.ts src/ingest/__tests__/IngestionService.list-projects.test.ts src/http/__tests__/rest-api-new-routes.test.ts src/http/ui/__tests__/ingestion.test.ts
bun test src/cli/__tests__/agent-trust.test.ts
bun run typecheck
```

Targeted tests passed with `56 pass` for S010 registry/UI coverage, `9 pass` for the agent CLI helper, and typecheck passed.

## Live Runtime Proof

```bash
curl -sf 'http://localhost:3003/api/v1/codebase/projects?scope=registered&limit=1000'
bun run src/cli/index.ts agent codebase projects --scope registered --json
```

Live runtime proof passed:

- REST curl exit: `0`
- Agent CLI exit: `0`
- Agent CLI status: `available`
- Runtime target: `http://localhost:3003`
- Registered-project denominator: `3`
- Registered projects: `/projects/vunderstory`, `/projects/ping-learn`, `/projects/ping-learn-mobile`

Command evidence is stored in:

- `docs/evidence/ground-up-local-trust/S010-registry-alignment/rest-projects.json`
- `docs/evidence/ground-up-local-trust/S010-registry-alignment/rest-projects.exit`
- `docs/evidence/ground-up-local-trust/S010-registry-alignment/agent-codebase-projects.json`
- `docs/evidence/ground-up-local-trust/S010-registry-alignment/agent-codebase-projects.exit`

## Allowed Claim

Allowed: active REST, CLI, agent CLI, and UI ingestion/status surfaces are aligned to the same live runtime registered-project denominator.

## Downstream Impact

S007 and S008 can now use this live runtime registered-project denominator as their starting proof set.
