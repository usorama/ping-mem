# S004 Identity And Project Path Safety Evidence

Issue: `S004-identity-and-project-path-safety`
Date: 2026-04-30
Repo: `/Users/umasankr/Projects/ping-mem`

## Outcome

S004 separates approved agent proof from legacy fallback behavior. Approved paths now require explicit agent and project identity, approved memory writes require `X-Session-ID`, and unsafe project paths fail before runtime work.

Legacy REST fallback remains for backward compatibility, but it is not accepted for Codex/Claude trust proof or re-adoption.

## Identity Matrix

| Path | Required identity | S004 behavior |
|---|---|---|
| REST approved session start | `X-Ping-Mem-Approved-Path: true`, body `agentId`, body `projectDir` | Missing `agentId` or `projectDir` returns 400; safe `codex-local` and `claude-code-local` starts pass in tests. |
| REST approved memory save | `X-Ping-Mem-Approved-Path: true`, `X-Session-ID` | Missing `X-Session-ID` returns 400 before fallback. |
| REST approved codebase verify | `X-Ping-Mem-Approved-Path: true`, body `agentId`, safe body `projectDir` | Missing agent fails; unsafe `/etc` returns 403 before ingestion service work. |
| CLI approved session start | `--agent`, `--project` | Missing agent returns JSON `MISSING_AGENT`; safe project reaches REST boundary. |
| CLI approved codebase verify | `--agent`, `--project` | Unsafe `/etc` returns JSON `UNSAFE_PROJECT` before network call. |
| CLI memory lifecycle dry-run | `--agent`, `--project`, `--dry-run` | Reuses same identity/path validation before producing dry-run plan. |

## Command Evidence

Structural check:

```bash
rg -n 'agentId|projectDir|X-Session-ID|currentSessionId|getSessionIdFromRequest|isProjectDirSafe' src/http src/cli src/client src/validation src/mcp
```

Result summary: identity, session header, fallback, and path-safety surfaces are present across REST, CLI, client SDK, validation schemas, and MCP. S004-owned changes are in `src/http/rest-server.ts`, `src/validation/api-schemas.ts`, `src/cli/agent-trust.ts`, `src/cli/commands/agent.ts`, and tests.

Automated tests:

```bash
bun test src/http/__tests__/agent-rest.test.ts src/util/__tests__/path-safety.test.ts src/client/__tests__/rest-client.test.ts
```

Result:

```text
54 pass
0 fail
131 expect() calls
Ran 54 tests across 3 files.
```

Additional CLI/client regression:

```bash
bun test src/cli src/client
```

Result:

```text
34 pass
0 fail
92 expect() calls
Ran 34 tests across 4 files.
```

Typecheck:

```bash
bun run typecheck
```

Result: passed with `tsc --noEmit`.

## CLI Proof Outputs

Artifacts:

- `docs/evidence/ground-up-local-trust/S004-cli-json-examples/session-start-codex.json`
- `docs/evidence/ground-up-local-trust/S004-cli-json-examples/session-start-codex.exit`
- `docs/evidence/ground-up-local-trust/S004-cli-json-examples/session-start-missing-agent.json`
- `docs/evidence/ground-up-local-trust/S004-cli-json-examples/session-start-missing-agent.exit`
- `docs/evidence/ground-up-local-trust/S004-cli-json-examples/codebase-verify-unsafe.json`
- `docs/evidence/ground-up-local-trust/S004-cli-json-examples/codebase-verify-unsafe.exit`

Observed results:

- Safe Codex session start accepted identity locally, then returned `RUNTIME_UNAVAILABLE` and exit `2` because `localhost:3003` is down.
- Missing agent returned `MISSING_AGENT` and exit `2` before network access.
- Unsafe `/etc` codebase verify returned `UNSAFE_PROJECT` and exit `2` before network access.

## Scope vs Promise Delta

S004 proves:

- Approved REST and CLI paths have an explicit identity gate.
- Approved memory proof cannot rely on `currentSessionId` fallback when `X-Session-ID` is absent.
- Approved codebase proof rejects unsafe project roots consistently at the REST and CLI boundary.
- Positive REST tests prove `codex-local` and `claude-code-local` on a safe project root.

S004 does not prove:

- The live local runtime is healthy.
- Operational memory lifecycle succeeds.
- Codebase verify/ingest/search/source anchors succeed.
- Runtime registry truth is aligned.
- Recovery or observability is complete.
- Re-adoption is allowed.

Legacy fallback retained:

- `getSessionIdFromRequest` can still fall back to `currentSessionId` for non-approved legacy callers.
- This fallback is explicitly excluded from approved proof by `X-Ping-Mem-Approved-Path: true` tests and CLI behavior.
