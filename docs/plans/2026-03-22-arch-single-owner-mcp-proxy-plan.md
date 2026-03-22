---
title: "arch: Single-owner architecture — MCP stdio REST proxy"
type: refactor
date: 2026-03-22
status: ready
github_issues: [89, 90]
github_pr: null
research: docs/proxy-research/ (1 document, 21KB)
synthesis: docs/proxy-research/01-mcp-proxy-architecture.md
eval_iteration: 0
review_iteration: 0
verification_iteration: 0
verification_method: null
scope: 1 user, multiple agents, designed for multi-user expansion
---

# Single-Owner Architecture: MCP stdio REST Proxy

## Problem Statement

ping-mem has TWO processes opening the same SQLite database simultaneously:
1. **MCP stdio** (`bun run dist/mcp/cli.js`) — started by Claude Code, opens events.db directly
2. **Docker container** (REST server on :3003) — serves hooks, u-os, understory, opens events.db directly

They have independent in-memory Maps for sessions and memories. A memory saved via MCP is invisible to REST search until SQLite WAL checkpoints. Sessions created in one process don't exist in the other. This causes: silent data loss, stale search results, cross-session failures, and concurrent SQLite lock contention.

**Evidence**: Issues #67, #68-#80, #82-#88 all trace back to this dual-process architecture.

## Proposed Solution

One process owns the database. All clients proxy through it.

```
BEFORE (broken):                    AFTER (deterministic):

Claude Code ──MCP──→ Process 1      Claude Code ──MCP──→ Proxy ──REST──→ Docker
                     (direct DB)                         (no DB)         (owns DB)

Hooks ──────REST──→ Process 2       Hooks ──────REST──────────────────→ Docker
                    (direct DB)                                         (owns DB)

u-os ───────REST──→ Process 2       u-os ───────REST──────────────────→ Docker
                    (direct DB)                                         (owns DB)
```

## Critical Questions — Answers

| Question | Decision | Source |
|----------|----------|--------|
| Fallback when Docker is down | Fail fast with clear error + auto-attempt `docker compose up -d` | User-selected |
| User identity model | API key per user (for eventual multi-user expansion) | User-selected |
| Code structure | Same codebase, new entry point `src/mcp/proxy-cli.ts` | User-selected |
| Proxy routing | Generic `POST /api/v1/tools/:name/invoke` for ALL tools | Research finding |
| Session management | Stateless proxy — Docker tracks sessions | Research finding |

## Implementation

### Phase 1: Build the proxy (single file, ~120 lines)

**New file**: `src/mcp/proxy-cli.ts`

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./PingMemServer.js";

const BASE_URL = process.env.PING_MEM_REST_URL ?? "http://localhost:3003";
const ADMIN_USER = process.env.PING_MEM_ADMIN_USER ?? "";
const ADMIN_PASS = process.env.PING_MEM_ADMIN_PASS ?? "";

const server = new Server(
  { name: "ping-mem", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } }
);

