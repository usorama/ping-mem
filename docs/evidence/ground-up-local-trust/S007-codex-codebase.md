# S007 Codex Codebase Grounding

## Outcome

S007 is complete for the approved local Codex path.

## Selected Repo

- User-facing project path: `/Users/umasankr/Projects/ping-mem`
- Runtime/container project path: `/projects/ping-mem`
- Runtime project ID: `15019a09f20ff71715da143bdfcfb72c87cfd845e162efd83eb61de592becffa`

The proof command keeps the local path as the caller contract and translates it to the runtime mount only inside the approved CLI proof.

## Runtime Proof

```bash
bun run src/cli/index.ts agent proof codebase-grounding --agent codex-local --project /Users/umasankr/Projects/ping-mem --json --evidence-dir docs/evidence/ground-up-local-trust/S007-codex-codebase
```

Result:

- Exit code: `0`
- Status: `available`
- Elapsed: `278423ms`
- Ingest result: `554` files, `2195` chunks, `206` commits
- Registered-project denominator: `3`
- Source anchor checked on disk: `/Users/umasankr/Projects/ping-mem/src/ingest/__tests__/registered-projects.test.ts:1`
- Timeline result count: `5`

Evidence:

- `docs/evidence/ground-up-local-trust/S007-codex-codebase/proof.json`
- `docs/evidence/ground-up-local-trust/S007-codex-codebase/proof.exit`

## Unsafe Path Proof

```bash
bun run src/cli/index.ts agent codebase verify --agent codex-local --project /etc --json
```

Result:

- Exit code: `2`
- Status: `blocked`
- Error code: `UNSAFE_PROJECT`
- Layer: `input`

Evidence:

- `docs/evidence/ground-up-local-trust/S007-codex-codebase/unsafe-project.json`
- `docs/evidence/ground-up-local-trust/S007-codex-codebase/unsafe-project.exit`

## Verification

```bash
bun test src/cli/__tests__/agent-trust.test.ts src/http/__tests__/rest-api-new-routes.test.ts src/ingest/__tests__/IngestionService.list-projects.test.ts src/util/__tests__/path-safety.test.ts
bun run typecheck
```

Results:

- Targeted tests: `76 pass`, `0 fail`
- Typecheck: passed

## Allowed Claim

Allowed: Codex codebase grounding works for the selected local ping-mem repo through the approved REST CLI path, including verify, ingest, search, timeline, runtime registered inventory, and disk-checked source anchors.

Not claimed: all repos, all languages, Claude Code grounding, or MCP proxy grounding.
