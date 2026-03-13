# MCP Streamable HTTP Transport — Research Findings

**Date**: 2026-03-09
**Status**: Final
**Sources**: MCP specification (spec.modelcontextprotocol.io), @hono/mcp package docs, Hono framework docs

---

## 1. Problem Statement

Current ping-mem architecture:
- **Port 3003**: REST API only (no MCP)
- **MCP server**: stdio transport only (process-local, no HTTP access)
- **Port 3000**: SSE/REST mode (alternative server)

User requirement: MCP server must be accessible on port 3003 alongside the REST API.

---

## 2. MCP Transport Specification (March 2025)

The MCP specification defines three transports:

| Transport | Protocol | Use Case |
|-----------|----------|----------|
| `stdio` | stdin/stdout | Local process (current ping-mem MCP) |
| `SSE` | HTTP GET + EventSource | Deprecated in newer spec; one endpoint for events, one for POST |
| **Streamable HTTP** | HTTP POST + optional SSE | **New standard**: single `/mcp` endpoint, supports both request-response and streaming |

**Streamable HTTP** (March 2025 spec update):
- Single endpoint, typically at `/mcp`
- Client POSTs requests (JSON-RPC 2.0)
- Server responds with either:
  - Direct JSON response (for non-streaming tools)
  - SSE stream (`Content-Type: text/event-stream`) for streaming tools
- Can be mounted alongside any HTTP framework (Hono, Express, Fastify)
- Session management via `Mcp-Session-Id` header

---

## 3. @hono/mcp Package

**Package**: `@hono/mcp` — official Hono middleware for MCP streamable HTTP

```typescript
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
```

**Minimal server setup**:

```typescript
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toFetchResponse, toRequest } from 'fetch-to-node'; // convert between Fetch API and Node http

const app = new Hono();

// Shared MCP server instance
const mcpServer = new McpServer({ name: 'ping-mem', version: '2.0.0' });

// Register MCP tools on mcpServer here...

// Mount MCP endpoint alongside REST routes
app.all('/mcp', async (c) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  await mcpServer.connect(transport);
  const response = await transport.handleRequest(c.req.raw);
  return new Response(response.body, response);
});

// REST routes continue normally
app.get('/health', (c) => c.json({ status: 'ok' }));
app.post('/api/v1/codebase/ingest', /* ... */);
```

**Key properties**:
- `@modelcontextprotocol/sdk` ≥ 1.0.0 includes `StreamableHTTPServerTransport`
- Works with Hono's Web Standard Request/Response API (no conversion layer needed)
- Single transport instance per request (stateless) or session-aware (stateful with `Mcp-Session-Id`)

---

## 4. Session Management Options

### Stateless (simplest — no session affinity required)
Each HTTP request creates and disposes a transport:
```typescript
app.post('/mcp', async (c) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined // no sessions
  });
  const response = await transport.handle(await c.req.arrayBuffer());
  return response;
});
```

### Stateful (per-session — retains tool call context)
```typescript
const sessions = new Map<string, StreamableHTTPServerTransport>();

app.post('/mcp', async (c) => {
  const sessionId = c.req.header('Mcp-Session-Id');
  let transport = sessionId ? sessions.get(sessionId) : undefined;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID()
    });
    sessions.set(transport.sessionId!, transport);
  }

  return transport.handle(await c.req.arrayBuffer());
});
```

For ping-mem, **stateless** is appropriate since each MCP tool call is self-contained (backed by SQLite).

---

## 5. Migration Plan for ping-mem

### Current architecture
```
src/mcp/PingMemServer.ts  ← registers all tools on McpServer
src/mcp/cli.ts             ← creates StdioServerTransport, connects McpServer
src/http/rest-server.ts    ← Hono app, REST-only, port 3003
```

### Target architecture
```
src/mcp/PingMemServer.ts   ← unchanged (McpServer + tool definitions)
src/mcp/cli.ts             ← unchanged (stdio transport for local use)
src/http/rest-server.ts    ← ADD: app.all('/mcp', mcpHttpHandler)
                           ← EXPOSE same McpServer instance over HTTP
```

### Steps

1. **Export `mcpServer` from `PingMemServer.ts`** or create shared factory:
```typescript
// src/mcp/PingMemServer.ts — add export
export let sharedMcpServer: McpServer | null = null;

export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'ping-mem', version: '2.0.0' });
  // register tools...
  sharedMcpServer = server;
  return server;
}
```

2. **In `rest-server.ts`** — import and mount:
```typescript
import { createMcpServer } from '../mcp/PingMemServer.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const mcpServer = createMcpServer(deps);

// MCP endpoint — mounted alongside REST
app.all('/mcp', async (c) => {
  const transport = new StreamableHTTPServerTransport({});
  await mcpServer.connect(transport);
  const response = await transport.handle(c.req.raw);
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
});
```

3. **Update docker-compose** — no port change needed (3003 already exposed)

4. **Update CLAUDE.md** — document MCP endpoint: `http://localhost:3003/mcp`

---

## 6. Bun HTTP Server Compatibility

ping-mem uses Bun's HTTP server (`Bun.serve`) not Node.js `http`. Hono works natively with Bun. The `StreamableHTTPServerTransport` uses the Fetch API (`Request`/`Response`) which Bun natively supports.

No conversion shim needed. Direct compatibility confirmed:
```typescript
// Bun native fetch API + Hono + MCP SDK all use Web Standard Request/Response
```

---

## 7. Dependencies Required

Current `package.json` already has:
- `@modelcontextprotocol/sdk` — check version (need ≥ 1.0.0 for StreamableHTTPServerTransport)
- `hono` — already used for REST server

Check if `StreamableHTTPServerTransport` is available:
```bash
bun pm ls @modelcontextprotocol/sdk
# Need: @modelcontextprotocol/sdk@^1.0.0
```

---

## 8. Sources

- [MCP Transports Specification — spec.modelcontextprotocol.io](https://spec.modelcontextprotocol.io/specification/architecture/transports/)
- [MCP TypeScript SDK — @modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [Hono MCP Integration — @hono/mcp](https://github.com/honojs/middleware/tree/main/packages/mcp)
- [Building an MCP Server with Hono — DEV Community](https://dev.to/buildbreaklearn/building-an-mcp-server-with-hono-a-step-by-step-guide-4hk6)
- [MCP Streamable HTTP Transport — GitHub PR #206](https://github.com/modelcontextprotocol/specification/pull/206)
