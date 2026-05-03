---
id: S004
title: "Identity and project path safety"
type: AFK
status: done
parent: "/Users/umasankr/Projects/ping-mem/docs/architecture/2026-04-29-ground-up-local-trust-rebuild.md"
blocked_by: ["S002", "S003"]
tracks: ["OBJ-5", "OUT-5", "CAP-3", "FR-7", "FR-8", "AC-7", "AC-8", "ADR-005", "ADR-016"]
---

## What to build

Require approved stateful and codebase paths to carry explicit `agentId`, `projectDir` or project identity, and `sessionId` via `X-Session-ID` or a documented equivalent. Unsafe project paths and missing identity must fail with actionable errors.

## Scope boundaries

- Owned surfaces: REST validation, REST session/memory/codebase routes, CLI identity flags/session header behavior, path-safety parity tests.
- Out of scope: multi-user tenancy, OAuth, teams, broad role model, optional MCP proxy re-adoption.
- Architecture/context updates required: any relaxation of identity requirements must go to `/to-architect`.

## Traceability

- Objectives: OBJ-5
- Outcomes: OUT-5
- Capabilities: CAP-3
- User stories: US-7
- Functional requirements: FR-7, FR-8
- Non-functional requirements: NFR-2, NFR-3, NFR-4, NFR-5
- Acceptance criteria: AC-7, AC-8
- Architecture decisions: ADR-005, ADR-016

## Acceptance criteria

- [x] Approved session start rejects missing `agentId` and missing `projectDir` in approved mode.
- [x] Approved memory calls reject missing `X-Session-ID` or equivalent instead of using `currentSessionId` fallback as proof.
- [x] Approved codebase calls reject missing or unsafe `projectDir` consistently across REST and CLI.
- [x] Positive tests prove `codex-local` and `claude-code-local` identity on safe project roots.

## Definition of done

- [x] Deterministic outcome: every approved path is tied to the right agent, session, and project, or fails loudly.
- [x] Required code/docs/tests produced: validation changes, CLI/header behavior, negative and positive tests.
- [x] Required verification run with exact command(s): targeted tests and CLI negative proofs below.
- [x] Required evidence attached: identity matrix and command output.

## Verification

- [x] Structural check command: `rg -n 'agentId|projectDir|X-Session-ID|currentSessionId|getSessionIdFromRequest|isProjectDirSafe' src/http src/cli src/client src/validation src/mcp`
- [x] Automated test command: `bun test src/http/__tests__/agent-rest.test.ts src/util/__tests__/path-safety.test.ts src/client/__tests__/rest-client.test.ts`
- [x] Automated test command: `bun run typecheck`
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts agent session start --agent codex-local --project /Users/umasankr/Projects/ping-mem --json`
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts agent session start --project /Users/umasankr/Projects/ping-mem --json` must fail with missing agent.
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts agent codebase verify --agent codex-local --project /etc --json` must fail with unsafe project.
- [x] PR-zero evidence required: scope delta names any legacy fallback retained for backward compatibility and proves it is not used by approved paths.

## Evidence artifacts

- Artifact/path: `docs/evidence/ground-up-local-trust/S004-identity-path-safety.md`
- Command output: positive and negative CLI/REST proof.

## Stop conditions for `/to-execute`

- Stop if approved mode cannot be separated from legacy fallback without product-scope change.
- Stop if safe-root policy would exclude the founder's intended local project roots; route to `/to-architect`.

## Blocked by

S002, S003

## Rollout / rollback notes

Rollback is normal git revert. Be careful not to break legacy routes without tests or an explicit deprecation path.

## Completion evidence

- Evidence artifact: `docs/evidence/ground-up-local-trust/S004-identity-path-safety.md`
- CLI JSON examples: `docs/evidence/ground-up-local-trust/S004-cli-json-examples/`
- Code: approved-path gates in `src/http/rest-server.ts`; CLI identity/path validation in `src/cli/agent-trust.ts` and `src/cli/commands/agent.ts`; schema updates in `src/validation/api-schemas.ts`.
- Tests: approved identity gates added to `src/http/__tests__/agent-rest.test.ts`; CLI validation coverage added to `src/cli/__tests__/agent-trust.test.ts`.
- Required tests: `54 pass, 0 fail`.
- Typecheck: `bun run typecheck` passed.

## Scope vs Promise Delta

S004 proves approved paths require explicit agent/project/session identity or fail loudly. Legacy `currentSessionId` fallback is retained for non-approved compatibility, but `X-Ping-Mem-Approved-Path: true` prevents approved proof from using it.

S004 does not prove live runtime health, memory lifecycle success, codebase grounding success, registry alignment, recovery, observability alignment, or re-adoption.
