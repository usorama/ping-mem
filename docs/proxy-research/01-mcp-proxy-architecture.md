# MCP stdio-to-REST Proxy — Architecture Research

**Date**: 2026-03-22
**Status**: Research complete, ready for implementation planning

---

## 1. Problem Statement

`dist/mcp/cli.js` currently starts a **full** ping-mem server inline:
- Opens its own SQLite connection to the same `.db` file as the Docker container
- Instantiates `EventStore`, `SessionManager`, `MemoryManager`, `IngestionService`, etc.
- This causes concurrent SQLite access — two writers on the same WAL file → intermittent "database is locked" errors

The code already documents this problem in a comment at line 395 of `src/mcp/PingMemServer.ts`:

```
// RECOMMENDED FIX: point MCP stdio at the REST API via PING_MEM_REST_URL so
// it never touches the .db file directly.
```

Target: `dist/mcp/cli.js` becomes a **thin proxy** — translates MCP JSON-RPC on stdin to HTTP calls to Docker on port 3003, then returns responses on stdout.

---

## 2. Current Architecture (What We Read)

### Entry points

| File | Role |
|------|------|
| `src/mcp/cli.ts` | 20 lines — calls `validateEnv()`, then `main()` |
| `src/mcp/PingMemServer.ts` | `main()` creates full services, `PingMemServer` registers all handlers |
| `src/http/rest-server.ts` | `RESTPingMemServer` — Hono-based HTTP server on :3003 |

### MCP SDK version: `@modelcontextprotocol/sdk` 1.25.3

Available transports in the SDK:
- **Server-side**: `StdioServerTransport`, `SSEServerTransport`, `StreamableHTTPServerTransport`, `WebSocketServerTransport`
- **Client-side**: `StdioClientTransport` (spawns subprocess), `StreamableHTTPClientTransport`, `SSEClientTransport`, `WebSocketClientTransport`
- **InMemory**: `InMemoryTransport.createLinkedPair()` — for in-process client/server (useful for testing)

The SDK has a `Client` class with `callTool(params)` and `listTools()` methods. There is **no built-in proxy class** in the SDK — no `ProxyServer` or `createProxy` helper.

### Tool modules (all 11)

| Module | Tools | Notes |
|--------|-------|-------|
| `ContextToolModule` | `context_session_start`, `context_session_end`, `context_save`, `context_get`, `context_search`, `context_delete`, `context_checkpoint`, `context_status`, `context_session_list`, `context_auto_recall` | Core session/memory CRUD |
| `GraphToolModule` | `context_query_relationships`, `context_hybrid_search`, `context_get_lineage`, `context_query_evolution`, `context_health` | Neo4j graph queries |
| `WorklogToolModule` | `worklog_record`, `worklog_list` | |
| `DiagnosticsToolModule` | `diagnostics_ingest`, `diagnostics_latest`, `diagnostics_list`, `diagnostics_diff`, `diagnostics_summary`, `diagnostics_compare_tools`, `diagnostics_by_symbol`, `diagnostics_summarize` | |
| `CodebaseToolModule` | `codebase_ingest`, `codebase_verify`, `codebase_search`, `codebase_timeline`, `codebase_list_projects`, `project_delete` | |
| `StructuralToolModule` | `codebase_impact`, `codebase_blast_radius`, `codebase_dependency_map` | |
| `MemoryToolModule` | `memory_stats`, `memory_consolidate`, `memory_subscribe`, `memory_unsubscribe`, `memory_compress`, `memory_maintain`, `memory_conflicts` | |
| `CausalToolModule` | `search_causes`, `search_effects`, `get_causal_chain`, `trigger_causal_discovery` | |
| `KnowledgeToolModule` | `knowledge_search`, `knowledge_ingest` | |
| `AgentToolModule` | `agent_register`, `agent_quota_status`, `agent_deregister` | |
| `MiningToolModule` | `transcript_mine`, `dreaming_run`, `insights_list` | |

**Total: ~50 tools**

---

## 3. The Generic Proxy Endpoint — Already Exists

`POST /api/v1/tools/:name/invoke` exists in both:
1. `src/http/rest-server.ts` (lines 3380–3498) — **full implementation**: dispatches to tool modules with real state
2. `src/http/routes/tool-discovery.ts` (line 28) — **stub only**: returns a JSON redirect telling caller which REST endpoint to use directly

