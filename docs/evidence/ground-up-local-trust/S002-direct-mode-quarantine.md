# S002 Direct-Mode Quarantine Evidence

Issue: `S002-rest-runtime-ownership-and-direct-mode-quarantine`
Date: 2026-04-30
Repo: `/Users/umasankr/Projects/ping-mem`

## Outcome

S002 constrains approved proof to the REST-owned runtime boundary. Direct MCP and direct DB scripts still exist, but they are not accepted as local trust, recovery, doctor, or re-adoption proof.

The concrete S002 product change is that `scripts/agent-path-audit.sh` no longer counts direct MCP stdio tool discovery as a passing agent path. It now starts its audit through the REST owner at `/api/v1/tools`.

## Changed Guardrail

| Surface | Before | After | S002 disposition |
|---|---|---|---|
| `scripts/agent-path-audit.sh` path 1 | Spawned `bun run dist/mcp/cli.js` and counted tools from direct MCP stdio. | Calls `$BASE/api/v1/tools` and counts REST-owned tool schemas. | Approved proof path no longer opens direct MCP state. |
| `src/mcp/__tests__/proxy-cli.test.ts` | Verified proxy CLI has no direct DB imports. | Also verifies `agent-path-audit.sh` active lines use `/api/v1/tools` and do not use `dist/mcp/cli.js` or `ping-mem-mcp`. | Static regression guard for REST-owned proof. |

## Direct And Offline Path Ledger

| Path | Evidence | Disposition after S002 | Remaining owner |
|---|---|---|---|
| `ping-mem-mcp` binary | `package.json:9` | `offline-dev-only`; not accepted for live agent trust or re-adoption proof. | S011/S016 for docs/proxy re-adoption cleanup. |
| `start:mcp` | `package.json:41` | `offline-dev-only`; direct MCP still exists but cannot prove product trust. | S011/S016. |
| `src/mcp/PingMemServer.ts` direct server | direct server source exists | `offline-dev-only`; direct server is not the runtime owner. | S016 only if optional MCP path is later re-adopted through REST/proxy proof. |
| `scripts/direct-ingest.ts` | direct Neo4j/Qdrant/IngestionService path | `offline-dev-only`; not an acceptance, recovery, doctor, or agent proof command. | S011/S012 for operator docs/recovery hygiene. |
| `scripts/force-ingest.ts` | direct IngestionService path | `offline-dev-only`; not an acceptance, recovery, doctor, or agent proof command. | S011/S012. |
| `scripts/reindex-qdrant.ts` | direct Qdrant path | `offline-dev-only`; not an acceptance, recovery, doctor, or agent proof command. | S011/S012. |
| `scripts/migrate-from-memory-keeper.ts` | opens EventStore directly | `offline-dev-only`; not accepted as live trust proof. | S011/S012. |
| `scripts/agent-path-audit.sh` | changed in S002 | REST-owned proof path; no active direct MCP check remains. | S003-S010 for CLI/identity/capability proof expansion. |
| `src/doctor/gates/service.ts` `service.mcp-proxy-stdio` | still checks `ping-mem-mcp` / `dist/mcp/cli.js` presence | blocked as product-trust proof; S002 did not claim doctor alignment. | S014. |
| Active docs/static UI direct-mode guidance | `rg` output still finds docs/static references | blocked from re-adoption proof. | S011/S014. |

## Command Evidence

### Required structural check

Command:

```bash
rg -n 'dist/mcp/cli|ping-mem-mcp|start:mcp|direct-ingest|force-ingest|reindex-qdrant|migrate-from-memory-keeper' package.json scripts src docs README.md CLAUDE.md AGENT_INSTRUCTIONS.md
```

Result summary:

- Direct MCP/package surfaces still exist in `package.json`, README/CLAUDE docs, historical docs, installer docs, and static UI.
- Direct maintenance scripts still exist: `direct-ingest.ts`, `force-ingest.ts`, `reindex-qdrant.ts`, `migrate-from-memory-keeper.ts`.
- `scripts/agent-path-audit.sh` no longer appears in the direct MCP hits for active use of `dist/mcp/cli.js`; only S001 historical evidence and issue docs still mention the old state.
- `src/doctor/gates/service.ts` still treats direct MCP presence as a pass; this remains assigned to S014.

### Targeted tests

Command:

```bash
bun test src/mcp/__tests__/PingMemServer.test.ts src/mcp/__tests__/proxy-cli.test.ts src/storage/__tests__/EventStore.test.ts
```

Result:

```text
63 pass
0 fail
336 expect() calls
Ran 63 tests across 3 files.
```

New S002 assertion:

```text
approved agent proof paths - REST-owned runtime only > agent-path audit should discover tools through REST instead of direct MCP
```

### Typecheck

Command:

```bash
bun run typecheck
```

Result: passed with `tsc --noEmit`.

### Shell/static hygiene

Commands:

```bash
bash -n scripts/agent-path-audit.sh
git diff --check
rg -n 'dist/mcp/cli\.js|ping-mem-mcp' scripts/agent-path-audit.sh src/mcp/__tests__/proxy-cli.test.ts
```

Results:

- `bash -n` passed.
- `git diff --check` passed.
- The only `ping-mem-mcp` / `dist/mcp/cli.js` hit in the checked files is the negative test assertion in `src/mcp/__tests__/proxy-cli.test.ts`.

### Live REST availability

Command:

```bash
curl -sS -m 3 http://localhost:3003/api/v1/tools | jq -r '.data.tools | length'
```

Result:

```text
curl: (7) Failed to connect to localhost port 3003
```

Interpretation: S002 proves the approved proof path boundary and regression guard. It does not prove the live runtime is healthy, memory lifecycle works, codebase grounding works, identity is complete, recovery is safe, or re-adoption is allowed.

## Scope vs Promise Delta

S002 proves:

- REST is the only approved live owner for the agent audit proof path changed in this slice.
- Direct MCP and direct maintenance scripts remain classified as offline/dev or blocked for acceptance and re-adoption proof.
- A targeted test prevents `scripts/agent-path-audit.sh` from silently going back to direct MCP discovery.

S002 does not prove:

- The local REST runtime is currently healthy.
- Codex or Claude Code can perform memory lifecycle operations.
- Codebase verify/ingest/search/source anchors work.
- Agent/project/session identity is explicit.
- Doctor, UI, docs, LaunchAgents, or shell integration are truthful or safe.
- ping-mem can be re-adopted.

Next dependency openings after S002:

- S003 can build the unified CLI trust spine.
- S010 can align runtime project registry truth.
- S012 remains HITL because it touches recovery commands and LaunchAgents.
- S011 remains ready and owns active docs/operator/static UI quarantine.
