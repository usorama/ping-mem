# S008 Claude Code Codebase Grounding

## Outcome

S008 is complete for the approved local Claude Code path.

## Selected Repo

- User-facing project path: `/Users/umasankr/Projects/ping-mem`
- Runtime/container project path: `/projects/ping-mem`
- Runtime project ID: `15019a09f20ff71715da143bdfcfb72c87cfd845e162efd83eb61de592becffa`

## Runtime Proof

```bash
bun run src/cli/index.ts agent proof codebase-grounding --agent claude-code-local --project /Users/umasankr/Projects/ping-mem --json --evidence-dir docs/evidence/ground-up-local-trust/S008-claude-codebase
```

Result:

- Exit code: `0`
- Status: `available`
- Elapsed: `903ms`
- Ingest result: no changes after S007's current ingest
- Registered-project denominator: `3`
- Source anchor checked on disk: `/Users/umasankr/Projects/ping-mem/src/ingest/__tests__/registered-projects.test.ts:1`
- Timeline result count: `5`

Evidence:

- `docs/evidence/ground-up-local-trust/S008-claude-codebase/proof.json`
- `docs/evidence/ground-up-local-trust/S008-claude-codebase/proof.exit`

## Unsafe Path Proof

```bash
bun run src/cli/index.ts agent codebase verify --agent claude-code-local --project /etc --json
```

Result:

- Exit code: `2`
- Status: `blocked`
- Error code: `UNSAFE_PROJECT`
- Layer: `input`

Evidence:

- `docs/evidence/ground-up-local-trust/S008-claude-codebase/unsafe-project.json`
- `docs/evidence/ground-up-local-trust/S008-claude-codebase/unsafe-project.exit`

## Verification

S008 uses the S007-implemented proof command and the same test gate:

```bash
bun test src/cli/__tests__/agent-trust.test.ts src/http/__tests__/rest-api-new-routes.test.ts src/ingest/__tests__/IngestionService.list-projects.test.ts src/util/__tests__/path-safety.test.ts
bun run typecheck
```

Results:

- Targeted tests: `76 pass`, `0 fail`
- Typecheck: passed

## Allowed Claim

Allowed: Claude Code codebase grounding works for the selected local ping-mem repo through the approved REST CLI path, including verify, ingest/no-change, search, timeline, runtime registered inventory, and disk-checked source anchors.

Not claimed: all repos, all languages, Codex grounding beyond S007, or MCP/proxy re-adoption.