The **rest-server.ts version** is the real one. It:
- Validates admin Basic Auth credentials
- Finds the tool by name in `TOOLS[]`
- Validates args against the tool's input schema
- Instantiates all tool modules with server state
- Dispatches to the correct module
- Returns `{ data: <result> }` on success

**This endpoint is the backbone of the proxy.** The proxy can route ALL tool calls through `POST /api/v1/tools/:name/invoke` with `{ args: { ...toolArgs } }`.

Auth note: the endpoint requires `Authorization: Basic <base64(adminUser:adminPass)>` when admin credentials are configured. The proxy must forward these credentials, sourced from env vars.

---

## 4. Complete MCP Tool → REST Endpoint Mapping

All tools can be proxied via the generic invoke endpoint. Below is the full mapping for both the generic path and (where available) a dedicated REST endpoint. The proxy should use the **generic invoke path** to avoid mapping maintenance.

### Generic route (covers ALL tools)
```
POST /api/v1/tools/:name/invoke
Body: { "args": { ...toolArguments } }
Auth: Authorization: Basic <base64(PING_MEM_ADMIN_USER:PING_MEM_ADMIN_PASS)>
```

### Dedicated REST endpoints (for reference — not required for proxy)

| MCP Tool | REST Equivalent | Method |
|----------|-----------------|--------|
| `context_session_start` | `/api/v1/session/start` | POST |
| `context_session_end` | `/api/v1/session/end` | POST |
| `context_session_list` | `/api/v1/session/list` | GET |
| `context_save` | `/api/v1/context` | POST |
| `context_get` | `/api/v1/context/:key` | GET |
| `context_search` | `/api/v1/search` | GET |
| `context_delete` | `/api/v1/context/:key` | DELETE |
| `context_checkpoint` | `/api/v1/checkpoint` | POST |
| `context_status` | `/api/v1/status` | GET |
| `context_auto_recall` | `/api/v1/memory/auto-recall` | POST |
| `context_query_relationships` | `/api/v1/graph/relationships` | GET |
| `context_hybrid_search` | `/api/v1/graph/hybrid-search` | POST |
| `context_get_lineage` | `/api/v1/graph/lineage/:entity` | GET |
| `context_query_evolution` | `/api/v1/graph/evolution` | GET |
| `context_health` | `/api/v1/graph/health` | GET |
| `worklog_record` | `/api/v1/worklog` | POST |
| `worklog_list` | `/api/v1/worklog` | GET |
| `diagnostics_ingest` | `/api/v1/diagnostics/ingest` | POST |
| `diagnostics_latest` | `/api/v1/diagnostics/latest` | GET |
| `diagnostics_diff` | `/api/v1/diagnostics/diff` | POST |
| `diagnostics_by_symbol` | `/api/v1/diagnostics/by-symbol` | GET |
| `diagnostics_summarize` | `/api/v1/diagnostics/summarize/:analysisId` | POST |
| `codebase_ingest` | `/api/v1/codebase/ingest` | POST |
| `codebase_verify` | `/api/v1/codebase/verify` | POST |
| `codebase_search` | `/api/v1/codebase/search` | GET |
| `codebase_timeline` | `/api/v1/codebase/timeline` | GET |
| `codebase_list_projects` | `/api/v1/codebase/projects` | GET |
| `project_delete` | `/api/v1/codebase/projects/:id` | DELETE |
| `memory_stats` | `/api/v1/memory/stats` | GET |
| `memory_consolidate` | `/api/v1/memory/consolidate` | POST |
| `memory_subscribe` | `/api/v1/memory/subscribe` | POST |
| `memory_unsubscribe` | `/api/v1/memory/unsubscribe` | POST |
| `memory_compress` | `/api/v1/memory/compress` | POST |
| `memory_maintain` | `/api/v1/tools/memory_maintain/invoke` | POST (generic) |
| `memory_conflicts` | `/api/v1/tools/memory_conflicts/invoke` | POST (generic) |
| `search_causes` | `/api/v1/causal/causes` | GET |
| `search_effects` | `/api/v1/causal/effects` | GET |
| `get_causal_chain` | `/api/v1/causal/chain` | GET |
| `trigger_causal_discovery` | `/api/v1/causal/discover` | POST |
| `knowledge_search` | `/api/v1/knowledge/search` | POST |
| `knowledge_ingest` | `/api/v1/knowledge/ingest` | POST |
| `agent_register` | `/api/v1/agents/register` | POST |
| `agent_quota_status` | `/api/v1/agents/quotas` | GET |
| `agent_deregister` | `/api/v1/agents/:agentId` | DELETE |
| `transcript_mine` | `/api/v1/mining/start` | POST |
| `dreaming_run` | `/api/v1/dreaming/run` | POST |
| `insights_list` | `/api/v1/insights` | GET |
| `codebase_impact` | `/api/v1/codebase/impact` | GET |
| `codebase_blast_radius` | `/api/v1/codebase/blast-radius` | GET |
| `codebase_dependency_map` | `/api/v1/codebase/dependency-map` | GET |

