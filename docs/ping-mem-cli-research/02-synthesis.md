# ping-mem CLI + REST API: Research Synthesis

**Date**: 2026-03-16
**Input**: `01-sdk-cli-patterns.md` (research), codebase audit of `src/http/rest-server.ts`, `src/mcp/PingMemServer.ts`, `src/cli.ts`
**Purpose**: Distill research findings into actionable constraints, measurable outcomes, architecture decisions, and gap analysis.

---

## 1. Founding Principles

These are non-negotiable constraints that govern every design decision in the CLI + REST API effort.

### FP-1: REST-First, MCP-Second

The REST API is the primary interface for all ping-mem functionality. MCP is a compatibility layer for AI coding assistants (Claude Code, Cursor) that wraps the same backend logic. Every new feature is built as a REST endpoint first; MCP tool registration follows as a thin adapter. This eliminates the current duplication where `RESTPingMemServer` and `PingMemServer` independently wire up the same backends.

**Rationale**: REST is universally accessible (curl, browsers, SDKs, CI pipelines). MCP is niche (4 clients as of March 2026). Building REST-first ensures the broadest reach while MCP remains supported.

### FP-2: CLI is a Thin Client (Zero Business Logic)

The `ping-mem` CLI binary contains zero business logic. Every command translates to exactly one REST API call. Argument parsing, output formatting, and auth token management are the only responsibilities of the CLI binary. If the server is unreachable, the CLI fails immediately with a connection error -- it never falls back to local computation.

**Rationale**: Supabase CLI, Vercel CLI, and GitHub CLI all follow this pattern. It ensures behavior parity across CLI, SDK, and web dashboard. It eliminates a class of bugs where CLI behavior diverges from API behavior.

### FP-3: OpenAPI Spec Auto-Generated from Code (Single Source of Truth)

The OpenAPI 3.1 specification is generated at build time from Hono route definitions using `@hono/zod-openapi`. The spec is never hand-edited. Route definitions use Zod schemas for request/response validation, and those same schemas drive the OpenAPI output. The spec is served at `/openapi.json` and published as a build artifact.

**Rationale**: Hand-maintained specs drift from implementation within weeks. Auto-generation from Zod schemas means the spec is always correct because it IS the validation layer. This is the same pattern Mem0 (FastAPI + auto-docs) and Hono's ecosystem recommend.

### FP-4: All 43 Tools Available as CLI Subcommands AND REST Endpoints

Every MCP tool registered in `PingMemServer.TOOLS` (currently 43 across 9 modules) has a corresponding REST endpoint and a CLI subcommand. No tool is MCP-only. The `/tools` discovery endpoint returns the full tool registry with schemas, and `/tools/:name/invoke` provides generic invocation for any tool.

**Rationale**: The 8-tool gap between MCP (43 tools) and REST (35 endpoints) is a feature parity bug. Users who access ping-mem via REST or CLI get a degraded experience compared to MCP users. Full parity eliminates this.

### FP-5: Shell Hooks Use Background Daemon (No Node.js Cold-Start Per Prompt)

Shell integration (`eval "$(ping-mem shell-hook zsh)"`) communicates with a long-running background daemon via Unix domain socket. The daemon is a persistent ping-mem REST server process. Shell hooks never spawn a new Node.js process per prompt -- they send lightweight messages to the daemon.

**Rationale**: Node.js cold-start is 50-150ms. zsh `precmd` hooks fire on every prompt. At 100ms per prompt, that is perceptible lag on every Enter keypress. The daemon pattern (used by direnv, zoxide, starship) amortizes startup cost to zero per prompt. The shell hook itself is a 2-line shell function that writes to a Unix socket.

### FP-6: SDKs Generated from OpenAPI (Not Hand-Written)

TypeScript and Python SDKs are machine-generated from the OpenAPI spec. TypeScript uses `hey-api/openapi-ts`. Python uses a thin manual wrapper initially (requests + dataclasses), with Fern generation when the API stabilizes. SDKs are never hand-written -- changes to the API automatically propagate to SDKs via the generation pipeline.

**Rationale**: Hand-written SDKs diverge from the API within one release cycle. Generated SDKs are always correct by construction. hey-api is used by Vercel and PayPal in production. The OpenAPI spec is the contract; SDKs are projections of that contract.

### FP-7: Single Port, Multiple Transports