// List tools: serve static schemas locally (no HTTP round-trip)
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Call tool: proxy to Docker REST
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ADMIN_USER) {
    headers["Authorization"] = "Basic " + Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString("base64");
  }

  const response = await fetch(
    `${BASE_URL}/api/v1/tools/${encodeURIComponent(name)}/invoke`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ args: args ?? {} }),
      signal: AbortSignal.timeout(30_000),
    }
  );

  const json = await response.json();
  if (!response.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: json.error, message: json.message, status: response.status }) }],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(json.data, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Tasks**:
1. Create `src/mcp/proxy-cli.ts` with the proxy implementation
2. Add Docker health check on startup (warn via stderr if down, attempt `docker compose up -d`)
3. Add `"start:proxy"` script to package.json: `bun run dist/mcp/proxy-cli.js`
4. Update `~/.claude/mcp.json` to use proxy-cli.ts with `PING_MEM_REST_URL=http://localhost:3003`
5. Test: all 53 MCP tools work through proxy

### Phase 2: Wire and verify

**Tasks**:
1. Build dist: `bun run build` (proxy-cli.ts → proxy-cli.js)
2. Update mcp.json to point at proxy-cli.js with PING_MEM_REST_URL env var
3. Verify MCP stdio returns 53 tools
4. Verify context_session_start → context_save → context_search round-trip via MCP
5. Verify cross-session: MCP save → REST search finds it (same Docker process)
6. Verify hooks still work (they already use REST)
7. Run `bash scripts/agent-path-audit.sh`

### Phase 3: Clean up direct-DB code path

**Tasks**:
1. Add deprecation warning to `src/mcp/PingMemServer.ts` `main()` — log "Direct DB mode is deprecated. Set PING_MEM_REST_URL for proxy mode."
2. Keep direct mode as fallback (don't delete yet) — for production VPS where Docker IS the MCP host
3. Update CLAUDE.md deployment section to document proxy mode

## Database Schema Definitions

No new tables. No schema changes. The proxy is a transport change, not a data change.

## Function Signatures

```typescript
// src/mcp/proxy-cli.ts

/** Check if Docker ping-mem is reachable */
async function checkDockerHealth(baseUrl: string): Promise<boolean> {}

/** Attempt to start Docker if not running */
async function tryStartDocker(): Promise<boolean> {}

/** Proxy a single MCP tool call to REST */
async function proxyToolCall(
  name: string,
  args: Record<string, unknown>,
  baseUrl: string,
  authHeader?: string
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {}
```

## Integration Points

| File | Change |
|------|--------|
| `src/mcp/proxy-cli.ts` | NEW — thin MCP-to-REST proxy |
| `package.json` | Add `start:proxy` script |
| `~/.claude/mcp.json` | Point at proxy-cli.js with PING_MEM_REST_URL |
| `src/mcp/PingMemServer.ts` | Add deprecation warning to main() |
| `CLAUDE.md` | Document proxy mode |

## Wiring Matrix

| Capability | User Trigger | Call Path | Integration Test |
|-----------|-------------|-----------|-----------------|
| MCP tool call | Claude Code invokes any MCP tool | proxy-cli → fetch → Docker /invoke → tool module → result | All 53 tools return results |
| Tool listing | Claude Code asks for available tools | proxy-cli → static TOOLS array | 53 tools listed |
| Docker health | Proxy startup | proxy-cli → GET /health → stderr warning if down | Proxy starts even when Docker down |
| Auto-start Docker | Docker not running at proxy startup | proxy-cli → `docker compose up -d` → wait → health check | Docker starts automatically |
| Session round-trip | context_session_start → context_save → context_search | proxy → Docker session/start → Docker context save → Docker search | Memory found |
| Cross-process | MCP save, REST search (hooks) | proxy → Docker save → hook → Docker auto-recall | Memory found by hook |

## Verification Checklist

| # | Check | Command | Expected |
|---|-------|---------|----------|
| 1 | Proxy file exists | `ls src/mcp/proxy-cli.ts` | File exists |
| 2 | Proxy builds | `bun run build && ls dist/mcp/proxy-cli.js` | File exists |
| 3 | MCP tools listed | MCP stdio list_tools | 53 tools |
| 4 | No DB imports in proxy | `grep -c "Database\|EventStore\|MemoryManager" src/mcp/proxy-cli.ts` | 0 |
| 5 | REST_URL env used | `grep "PING_MEM_REST_URL" src/mcp/proxy-cli.ts` | Match |
| 6 | Agent-path audit | `bash scripts/agent-path-audit.sh` | 0 failures |

## Functional Tests

| # | Test Name | Command | Expected Output |
|---|-----------|---------|-----------------|
| 1 | Tool list via proxy | `echo MCP JSON | bun run dist/mcp/proxy-cli.js` | 53 tools |
| 2 | Save+search via proxy | MCP session_start → save → search | Memory found |
| 3 | Cross-process | MCP save → curl REST search | Memory found |
| 4 | Docker down | Stop Docker → MCP tool call | Structured error with hint |
| 5 | Docker restart | Stop → start Docker → MCP tool call | Succeeds without proxy restart |

## Acceptance Criteria

### Functional
- [ ] All 53 MCP tools work through proxy
- [ ] Write-then-search deterministic via MCP
- [ ] Cross-process: MCP save → REST search → found
- [ ] Cross-session: session A save → session B search → found
- [ ] Docker down → clear error message
- [ ] Docker restart → automatic recovery
- [ ] Agent-path audit: 0 failures

### Non-Functional
- [ ] Proxy adds < 5ms latency per tool call
- [ ] Proxy startup < 500ms (no DB/service init)
- [ ] Proxy process uses < 20MB RAM (no DB/Qdrant/Neo4j)
- [ ] Zero SQLite file access from proxy process

## Risk Analysis

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| Docker not running | Medium | Medium | Auto-start + clear error message |
| REST /invoke auth mismatch | High | Low | Proxy reads same env vars as Docker |
| Tool schema drift (proxy has old schemas) | Medium | Low | Proxy imports TOOLS from same source file |
| Network latency on localhost | Low | Low | ~1ms per call, connection pooling |
| Breaking existing direct-DB users | Medium | Low | Keep direct mode as fallback, deprecation warning |

## Design for Multi-User Expansion

This proxy architecture naturally extends to multi-user:

```
TODAY (1 user):
  mcp.json → proxy-cli.js → localhost:3003 (Docker)

FUTURE (multi-user, mem0-style):
  mcp.json → proxy-cli.js → ping-mem.ping-gadgets.com (production)
  - API key per user in env var: PING_MEM_API_KEY
  - Proxy passes key as Bearer token
  - Server routes to user's tenant namespace
  - Same proxy code, different URL + auth
```

The proxy is already URL-configurable (`PING_MEM_REST_URL`). Adding API key auth is one env var + one header line. The server-side tenant routing is the only new work for multi-user.

## Complete File Structure

```
src/mcp/
├── proxy-cli.ts    # NEW — thin MCP-to-REST proxy (~120 lines)
├── cli.ts          # EXISTING — kept as direct-DB fallback (deprecated)
├── PingMemServer.ts # EXISTING — add deprecation warning to main()
└── handlers/       # EXISTING — unchanged (used by Docker process)
```

## Dependencies

No new dependencies. Uses existing `@modelcontextprotocol/sdk` and `fetch` (built into Bun).

## Success Metrics

| Metric | Baseline | Target |
|--------|----------|--------|
| SQLite lock errors | Intermittent | 0 |
| Cross-process search failures | Intermittent | 0 |
| MCP proxy latency overhead | 0ms (direct) | < 5ms |
| Proxy RAM usage | ~200MB (full server) | < 20MB |
| Proxy startup time | ~3s (full server) | < 500ms |
