---
id: S016
title: "Optional later MCP proxy re-adoption"
type: HITL
status: blocked
parent: "/Users/umasankr/Projects/ping-mem/docs/architecture/2026-04-29-ground-up-local-trust-rebuild.md"
blocked_by: ["S015"]
tracks: ["OBJ-8", "OUT-8", "CAP-2", "CAP-8", "FR-12", "AC-11", "AC-12", "ADR-004", "ADR-009", "ADR-012", "ADR-013"]
---

## What to build

Optionally re-adopt the MCP proxy as a second-stage convenience adapter only after the CLI trust spine passes, proving REST ownership, auth, identity forwarding, no direct DB mode, no auto-repair, active-process cleanliness, and rollback.

## Scope boundaries

- Owned surfaces: `src/mcp/proxy-cli.ts`, MCP config templates, proxy identity/auth tests, optional machine-local config backup/update plan.
- Out of scope: first trust spine, direct MCP DB mode re-adoption, OpenCode/Cursor/all-agent rollout.
- Architecture/context updates required: explicit human approval is required before enabling MCP proxy in Codex or Claude configs.

## Traceability

- Objectives: OBJ-8
- Outcomes: OUT-8
- Capabilities: CAP-2, CAP-8
- User stories: US-10
- Functional requirements: FR-12
- Non-functional requirements: NFR-5, NFR-6, NFR-8
- Acceptance criteria: AC-11, AC-12
- Architecture decisions: ADR-004, ADR-009, ADR-012, ADR-013

## Acceptance criteria

- [x] CLI-first S015 is complete before this optional slice starts.
- [ ] Proxy talks only to REST `/api/v1/tools/:name/invoke` and never imports direct DB/service state for approved paths.
- [ ] Proxy forwards or preserves project/agent/session identity for stateful tool calls.
- [ ] Proxy startup reports unavailable runtime without `docker compose up` or hidden repair.
- [ ] Doctor/status readiness proves authenticated REST tool invocation and identity, not direct binary presence.

## Definition of done

- [x] Deterministic outcome: MCP proxy is either safely re-adopted as optional convenience or remains quarantined with evidence.
- [ ] Required code/docs/tests produced: proxy identity/auth/no-auto-repair tests, config diff, rollback instructions. Not run because MCP re-adoption is not approved.
- [ ] Required verification run with exact command(s): proxy proof and active process checks below. Not run because MCP re-adoption is not approved.
- [x] Required evidence attached: proxy re-adoption report.

## Verification

- [ ] Structural check command: `rg -n 'tryStartDocker|docker compose|proxyToolCall|currentSessionId|X-Session-ID|PING_MEM_REST_URL|dist/mcp/cli' src/mcp src/doctor docs scripts`
- [ ] Automated test command: `bun test src/mcp/__tests__/proxy-cli.test.ts src/doctor src/http/__tests__/agent-rest.test.ts`
- [ ] Automated test command: `bun run typecheck`
- [ ] Runtime/manual proof steps: `PING_MEM_REST_URL=http://127.0.0.1:9 bun run dist/mcp/proxy-cli.js` must fail unavailable without starting Docker.
- [ ] Runtime/manual proof steps: MCP proxy tool invocation proof with authenticated REST, explicit identity, and evidence bundle.
- [ ] Runtime/manual proof steps: `ps -axo pid,ppid,command | rg 'ping-mem/dist/mcp/proxy-cli|dist/mcp/proxy-cli|dist/mcp/cli'`
- [ ] PR-zero evidence required: report states MCP remains optional and cannot expand the final claim beyond proven Codex/Claude local paths.

## Evidence artifacts

- Artifact/path: `docs/evidence/ground-up-local-trust/S016-mcp-proxy-readoption.md`
- Command output: no-auto-repair negative proof, proxy identity proof, process inventory.

## Current blocker disposition

Blocked/deferred on 2026-05-01. User-approved scope is one Codex-first CLI tool,
not optional MCP proxy re-adoption. MCP remains quarantined and unclaimed.

## Stop conditions for `/to-execute`

- Stop if S015 is incomplete.
- Stop if the user has not approved optional MCP proxy re-adoption.
- Stop if proxy cannot forward identity without changing approved architecture or reintroducing direct DB mode.

## Blocked by

S015

## Rollout / rollback notes

Back up every modified MCP config first. If proxy proof fails, leave MCP quarantined and keep CLI-first re-adoption intact.