ping-mem serves all transports (REST, SSE/MCP, Streamable HTTP) from a single port (default 3000). The current dual-port setup (MCP on 3000 via stdio, REST on 3003) is consolidated. Transport selection is via URL path (`/api/v1/*` for REST, `/sse` for SSE, `/mcp` for Streamable HTTP) or the `PING_MEM_TRANSPORT` environment variable for backward compatibility.

**Rationale**: Multiple ports complicate firewall rules, Docker networking, reverse proxy configs, and documentation. Every production-grade API server (Supabase, Vercel, GitHub) serves from a single port with path-based routing.

---

## 2. Measurable Outcomes

| Metric | Current State | Target | Measurement Method |
|--------|--------------|--------|-------------------|
| REST endpoint count | 35 | 43+ (full MCP parity + discovery) | `grep -c "app\.(get\|post\|put\|delete)" rest-server.ts` |
| CLI commands | 1 (`collect`) | 43+ (1:1 with tools) + 8 meta commands | `ping-mem --help \| wc -l` |
| OpenAPI spec | Does not exist | Auto-generated, 100% route coverage | `/openapi.json` returns valid spec; `openapi-diff` shows 0 undocumented routes |
| CLI startup time | N/A (no real CLI) | <20ms (Citty framework) | `time ping-mem --version` averaged over 10 runs |
| Shell hook latency | N/A | <5ms per prompt (daemon mode) | `time ping-mem shell-hook-send cd /path` via Unix socket |
| SDK type coverage | 0% (no SDK) | 100% of endpoints typed | Generated SDK compiles with `tsc --strict` and 0 `any` types |
| Tool discovery | MCP `ListTools` only | REST `/tools` + CLI `ping-mem tools list` | `curl /api/v1/tools \| jq length` returns 43+ |
| Port count | 2 (MCP: 3000, REST: 3003) | 1 (all on 3000) | `ss -tlnp \| grep ping-mem \| wc -l` |
| Test coverage (new code) | N/A | >90% line coverage on CLI + new endpoints | `bun test --coverage` |
| npm package publishable | No | Yes (`@ping-gadgets/ping-mem-cli`) | `npm pack --dry-run` succeeds |

---

## 3. Architecture Decision Records

### ADR-1: Citty over Commander.js for CLI Framework

**Status**: Accepted
**Context**: ping-mem needs a CLI framework for 43+ subcommands with TypeScript-first development, ESM module system, and fast startup for shell hook integration.
**Decision**: Use Citty (UnJS) as the CLI framework.
**Alternatives considered**:
- Commander.js: 0 deps, proven stability, but TypeScript support via DefinitelyTyped (not native). No shell completion.
- Yargs: 7 dependencies, 35ms startup. Middleware model is less intuitive than command-based.
- Oclif: 30+ dependencies, 85ms startup. Plugin system is overkill. Enterprise-grade complexity for a focused tool.
**Consequences**: Citty is v0.x -- if stability issues arise, Commander.js is the fallback with a 1-day migration effort (both use defineCommand/program patterns). Shell completions must be hand-implemented (Citty lacks built-in completion).

### ADR-2: Hono + @hono/zod-openapi for OpenAPI Generation

**Status**: Accepted
**Context**: ping-mem already uses Hono for the REST server. OpenAPI spec generation is needed for SDK generation and API documentation.
**Decision**: Adopt `@hono/zod-openapi` to define routes with Zod schemas and auto-generate the OpenAPI 3.1 spec.
**Alternatives considered**:
- Hand-written OpenAPI YAML: Drifts from implementation. Maintenance burden.
- Swagger JSDoc annotations: Comment-based, fragile, not type-safe.
- tsoa: Generates from TypeScript decorators. Requires Express/Koa, not compatible with Hono.
**Consequences**: Existing Hono routes must be migrated from plain `app.get()`/`app.post()` to `createRoute()` + `app.openapi()` pattern. This is the bulk of Phase 1 effort. Zod schemas already exist in `src/validation/api-schemas.ts` -- they are reused.

### ADR-3: hey-api/openapi-ts for TypeScript SDK Generation

**Status**: Accepted
**Context**: TypeScript developers (Claude Code users, VS Code extension authors) need a typed SDK for ping-mem.
**Decision**: Use `hey-api/openapi-ts` to generate the TypeScript SDK from the OpenAPI spec.
**Alternatives considered**:
- Stainless: Gold standard (OpenAI, Anthropic use it). Commercial, overkill for current stage.
- openapi-generator: 50+ language support but generates low-quality TypeScript (optional chaining issues, verbose).
- Hand-written SDK: Drifts from API. Maintenance burden.
**Consequences**: SDK is regenerated on every API change via CI. Consumers get type-safe methods, Zod runtime validation, and proper error types. Python SDK uses a manual thin wrapper initially (Fern later).