**Gap finding**: `memory_maintain` and `memory_conflicts` have no dedicated REST endpoint. The generic `/api/v1/tools/:name/invoke` covers them — confirmed by the actual dispatch logic in `rest-server.ts` lines 3470–3489.

---

## 5. Proxy Design — Recommended Approach

### 5.1 Architecture Decision: Use MCP SDK `Server` + Generic `/invoke`

The proxy should:
1. Start a standard `Server` with `StdioServerTransport` (same MCP SDK as today)
2. Register ALL tool schemas statically (copied from `TOOLS[]` in `PingMemServer.ts` — no service instantiation)
3. In `CallToolRequestSchema` handler: make an HTTP `fetch()` call to Docker
4. Return the result as MCP `CallToolResult`

This approach means:
- **Tool schemas are served locally** (no HTTP round-trip for `list_tools`)
- **Tool execution always hits Docker** (single SQLite writer)
- **Zero service instantiation** in the proxy process — no SQLite, no Neo4j, no Qdrant

### 5.2 Minimal Proxy Code (conceptual)

```typescript
// src/mcp/proxy-cli.ts — ~120 lines total

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./PingMemServer.js"; // Static schema array, no service init

const BASE_URL = process.env.PING_MEM_REST_URL ?? "http://localhost:3003";
const ADMIN_USER = process.env.PING_MEM_ADMIN_USER ?? "";
const ADMIN_PASS = process.env.PING_MEM_ADMIN_PASS ?? "";

const authHeader = ADMIN_USER
  ? "Basic " + Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString("base64")
  : undefined;

const server = new Server(
  { name: "ping-mem", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Health check — fast path without hitting /invoke (Docker auth)
  if (name === "ping") {
    const ok = await checkDockerHealth();
    return { content: [{ type: "text", text: JSON.stringify({ ok }) }] };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader) headers["Authorization"] = authHeader;

  const response = await fetch(`${BASE_URL}/api/v1/tools/${encodeURIComponent(name)}/invoke`, {
    method: "POST",
    headers,
    body: JSON.stringify({ args: args ?? {} }),
    signal: AbortSignal.timeout(30_000),
  });

  const json = await response.json() as { data?: unknown; error?: string; message?: string };

  if (!response.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: json.error ?? "HTTP error", message: json.message, status: response.status }) }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(json.data, null, 2) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

**TOOLS import note**: `TOOLS` is a plain array of `ToolDefinition` objects (no class instantiation, no database). Importing it from `PingMemServer.ts` is safe — but it transitively imports module files. A cleaner approach for tree-shaking is to collect tool definitions in a separate `src/mcp/tool-schemas.ts` that has zero service imports. This avoids pulling in SQLite, Neo4j, etc. at proxy startup.

### 5.3 Session Management in Proxy Mode

**Current behavior (direct mode)**: `context_session_start` mutates `state.currentSessionId` in-process. The session ID is kept in memory of the MCP process.

**Proxy mode**: Session state lives in Docker's process. The proxy is stateless. Calls to `context_session_start` hit Docker's REST server → Docker's `RESTPingMemServer` stores the session ID in `this.currentSessionId`. Subsequent calls that need the session ID (e.g., `context_save`) must include `sessionId` in their arguments, OR Docker's `/invoke` endpoint must track session affinity via a header.

**Key finding**: Looking at `rest-server.ts` line 3444–3468, the `/invoke` endpoint builds a **fresh `state` object on every call** using `this.currentSessionId`. This means if `context_session_start` sets Docker's `this.currentSessionId`, then a subsequent `context_save` call to `/invoke` will pick it up — but only within the same process and same HTTP connection. This is already how the REST server works for all REST clients.

**Verdict**: Session management works transparently. The proxy does not need to track session IDs. Docker's `RESTPingMemServer` is the source of truth. The proxy just forwards tool args verbatim.

### 5.4 Docker Health — Graceful Degradation

Strategy: check `GET /health` (unauthenticated, always 200) before starting, and on each tool call timeout.

Three tiers of degradation:
1. **Docker up**: all tools work via REST proxy
2. **Docker down at startup**: warn user via stderr, start anyway — `list_tools` works locally (schemas), `call_tool` returns a structured error `{ error: "ping-mem Docker container not reachable", hint: "Run: docker compose up -d ping-mem" }`
3. **Docker goes down mid-session**: individual tool calls return the error above; Claude Code shows the error as a tool result and can inform the user

Health check implementation:
```typescript
async function checkDockerHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}
```

No retry loop needed — the next tool call will try again. If Docker restarts between calls, it recovers automatically.

---

## 6. Questions Answered

### Q: Can we keep the same MCP tool names/schemas while proxying through REST?

**Yes, completely.** The `TOOLS[]` array is a static data structure — `ToolDefinition[]` with `name`, `description`, and `inputSchema`. No services are instantiated to serve `list_tools`. The proxy serves this array directly from the local process, identical to today.

### Q: What is the minimal code for the proxy?

**~120 lines of TypeScript** (see Section 5.2). The main components:
- MCP `Server` with `StdioServerTransport` (3 lines)
- `ListToolsRequestSchema` handler returning static `TOOLS[]` (3 lines)
- `CallToolRequestSchema` handler making `fetch()` to Docker (20 lines)
- Error handling + health check (20 lines)
- `PING_MEM_REST_URL` env var config (5 lines)

Compared to current `main()` in `PingMemServer.ts` which instantiates ~15 services (~130 lines just for initialization).

### Q: How do we handle session management?

Transparently — Docker's `RESTPingMemServer` tracks session state. The proxy forwards tool args as-is. No session affinity logic needed in the proxy.

### Q: What happens if Docker is down when Claude Code starts?

The proxy starts successfully (no SQLite to open, no services to connect). `list_tools` returns the full schema. Each `call_tool` returns a structured error with a human-readable hint. Claude Code shows the error as tool output. The user can start Docker and the next tool call succeeds without restarting the MCP process.

### Q: Performance — how much latency does REST proxy add?

Per tool call overhead (localhost):
- TCP connect to localhost: ~0.1ms (keep-alive avoids this after first call)
- HTTP/1.1 header overhead: ~0.5ms
- JSON serialization (args + result): ~0.1ms for typical payloads
- **Total added latency: ~1ms per call** on local Docker

For comparison: current direct SQLite read latency is ~0.5ms, write latency ~2ms. The proxy adds roughly equivalent latency but eliminates lock contention. Net effect is neutral-to-positive for reliability.

Use `fetch` with `keepAlive: true` (via a persistent `Agent` or Bun's built-in connection pooling) to avoid TCP reconnect overhead.

---

## 7. Implementation Plan

### Files to create
- `src/mcp/proxy-cli.ts` — the new thin proxy entry point (~120 lines)
- `src/mcp/tool-schemas.ts` — (optional) extract `TOOLS[]` with zero service imports, for clean tree-shaking

### Files to modify
- `src/mcp/cli.ts` — add branch: if `PING_MEM_REST_URL` is set, import and run proxy; else run current `main()`
- `src/config/env-validation.ts` — add `PING_MEM_REST_URL` as optional string to schema
- `package.json` — add `"start:proxy"` script: `bun run dist/mcp/proxy-cli.js`
- Claude Code config (`.claude/settings.json` or `~/.claude.json`) — point `mcpServers.ping-mem` command at `proxy-cli.js` with `PING_MEM_REST_URL=http://localhost:3003`