### ADR-4: Unix Socket Daemon for Shell Integration

**Status**: Accepted
**Context**: Shell hooks fire on every prompt. Node.js cold-start (50-150ms) is unacceptable per-prompt latency.
**Decision**: Shell hooks communicate with a background `ping-mem daemon` process via Unix domain socket at `~/.config/ping-mem/daemon.sock`.
**Alternatives considered**:
- Spawn new process per prompt: 50-150ms latency. Unacceptable.
- Compile to native binary (Bun compile): Reduces to ~20ms but still per-prompt overhead.
- HTTP localhost: Works but Unix socket has lower overhead (no TCP handshake) and no port conflicts.
**Consequences**: Daemon lifecycle management (start, stop, auto-restart) must be implemented. `ping-mem daemon start` runs as background process. Shell hook checks socket existence before sending. If daemon is down, hook is a no-op (graceful degradation).

### ADR-5: Dual-Layer API (Resource Routes + Generic Tool Invocation)

**Status**: Accepted
**Context**: Some consumers want clean REST resources (`/memories`, `/sessions`). Others (AI agents, MCP bridges) want generic tool invocation (`/tools/:name/invoke`).
**Decision**: Serve both layers from the same server. Resource routes are the primary API. Tool invocation is the escape hatch for programmatic/generic access.
**Alternatives considered**:
- Resource routes only: Forces AI agents to know specific endpoint shapes.
- Tool invocation only: Loses REST semantics (GET/POST/DELETE on resources). Not idiomatic REST.
**Consequences**: Tool invocation routes add ~50 lines of code. They delegate to the same handler logic as resource routes. No duplication of business logic.

### ADR-6: Versioned API Prefix `/api/v1/`

**Status**: Accepted (already partially implemented)
**Context**: 29 of 35 existing REST routes already use `/api/v1/` prefix. The remaining 6 (`/health`, `/static/*`) are unversioned by design. Future breaking changes need isolation.
**Decision**: All API routes use `/api/v1/` prefix. Infrastructure routes (`/health`, `/openapi.json`, `/static/*`) remain unversioned. When v2 is needed, v1 routes remain available with deprecation headers.
**Consequences**: No migration needed for existing routes. New routes follow the pattern.

---

## 4. Gap Analysis

### 4.1 MCP Tools vs REST Endpoints

**43 MCP tools** (from `PingMemServer.TOOLS`) vs **35 REST endpoints** (from `rest-server.ts`). The following 8+ MCP tools lack REST endpoint equivalents:

| MCP Tool | Module | REST Equivalent | Gap |
|----------|--------|----------------|-----|
| `context_query_relationships` | Graph | None | **MISSING** |
| `context_hybrid_search` | Graph | None | **MISSING** |
| `context_get_lineage` | Graph | None | **MISSING** |
| `context_query_evolution` | Graph | None | **MISSING** |
| `context_health` | Graph | `/health` (partial) | **MISSING** (graph-specific health) |
| `search_causes` | Causal | None | **MISSING** |
| `search_effects` | Causal | None | **MISSING** |
| `get_causal_chain` | Causal | None | **MISSING** |
| `trigger_causal_discovery` | Causal | None | **MISSING** |
| `memory_subscribe` | Memory | `/api/v1/events/stream` (partial) | **PARTIAL** (SSE exists but not subscribe/unsubscribe) |
| `memory_unsubscribe` | Memory | None | **MISSING** |
| `memory_compress` | Memory | None | **MISSING** |
| `worklog_record` | Worklog | None (only via diagnostics ingest) | **MISSING** |
| `worklog_list` | Worklog | None | **MISSING** |
| `diagnostics_list` | Diagnostics | None (only `latest` and `findings/:id`) | **MISSING** |
| `diagnostics_compare_tools` | Diagnostics | None | **MISSING** |
| `diagnostics_by_symbol` | Diagnostics | None | **MISSING** |
| `codebase_list_projects` | Codebase | None | **MISSING** |
| `project_delete` | Codebase | None | **MISSING** |

**Total gap: 19 tools without full REST parity** (not 8 as initially estimated -- the audit reveals a larger gap).

### 4.2 CLI State

| Capability | Current | Target |
|-----------|---------|--------|
| CLI binary | `dist/cli.js` -- single `collect` command with hand-rolled arg parser | Full CLI with 43+ tool subcommands via Citty |
| CLI framework | None (manual `parseArgs`) | Citty with `defineCommand` per tool |
| CLI auth | None | `ping-mem auth login` with API key stored in `~/.config/ping-mem/auth.json` |
| CLI config | None | `~/.config/ping-mem/config.json` with server URL, defaults |
| CLI output formats | `log.info()` only | `--json`, `--table`, `--quiet` |
| Shell completions | None | `ping-mem completions zsh/bash/fish` |
| npm package | `ping-mem` (monolith) | `@ping-gadgets/ping-mem-cli` (separate publishable package) |

### 4.3 API Infrastructure

| Capability | Current | Target |
|-----------|---------|--------|
| OpenAPI spec | Does not exist | Auto-generated via `@hono/zod-openapi` at `/openapi.json` |
| Tool discovery endpoint | None | `GET /api/v1/tools` (list), `GET /api/v1/tools/:name` (schema), `POST /api/v1/tools/:name/invoke` |
| API versioning | Implicit (`/api/v1/` on most routes) | Explicit on all routes, documented in OpenAPI spec |
| Request validation | Zod schemas exist in `src/validation/api-schemas.ts` | Same schemas wired into `@hono/zod-openapi` route definitions |
| SDK | None | TypeScript (hey-api/openapi-ts), Python (manual thin wrapper) |
| Port consolidation | MCP on stdio (spawned), REST on 3003 (or 3000 via PING_MEM_TRANSPORT) | Single port 3000 for all transports |

### 4.4 Shell Integration

| Capability | Current | Target |
|-----------|---------|--------|
| Shell hook | None | `eval "$(ping-mem shell-hook zsh)"` -- precmd hook, directory tracking |
| Daemon | None | `ping-mem daemon start/stop/status` -- Unix socket at `~/.config/ping-mem/daemon.sock` |
| Auto-context | None | Directory changes auto-captured, git branch tracked, project detected |
| Shell completions | None | Generated from OpenAPI spec tool/command names |

### 4.5 Server Architecture

```
CURRENT STATE:
┌────────────────────────────┐
│  MCP Server (stdio)        │ ← PingMemServer class
│  43 tools, 9 modules       │   Spawned by Claude Code
│  Owns its own backends     │
└────────────────────────────┘

┌────────────────────────────┐
│  REST Server (port 3003)   │ ← RESTPingMemServer class
│  35 endpoints              │   Separate Hono app
│  Owns its own backends     │   Duplicates backend wiring
└────────────────────────────┘

┌────────────────────────────┐
│  CLI (dist/cli.js)         │ ← Single "collect" command
│  1 command                 │   Imports backend directly
│  Embeds business logic     │   No REST API usage
└────────────────────────────┘

TARGET STATE:
┌────────────────────────────┐
│  REST API Server           │ ← Single Hono app, port 3000
│  /api/v1/* (43+ endpoints) │   OpenAPI spec at /openapi.json
│  /tools/:name/invoke       │   Tool discovery + invocation
│  /sse, /mcp (opt-in)       │   MCP as compatibility transport
│  Single backend wiring     │
└────────────────────────────┘
         ▲           ▲           ▲
         │           │           │
┌────────┤    ┌──────┤    ┌──────┤
│  CLI   │    │  SDK │    │  MCP │
│ Citty  │    │ gen  │    │ wrap │
│ thin   │    │ from │    │ over │
│ client │    │ spec │    │ REST │
└────────┘    └──────┘    └──────┘
         ▲
         │
┌────────┤
│ Shell  │
│ Hook   │ → Unix socket → daemon (= REST server)
└────────┘
```

---

## Sources

All findings derived from:
- `01-sdk-cli-patterns.md` -- primary research document (7 sections, 24 sources)
- Codebase audit: `src/http/rest-server.ts` (35 endpoints), `src/mcp/PingMemServer.ts` (43 tools), `src/cli.ts` (1 command)
- `src/mcp/handlers/*.ts` -- 9 tool modules with named exports
- `src/validation/api-schemas.ts` -- existing Zod schemas for request validation
- `package.json` -- 3 bin entries (`ping-mem`, `ping-mem-mcp`, `ping-mem-http`)