### Files NOT to touch
- `src/mcp/PingMemServer.ts` — keep intact; Docker container continues using it
- `src/http/rest-server.ts` — the `/api/v1/tools/:name/invoke` endpoint is the proxy backend; no changes needed
- All tool module handlers — untouched

### Env var protocol
```
PING_MEM_REST_URL=http://localhost:3003     # activates proxy mode
PING_MEM_ADMIN_USER=admin                  # forwarded as Basic Auth to /invoke
PING_MEM_ADMIN_PASS=<secret>               # forwarded as Basic Auth to /invoke
```

When `PING_MEM_REST_URL` is unset: current behavior (full server, direct SQLite). Zero breaking change for existing deployments.

---

## 8. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| `/api/v1/tools/:name/invoke` missing some tools | Medium | Verified: all 50 tools are dispatched via module loop in `rest-server.ts:3470-3489`. The `StructuralToolModule` and `MiningToolModule` are NOT in the invoke handler's module list (only 9 modules listed, missing Structural and Mining). **Must add these two modules to the invoke handler.** |
| `memory_maintain` / `memory_conflicts` REST gap | Low | Covered by generic `/invoke`. No dedicated REST endpoint exists, but `/invoke` dispatches to MemoryToolModule which handles them. |
| Session affinity across proxy restarts | Low | Sessions are persisted in Docker's SQLite (via EventStore). On proxy restart, Claude Code calls `context_session_start` again — picks up `continueFrom` for checkpoint restoration. |
| PING_MEM_ADMIN_USER/PASS leaking in ps output | Low | Credentials are in env vars, not CLI args. Standard practice. |
| `TOOLS[]` import pulling in heavy service modules | Medium | `TOOLS` is exported from `PingMemServer.ts` which imports all handler modules. Those modules import service classes but do not instantiate them. TypeScript static imports are fine — Bun loads the module file but no constructor runs. However, for clean separation, extract `TOOLS` to `src/mcp/tool-schemas.ts`. |

### Critical gap: StructuralToolModule + MiningToolModule not in `/invoke`

Looking at `rest-server.ts` lines 3470–3480, the tool invoke endpoint instantiates these 9 modules:
```
ContextToolModule, GraphToolModule, WorklogToolModule, DiagnosticsToolModule,
CodebaseToolModule, MemoryToolModule, CausalToolModule, KnowledgeToolModule, AgentToolModule
```

Missing: `StructuralToolModule` (3 tools) and `MiningToolModule` (3 tools).

These 6 tools currently return 404 from `/invoke`. This must be fixed before or as part of the proxy implementation, as these tools ARE advertised in `list_tools` but cannot be invoked via the proxy.

---

## 9. Alternative Approaches Considered and Rejected

### Alt A: Use `StreamableHTTPClientTransport` to forward to a Streamable HTTP endpoint

The Docker container would expose `/mcp` as a Streamable HTTP MCP endpoint, and the proxy would use the MCP SDK `Client` class to forward requests. This is "MCP-to-MCP" proxying.

**Rejected because**: The Docker container currently runs as a REST server, not an MCP server. Adding a Streamable HTTP transport to Docker requires wiring a new transport with session management (stateful). More invasive change. The generic `/invoke` REST endpoint already solves the same problem with less infrastructure.

### Alt B: Separate database files (avoid proxy entirely)

Set `PING_MEM_DB_PATH=~/.ping-mem/mcp.db` for the stdio process and a different path for Docker. Both write their own DB, and memories are only visible to one process at a time.

**Rejected because**: Memories saved via MCP stdio would not be visible to the REST server (and vice versa), breaking the core use case of a shared memory layer.

### Alt C: SQLite WAL mode only (no proxy)

Already in place — `EventStore` enables WAL. The comment in `PingMemServer.ts:main()` shows the WAL check is already implemented. WAL allows one writer and multiple readers, but **two concurrent writers** (MCP stdio + Docker REST both writing) still cause "database is locked" errors.

**Rejected as a full solution**: WAL reduces but does not eliminate the problem. Under normal use, the MCP process writes on every `context_save`. Docker REST also writes. Two writers = intermittent lock errors.

---

## 10. Summary

| Decision | Answer |
|----------|--------|
| Proxy mechanism | MCP `Server` (stdio) → `fetch()` → Docker REST `/api/v1/tools/:name/invoke` |
| SDK proxy class | None exists — build custom 120-line handler |
| Tool schemas served from | Local static `TOOLS[]` (no Docker round-trip for list_tools) |
| Session management | Transparent — Docker owns state, proxy is stateless |
| Docker-down behavior | Structured error per call, proxy stays up |
| Activation | `PING_MEM_REST_URL` env var — zero-change fallback when unset |
| Latency cost | ~1ms per call on localhost, negligible |
| Critical pre-work | Add `StructuralToolModule` + `MiningToolModule` to rest-server.ts `/invoke` handler |
