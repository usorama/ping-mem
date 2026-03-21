---
title: "feat: Universal CLI + REST API for ping-mem"
type: feat
date: 2026-03-16
status: verified
github_issues: []
github_pr: null
research: docs/ping-mem-cli-research/ (2 documents)
synthesis: docs/ping-mem-cli-research/02-synthesis.md
eval_iteration: 1
review_iteration: 0
verification_iteration: 1
verification_method: "codebase-grep-verified"
---

# Universal CLI + REST API for ping-mem

## Problem Statement

ping-mem has 44 MCP tools across 9 modules, but only 35 REST endpoints and 1 CLI command (`collect`). This creates three problems:

1. **Feature parity gap**: 18 MCP tools lack REST equivalents (entire Graph and Causal modules, plus Worklog, Diagnostics compare/by-symbol, and Codebase list/delete tools). Users accessing ping-mem via REST or CLI get a degraded experience.

2. **No CLI for daily use**: The only CLI command is `collect` (diagnostics ingestion). There is no way to `ping-mem store`, `ping-mem search`, or `ping-mem session start` from the terminal. Shell integration is impossible without a CLI.

3. **No SDK generation**: Without an OpenAPI spec, TypeScript and Python SDK generation is impossible. Every integration (LangChain, CrewAI, custom agents) must hand-code HTTP calls against undocumented endpoints.

**Evidence**:
- `src/mcp/handlers/*.ts`: 44 tool definitions across 9 modules (Context:9, Graph:5, Worklog:2, Diagnostics:8, Codebase:6, Memory:5, Causal:4, Knowledge:2, Agent:3)
- `src/http/rest-server.ts`: 35 route registrations (`app.get`/`app.post`/`app.delete`)
- `src/cli.ts`: Single `collect` command with hand-rolled argument parser
- `package.json`: No `@hono/zod-openapi` dependency, no CLI framework dependency

## Proposed Solution

Four independently shippable phases that build on each other:

```
Phase 1: REST API Consolidation
  └── Full 43-tool parity + OpenAPI spec + tool discovery

Phase 2: CLI Binary
  └── Citty-based thin client calling REST API

Phase 3: Shell Integration
  └── Shell hooks + background daemon via Unix socket

Phase 4: SDK Generation
  └── TypeScript + Python SDKs from OpenAPI spec
```

### Architecture

```
                    ┌─────────────────────────────────┐
                    │     REST API Server (port 3000)  │
                    │                                  │
                    │  /api/v1/context/*    (10 routes) │
                    │  /api/v1/graph/*      ( 5 routes) │
                    │  /api/v1/worklog/*    ( 2 routes) │
                    │  /api/v1/diagnostics/*( 8 routes) │
                    │  /api/v1/codebase/*   ( 6 routes) │
                    │  /api/v1/memory/*     ( 5 routes) │
                    │  /api/v1/causal/*     ( 4 routes) │
                    │  /api/v1/knowledge/*  ( 2 routes) │
                    │  /api/v1/agents/*     ( 3 routes) │
                    │  /api/v1/tools/*      ( 3 routes) │
                    │  /openapi.json                    │
                    │  /health                          │
                    │                                  │
                    │  MCP transport (opt-in via /mcp) │
                    │  SSE transport (opt-in via /sse) │
                    └──────────┬────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
      ┌───────▼──────┐ ┌──────▼──────┐ ┌───────▼──────┐
      │   CLI        │ │   SDK (TS)  │ │   SDK (Py)   │
      │   Citty      │ │   hey-api   │ │   manual     │
      │   thin       │ │   generated │ │   thin       │
      │   client     │ │   from spec │ │   wrapper    │
      └───────┬──────┘ └─────────────┘ └──────────────┘
              │
      ┌───────▼──────┐
      │ Shell Hook   │
      │ precmd/cd    │──→ Unix socket ──→ daemon (= REST server)
      └──────────────┘
```

---

## Gap Coverage Matrix

| MCP Tool | REST Endpoint (current) | REST Endpoint (planned) | CLI Command (planned) |
|----------|------------------------|------------------------|----------------------|
| `context_session_start` | `POST /api/v1/session/start` | Keep | `ping-mem session start` |
| `context_session_end` | `POST /api/v1/session/end` | Keep | `ping-mem session end` |
| `context_session_list` | `GET /api/v1/session/list` | Keep | `ping-mem session list` |
| `context_save` | `POST /api/v1/context` | Keep | `ping-mem context save` |
| `context_get` | `GET /api/v1/context/:key` | Keep | `ping-mem context get` |
| `context_search` | `GET /api/v1/search` | Keep | `ping-mem context search` |
| `context_delete` | `DELETE /api/v1/context/:key` | Keep | `ping-mem context delete` |
| `context_checkpoint` | `POST /api/v1/checkpoint` | Keep | `ping-mem context checkpoint` |
| `context_status` | `GET /api/v1/status` | Keep | `ping-mem context status` |
| `context_query_relationships` | **MISSING** | `GET /api/v1/graph/relationships` | `ping-mem graph relationships` |
| `context_hybrid_search` | **MISSING** | `POST /api/v1/graph/hybrid-search` | `ping-mem graph search` |
| `context_get_lineage` | **MISSING** | `GET /api/v1/graph/lineage/:entity` | `ping-mem graph lineage` |
| `context_query_evolution` | **MISSING** | `GET /api/v1/graph/evolution` | `ping-mem graph evolution` |
| `context_health` | **MISSING** | `GET /api/v1/graph/health` | `ping-mem graph health` |
| `worklog_record` | **MISSING** | `POST /api/v1/worklog` | `ping-mem worklog record` |
| `worklog_list` | **MISSING** | `GET /api/v1/worklog` | `ping-mem worklog list` |
| `diagnostics_ingest` | `POST /api/v1/diagnostics/ingest` | Keep | `ping-mem diagnostics ingest` |
| `diagnostics_latest` | `GET /api/v1/diagnostics/latest` | Keep | `ping-mem diagnostics latest` |
| `diagnostics_list` | `GET /api/v1/diagnostics/findings/:analysisId` | Keep | `ping-mem diagnostics list` |
| `diagnostics_diff` | `POST /api/v1/diagnostics/diff` | Keep | `ping-mem diagnostics diff` |
| `diagnostics_summary` | `GET /api/v1/diagnostics/summary/:id` | Keep | `ping-mem diagnostics summary` |
| `diagnostics_compare_tools` | **MISSING** | `GET /api/v1/diagnostics/compare` | `ping-mem diagnostics compare` |
| `diagnostics_by_symbol` | **MISSING** | `GET /api/v1/diagnostics/by-symbol` | `ping-mem diagnostics by-symbol` |
| `diagnostics_summarize` | `POST /api/v1/diagnostics/summarize/:id` | Keep | `ping-mem diagnostics summarize` |
| `codebase_ingest` | `POST /api/v1/codebase/ingest` | Keep | `ping-mem codebase ingest` |
| `codebase_verify` | `POST /api/v1/codebase/verify` | Keep | `ping-mem codebase verify` |
| `codebase_search` | `GET /api/v1/codebase/search` | Keep | `ping-mem codebase search` |
| `codebase_timeline` | `GET /api/v1/codebase/timeline` | Keep | `ping-mem codebase timeline` |
| `codebase_list_projects` | **MISSING** | `GET /api/v1/codebase/projects` | `ping-mem codebase projects` |
| `project_delete` | **MISSING** | `DELETE /api/v1/codebase/projects/:id` | `ping-mem codebase delete` |
| `memory_stats` | `GET /api/v1/memory/stats` | Keep | `ping-mem memory stats` |
| `memory_consolidate` | `POST /api/v1/memory/consolidate` | Keep | `ping-mem memory consolidate` |
| `memory_subscribe` | **PARTIAL** (`/api/v1/events/stream`) | `POST /api/v1/memory/subscribe` | `ping-mem memory subscribe` |
| `memory_unsubscribe` | **MISSING** | `POST /api/v1/memory/unsubscribe` | `ping-mem memory unsubscribe` |
| `memory_compress` | **MISSING** | `POST /api/v1/memory/compress` | `ping-mem memory compress` |
| `search_causes` | **MISSING** | `GET /api/v1/causal/causes` | `ping-mem causal causes` |
| `search_effects` | **MISSING** | `GET /api/v1/causal/effects` | `ping-mem causal effects` |
| `get_causal_chain` | **MISSING** | `GET /api/v1/causal/chain` | `ping-mem causal chain` |
| `trigger_causal_discovery` | **MISSING** | `POST /api/v1/causal/discover` | `ping-mem causal discover` |
| `knowledge_search` | `POST /api/v1/knowledge/search` | Keep | `ping-mem knowledge search` |
| `knowledge_ingest` | `POST /api/v1/knowledge/ingest` | Keep | `ping-mem knowledge ingest` |
| `agent_register` | `POST /api/v1/agents/register` | Keep | `ping-mem agent register` |
| `agent_quota_status` | `GET /api/v1/agents/quotas` | Keep | `ping-mem agent quotas` |
| `agent_deregister` | `DELETE /api/v1/agents/:agentId` | Keep | `ping-mem agent deregister` |

**Summary**: 18 routes to add, 25 routes to keep, 3 discovery routes to create (`/tools`, `/tools/:name`, `/tools/:name/invoke`).

**Note**: 5 REST-only endpoints exist with no MCP equivalent: `GET /api/v1/codebase/staleness`, `POST /api/v1/ingestion/enqueue`, `GET /api/v1/ingestion/queue`, `GET /api/v1/ingestion/run/:runId`, `GET /api/v1/observability/status`. These are REST-native features, not gaps.

---

## Implementation Phases

### Phase 1: REST API Consolidation

**Goal**: Full 43-tool REST parity + OpenAPI spec + tool discovery endpoints.
**Effort**: 3-4 days
**Prerequisite**: None (this is the foundation)

#### Step 1.1: Add Missing REST Endpoints (18 routes)

Add the 18 missing REST endpoints to `src/http/rest-server.ts`. Each endpoint delegates to the same handler logic used by the MCP tool modules.

**Pre-requisite fix**: Add `hono` to `package.json` dependencies (currently imported but not declared).

**Files modified**:
- `src/http/rest-server.ts` -- add 18 new route handlers
- `src/validation/api-schemas.ts` -- add Zod schemas for new request/response types

**New routes by module**:

Graph module (5 routes):
```typescript
// src/http/rest-server.ts additions
app.get("/api/v1/graph/relationships", handler)    // context_query_relationships
app.post("/api/v1/graph/hybrid-search", handler)    // context_hybrid_search
app.get("/api/v1/graph/lineage/:entity", handler)   // context_get_lineage
app.get("/api/v1/graph/evolution", handler)          // context_query_evolution
app.get("/api/v1/graph/health", handler)             // context_health
```

Causal module (4 routes):
```typescript
app.get("/api/v1/causal/causes", handler)            // search_causes
app.get("/api/v1/causal/effects", handler)            // search_effects
app.get("/api/v1/causal/chain", handler)              // get_causal_chain
app.post("/api/v1/causal/discover", handler)          // trigger_causal_discovery
```

Worklog module (2 routes):
```typescript
app.post("/api/v1/worklog", handler)                  // worklog_record
app.get("/api/v1/worklog", handler)                   // worklog_list
```

Diagnostics module (2 routes — `diagnostics_list` already exists as `GET /api/v1/diagnostics/findings/:analysisId`):
```typescript
app.get("/api/v1/diagnostics/compare", handler)       // diagnostics_compare_tools
app.get("/api/v1/diagnostics/by-symbol", handler)     // diagnostics_by_symbol
```

Codebase module (2 routes):
```typescript
app.get("/api/v1/codebase/projects", handler)         // codebase_list_projects
app.delete("/api/v1/codebase/projects/:id", handler)  // project_delete
```

Memory module (3 routes):
```typescript
app.post("/api/v1/memory/subscribe", handler)         // memory_subscribe
app.post("/api/v1/memory/unsubscribe", handler)       // memory_unsubscribe
app.post("/api/v1/memory/compress", handler)           // memory_compress
```

#### Step 1.2: Add Tool Discovery Endpoints (3 routes)

```typescript
// GET /api/v1/tools -- list all registered tools with schemas
app.get("/api/v1/tools", handler)

// GET /api/v1/tools/:name -- get specific tool schema
app.get("/api/v1/tools/:name", handler)

// POST /api/v1/tools/:name/invoke -- invoke tool by name (generic)
app.post("/api/v1/tools/:name/invoke", handler)
```

**Function signature for tool discovery handler**:

```typescript
// src/http/tool-discovery.ts (new file)

import { TOOLS } from "../mcp/PingMemServer.js";
import type { ToolDefinition } from "../mcp/types.js";

export interface ToolListResponse {
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    module: string;
  }>;
  count: number;
}

export interface ToolInvokeRequest {
  arguments: Record<string, unknown>;
}

export interface ToolInvokeResponse {
  result: Record<string, unknown>;
  tool: string;
  durationMs: number;
}

export function listTools(): ToolListResponse {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      module: inferModule(t.name),
    })),
    count: TOOLS.length,
  };
}

export function getToolSchema(name: string): ToolDefinition | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}
```

#### Step 1.2.5: Split rest-server.ts into Route Sub-Modules

**CRITICAL PRE-REQUISITE**: `rest-server.ts` is already ~2000+ lines. Adding 18 more routes inline would make it unmaintainable. Extract route handlers into sub-modules mirroring `src/mcp/handlers/` structure.

**New files**:
- `src/http/routes/context.ts` -- context/session routes
- `src/http/routes/diagnostics.ts` -- diagnostics routes
- `src/http/routes/codebase.ts` -- codebase routes
- `src/http/routes/memory.ts` -- memory routes
- `src/http/routes/graph.ts` -- graph routes (NEW)
- `src/http/routes/causal.ts` -- causal routes (NEW)
- `src/http/routes/worklog.ts` -- worklog routes (NEW)
- `src/http/routes/knowledge.ts` -- knowledge routes
- `src/http/routes/agent.ts` -- agent routes

Each exports a `registerRoutes(app, services)` function. `rest-server.ts` becomes the orchestrator that calls each module's `registerRoutes()`.

#### Step 1.3: OpenAPI Spec Generation

**BLOCKER RESOLVED**: `@hono/zod-openapi` does NOT support Zod v4 (open issue [honojs/middleware#1177](https://github.com/honojs/middleware/issues/1177)). This project uses Zod v4.3.6.

**Solution**: Use `hono-zod-openapi` (by paolostyle, v1.0.0+) which is fully Zod v4 compatible and provides middleware-based OpenAPI generation that can be added to existing routes without requiring `OpenAPIHono` class migration.

Alternative fallback: Use `@asteasolutions/zod-to-openapi` v8.x (Zod v4 compatible) to generate the spec from existing Zod schemas, served as a static JSON endpoint.

**Files modified**:
- `src/http/rest-server.ts` -- add OpenAPI middleware + `/openapi.json` endpoint
- `package.json` -- add `hono-zod-openapi` dependency (NOT `@hono/zod-openapi`)

**New endpoint**:
```typescript
// Serve auto-generated OpenAPI 3.1 spec
app.get("/openapi.json", (c) => c.json(generatedSpec));
```

**Key advantage**: No need to change from `Hono` to `OpenAPIHono` class — existing routes stay as-is, middleware decorates them with OpenAPI metadata.

#### Step 1.4: Port Consolidation

Consolidate MCP stdio, SSE, and REST onto single port 3000. The `PING_MEM_TRANSPORT` env var selects the primary transport (default: `rest`). MCP is available via `/mcp` path, SSE via `/sse` path.

**Files modified**:
- `src/http/server.ts` -- unified server startup
- `src/http/rest-server.ts` -- mount SSE and MCP routes as sub-apps

**No breaking changes**: `PING_MEM_TRANSPORT=sse` and `PING_MEM_TRANSPORT=rest` continue to work. Port 3003 is deprecated but supported via `PING_MEM_PORT=3003`.

#### Phase 1 Verification Checklist

| Check | Method | PASS/FAIL |
|-------|--------|-----------|
| All 44 MCP tools have REST endpoints | `curl /api/v1/tools \| jq '.count'` returns 44+ | |
| OpenAPI spec is valid | `npx @redocly/cli lint openapi.json` returns 0 errors | |
| `/openapi.json` endpoint returns spec | `curl -s localhost:3000/openapi.json \| jq .openapi` returns `"3.1.0"` | |
| Tool discovery works | `curl /api/v1/tools/context_save` returns schema JSON | |
| Tool invocation works | `curl -X POST /api/v1/tools/context_save/invoke -d '{"arguments":{...}}'` returns result | |
| Existing 35 endpoints unchanged | Run existing REST test suite, 0 regressions | |
| Single port operation | `ss -tlnp \| grep ping-mem` shows only port 3000 | |
| `bun run typecheck` | 0 errors | |
| `bun test` | 0 failures | |

---

### Phase 2: CLI Binary

**Goal**: Full CLI with 44+ tool subcommands, auth, config, output formatting.
**Effort**: 4-5 days
**Prerequisite**: Phase 1 (REST API must have full tool parity + OpenAPI spec)

#### Step 2.1: CLI Framework Setup

**New files**:
- `src/cli/index.ts` -- main entry point with Citty `runMain`
- `src/cli/config.ts` -- config file management (`~/.config/ping-mem/config.json`)
- `src/cli/auth.ts` -- API key storage (`~/.config/ping-mem/auth.json`)
- `src/cli/client.ts` -- HTTP client wrapper (fetch-based, reads auth + server URL from config)
- `src/cli/output.ts` -- output formatters (`--json`, `--table`, `--quiet`)

**Files modified**:
- `package.json` -- add `citty` dependency, update `bin.ping-mem` entry

**Function signatures**:

```typescript
// src/cli/config.ts
export interface PingMemConfig {
  serverUrl: string;        // default: "http://localhost:3000"
  defaultProject: string | null;
  outputFormat: "json" | "table" | "quiet";
}

export function loadConfig(): PingMemConfig;
export function saveConfig(config: Partial<PingMemConfig>): void;
export function getConfigDir(): string;  // ~/.config/ping-mem/

// src/cli/auth.ts
export interface AuthState {
  apiKey: string;
  serverUrl: string;
  createdAt: string;
}

export function loadAuth(): AuthState | null;
export function saveAuth(auth: AuthState): void;
export function clearAuth(): void;

// src/cli/client.ts
export class PingMemClient {
  constructor(config: { serverUrl: string; apiKey?: string });

  get<T>(path: string, params?: Record<string, string>): Promise<T>;
  post<T>(path: string, body: Record<string, unknown>): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

// src/cli/output.ts
export function formatOutput(
  data: unknown,
  format: "json" | "table" | "quiet"
): string;
```

#### Step 2.2: Command Registration

Each MCP tool becomes a CLI subcommand. Commands are grouped by module (matching the REST API path structure).

**New files** (one per module):
- `src/cli/commands/context.ts` -- 10 commands (session start/end/list, save, get, search, delete, checkpoint, status)
- `src/cli/commands/graph.ts` -- 5 commands
- `src/cli/commands/worklog.ts` -- 2 commands
- `src/cli/commands/diagnostics.ts` -- 8 commands
- `src/cli/commands/codebase.ts` -- 6 commands
- `src/cli/commands/memory.ts` -- 5 commands
- `src/cli/commands/causal.ts` -- 4 commands
- `src/cli/commands/knowledge.ts` -- 2 commands
- `src/cli/commands/agent.ts` -- 3 commands
- `src/cli/commands/tools.ts` -- 3 commands (list, get, invoke)
- `src/cli/commands/server.ts` -- 2 commands (start, status)
- `src/cli/commands/auth.ts` -- 2 commands (login, logout)
- `src/cli/commands/config.ts` -- 2 commands (get, set)

**Example command definition**:

```typescript
// src/cli/commands/context.ts
import { defineCommand } from "citty";
import { createClient } from "../client.js";
import { formatOutput } from "../output.js";

export const saveCommand = defineCommand({
  meta: { name: "save", description: "Save a context memory" },
  args: {
    key: { type: "positional", description: "Memory key", required: true },
    value: { type: "positional", description: "Memory content", required: true },
    category: { type: "string", description: "Category (task, decision, progress, note)" },
    priority: { type: "string", description: "Priority (high, normal, low)" },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const client = createClient();
    const result = await client.post("/api/v1/context", {
      key: args.key,
      value: args.value,
      category: args.category,
      priority: args.priority,
    });
    console.log(formatOutput(result, args.json ? "json" : "table"));
  },
});
```

#### Step 2.3: Shell Completions

**New file**: `src/cli/commands/completions.ts`

```typescript
// src/cli/commands/completions.ts
export const completionsCommand = defineCommand({
  meta: { name: "completions", description: "Output shell completions" },
  args: {
    shell: { type: "positional", description: "Shell type (zsh, bash, fish)", required: true },
  },
  async run({ args }) {
    // Generate completion script from command registry
    // For zsh: _ping-mem function with compdef
    // For bash: complete -F _ping_mem ping-mem
    // For fish: complete -c ping-mem ...
  },
});
```

#### Step 2.4: npm Package Configuration

**Files modified**:
- `package.json` -- update `bin` entry, add `citty` to dependencies

```json
{
  "bin": {
    "ping-mem": "./dist/cli/index.js",
    "ping-mem-mcp": "./dist/mcp/cli.js",
    "ping-mem-http": "./dist/http/index.js"
  }
}
```

The existing `collect` command is preserved as `ping-mem diagnostics collect` (backward compatibility alias).

#### Phase 2 Verification Checklist

| Check | Method | PASS/FAIL |
|-------|--------|-----------|
| `ping-mem --help` lists all command groups | Run command, verify 9 modules + meta commands listed | |
| `ping-mem context save test "hello"` stores memory | Verify via `ping-mem context get test` | |
| `ping-mem tools list` returns 44+ tools | `ping-mem tools list --json \| jq '.count'` | |
| `ping-mem auth login` stores API key | Check `~/.config/ping-mem/auth.json` exists | |
| `ping-mem --version` prints version | Match `package.json` version | |
| `--json` flag works on all commands | `ping-mem context search "test" --json \| jq .` parses | |
| `--quiet` flag suppresses output | `ping-mem context save x y --quiet` returns only exit code | |
| CLI startup time <20ms | `time ping-mem --version` averaged over 10 runs | |
| `bun run typecheck` | 0 errors | |
| `bun test` | 0 failures | |
| `npm pack --dry-run` succeeds | Package is publishable | |

---

### Phase 3: Shell Integration

**Goal**: Shell hooks with background daemon for zero-latency context tracking.
**Effort**: 3-4 days
**Prerequisite**: Phase 2 (CLI binary must exist)

#### Step 3.1: Shell Hook Generator

**New file**: `src/cli/commands/shell-hook.ts`

```typescript
export const shellHookCommand = defineCommand({
  meta: { name: "shell-hook", description: "Output shell integration code" },
  args: {
    shell: { type: "positional", description: "Shell (zsh, bash, fish)", required: true },
  },
  async run({ args }) {
    const hookCode = generateHook(args.shell as "zsh" | "bash" | "fish");
    process.stdout.write(hookCode);
  },
});
```

**Generated zsh hook** (output of `ping-mem shell-hook zsh`):

```zsh
# ping-mem shell integration (zsh)
_ping_mem_sock="${XDG_RUNTIME_DIR:-/tmp}/ping-mem-${UID}.sock"

_ping_mem_send() {
  # Non-blocking write to Unix socket. No-op if daemon is down.
  if [[ -S "$_ping_mem_sock" ]]; then
    echo "$1" | socat - UNIX-CONNECT:"$_ping_mem_sock" 2>/dev/null &!
  fi
}

_ping_mem_precmd() {
  _ping_mem_send "cd:$PWD"
}

_ping_mem_chpwd() {
  _ping_mem_send "chdir:$PWD"
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd _ping_mem_precmd
add-zsh-hook chpwd _ping_mem_chpwd
```

#### Step 3.2: Background Daemon

**New files**:
- `src/cli/daemon.ts` -- daemon lifecycle (start, stop, status, auto-start)
- `src/cli/commands/daemon.ts` -- CLI commands for daemon management

**Function signatures**:

```typescript
// src/cli/daemon.ts
export interface DaemonConfig {
  socketPath: string;  // default: /tmp/ping-mem-${UID}.sock
  pidFile: string;     // default: ~/.config/ping-mem/daemon.pid
  serverUrl: string;   // REST server to proxy events to
}

export function startDaemon(config: DaemonConfig): Promise<void>;
export function stopDaemon(config: DaemonConfig): Promise<void>;
export function isDaemonRunning(config: DaemonConfig): boolean;
```

The daemon:
1. Listens on a Unix domain socket
2. Receives lightweight messages from shell hooks (`cd:/path`, `chdir:/path`, `cmd:git commit`)
3. Batches events and forwards to the REST API (`POST /api/v1/context`)
4. Auto-detects project from `.ping-mem/` or `.git/` in the directory
5. Tracks git branch changes and session boundaries

#### Step 3.3: Auto-Context Tracking

Events the daemon captures:
- `cd` / directory change -- updates project context, detects `.ping-mem/config.json`
- `git branch` change -- detected via `.git/HEAD` file watch
- Session boundaries -- first prompt after 30min idle starts new session

**File modified**: `src/http/rest-server.ts` -- add `POST /api/v1/shell/event` endpoint for daemon-to-server communication.

#### Phase 3 Verification Checklist

| Check | Method | PASS/FAIL |
|-------|--------|-----------|
| `eval "$(ping-mem shell-hook zsh)"` executes without error | Source in fresh zsh session | |
| `ping-mem daemon start` creates socket file | `ls /tmp/ping-mem-*.sock` | |
| `ping-mem daemon status` reports running | Exit code 0 | |
| `cd /some/project` sends event to daemon | Check daemon logs for `chdir:/some/project` | |
| Daemon graceful shutdown on SIGTERM | `ping-mem daemon stop` removes socket + pid file | |
| Shell hook is no-op when daemon is down | `cd /path` with daemon stopped -- no error, no delay | |
| Hook latency <5ms | `time _ping_mem_precmd` | |
| `bun run typecheck` | 0 errors | |
| `bun test` | 0 failures | |

---

### Phase 4: SDK Generation

**Goal**: TypeScript and Python SDKs generated from OpenAPI spec, published to npm and PyPI.
**Effort**: 3-4 days
**Prerequisite**: Phase 1 (OpenAPI spec must exist)

#### Step 4.1: TypeScript SDK via hey-api/openapi-ts

**New files**:
- `sdk/typescript/openapi-ts.config.ts` -- hey-api configuration
- `sdk/typescript/package.json` -- `@ping-gadgets/ping-mem-sdk` package

**Configuration**:

```typescript
// sdk/typescript/openapi-ts.config.ts
import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  client: "@hey-api/client-fetch",
  input: "../../dist/openapi.json",   // Generated by Phase 1
  output: {
    path: "./src",
    format: "prettier",
    lint: "eslint",
  },
  plugins: [
    "@hey-api/typescript",             // Type generation
    "@hey-api/sdk",                    // SDK client methods
    {
      name: "@hey-api/zod",            // Runtime validation
      output: "./src/zod",
    },
  ],
});
```

**Generated SDK usage**:

```typescript
import { client, contextSave, contextSearch, toolsList } from "@ping-gadgets/ping-mem-sdk";

client.setConfig({
  baseUrl: "http://localhost:3000",
  headers: { Authorization: "Bearer pm_xxx" },
});

await contextSave({ body: { key: "fact", value: "TypeScript is great" } });
const results = await contextSearch({ query: { query: "TypeScript" } });
const tools = await toolsList();
```

#### Step 4.2: Python SDK (Manual Thin Wrapper)

**New files**:
- `sdk/python/ping_mem/__init__.py`
- `sdk/python/ping_mem/client.py`
- `sdk/python/ping_mem/types.py`
- `sdk/python/pyproject.toml` -- `ping-mem-sdk` package

**Function signatures**:

```python
# sdk/python/ping_mem/client.py
from dataclasses import dataclass
from typing import Any

@dataclass
class PingMemConfig:
    base_url: str = "http://localhost:3000"
    api_key: str | None = None

class PingMemClient:
    def __init__(self, config: PingMemConfig | None = None) -> None: ...

    # Context
    def context_save(self, key: str, value: str, **kwargs: Any) -> dict: ...
    def context_get(self, key: str) -> dict: ...
    def context_search(self, query: str, **kwargs: Any) -> dict: ...
    def context_delete(self, key: str) -> dict: ...

    # Sessions
    def session_start(self, name: str, **kwargs: Any) -> dict: ...
    def session_end(self, session_id: str) -> dict: ...
    def session_list(self) -> dict: ...

    # Tools (generic)
    def tools_list(self) -> dict: ...
    def tools_invoke(self, name: str, arguments: dict) -> dict: ...

    # ... remaining 34 methods matching REST endpoints
```

#### Step 4.3: CI Pipeline for SDK Generation

**New file**: `.github/workflows/sdk-generate.yml`

```yaml
# Triggered on changes to src/http/ or src/validation/
# 1. Build server, extract /openapi.json
# 2. Run hey-api/openapi-ts to generate TS SDK
# 3. Run Python type generator
# 4. Publish to npm (TS) and PyPI (Python) on tag
```

#### Step 4.4: Example Integrations

**New files**:
- `sdk/examples/langchain-memory.py` -- LangChain custom memory using Python SDK
- `sdk/examples/crewai-agent.py` -- CrewAI agent with ping-mem memory
- `sdk/examples/custom-agent.ts` -- TypeScript agent using SDK

#### Phase 4 Verification Checklist

| Check | Method | PASS/FAIL |
|-------|--------|-----------|
| TS SDK compiles with `tsc --strict` | 0 errors, 0 `any` types | |
| TS SDK has method for every REST endpoint | Count methods == count endpoints | |
| Python SDK type-checks with `mypy --strict` | 0 errors | |
| `npm pack` on TS SDK succeeds | Package is publishable | |
| Python `pip install -e .` succeeds | Package installs locally | |
| TS SDK example runs | `bun run sdk/examples/custom-agent.ts` completes | |
| Python SDK example runs | `python sdk/examples/langchain-memory.py` completes | |
| SDK regeneration is idempotent | Run twice, `diff` shows 0 changes | |

---

## Integration Points

| Component | File Path | Integration |
|-----------|-----------|-------------|
| MCP tool definitions | `src/mcp/handlers/*.ts` (9 modules) | Source of truth for tool names + schemas |
| MCP tool aggregation | `src/mcp/PingMemServer.ts` (line 115: `TOOLS`) | Imported by tool discovery handler |
| REST server routes | `src/http/rest-server.ts` + `src/http/routes/*.ts` (new) | 18 new routes added, existing 35 unchanged, file split into sub-modules |
| Zod validation schemas | `src/validation/api-schemas.ts` | Reused in `hono-zod-openapi` middleware |
| HTTP server entry | `src/http/server.ts` | Port consolidation logic |
| CLI entry point | `src/cli.ts` (current) -> `src/cli/index.ts` (new) | Replace hand-rolled parser with Citty |
| package.json bin | `package.json` line 7-11 | Update `ping-mem` bin entry |
| MCP tool dispatch | `src/mcp/PingMemServer.ts:dispatchToolCall()` | Used by `/tools/:name/invoke` handler — **requires injecting PingMemServer instance into RESTPingMemServer** (see Architecture Notes) |
| Session state | `src/mcp/handlers/shared.ts:SessionState` | **NOT shared** between REST and MCP — each server has independent in-memory state. EventStore (SQLite) is shared at storage level. |
| Config runtime | `src/config/runtime.ts` | Server startup configuration |

---

## Architecture Notes (from EVAL pass)

### 1. Tool Invoke Endpoint Requires Instance Injection

`/api/v1/tools/:name/invoke` needs a live `PingMemServer` instance to call `dispatchToolCall()`. The static `TOOLS` array only provides schemas (sufficient for `/tools` and `/tools/:name`). Solution: `server.ts` startup code must inject a `PingMemServer` instance into `RESTPingMemServer` constructor. Both already share `EventStore` via injection — extend this pattern to include the tool dispatch capability.

### 2. REST and MCP Have Separate Session State

`RESTPingMemServer` has its own `currentSessionId` + `memoryManagers` map. `PingMemServer` has its own `SessionState`. They do NOT share in-memory state. The shared `EventStore` (SQLite) ensures persistence is unified, but concurrent REST + MCP sessions will have divergent in-memory views. New routes must require explicit `X-Session-ID` header rather than relying on `this.currentSessionId` (which is a server-wide mutable field — pre-existing race condition for concurrent REST clients).

### 3. Shell Hook Portability

The zsh hook uses `socat` which is not installed by default on macOS. Must use `/dev/tcp` fallback on macOS or `nc -U` (BSD netcat, available by default). Auto-detect in generated hook script.

### 4. Hono Dependency Declaration

`hono` is imported in 4+ production files but NOT declared in `package.json`. Must add as explicit dependency before any Phase 1 work. Currently resolves via transient dependency chain.

### 5. hey-api Zod Plugin Compatibility

Phase 4's `@hey-api/zod` plugin generates Zod schemas. Must verify it generates Zod v4 syntax since the server uses Zod v4. Pin to a version that supports Zod v4 or skip the Zod plugin (type-only generation is sufficient).

---

## Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Citty v0.x stability issues | Medium | Low | Commander.js fallback, 1-day migration |
| `hono-zod-openapi` integration issues | Low | Medium | Middleware approach — no class migration needed, additive only. Fallback: `@asteasolutions/zod-to-openapi` v8.x |
| OpenAPI spec generation produces invalid spec | Low | Medium | CI validation with `@redocly/cli lint` on every build |
| Unix socket daemon leaves orphan processes | Medium | Medium | PID file management, stale socket detection, SIGTERM handler |
| hey-api generates code with type errors | Low | Low | Pin to known-good version, run `tsc --strict` in CI |
| Port consolidation breaks existing deployments | Medium | High | `PING_MEM_PORT` env var preserved for backward compat, deprecation notice for 3003 |
| Shell hook causes shell startup lag | Low | High | Hook is async (no-op if daemon down), socket write is fire-and-forget |

---

## Dependencies

| Package | Version | Phase | Purpose |
|---------|---------|-------|---------|
| `citty` | `^0.1.6` | 2 | CLI framework |
| `hono-zod-openapi` | `^1.0.0` | 1 | OpenAPI generation (Zod v4 compatible, NOT @hono/zod-openapi which requires Zod v3) |
| `@hey-api/openapi-ts` | `^0.64.0` | 4 | TypeScript SDK generation |
| `@hey-api/client-fetch` | `^0.8.0` | 4 | Generated SDK HTTP client |
| `@redocly/cli` | `^1.0.0` | 1 (devDep) | OpenAPI spec linting in CI |
| `hono` | `^4.x` (existing) | 1 | HTTP framework (already installed) |
| `zod` | `^4.x` (existing) | 1 | Schema validation (already installed) |

---

## Success Metrics

| Metric | Phase | Target | How Measured |
|--------|-------|--------|-------------|
| REST-MCP parity | 1 | 44/44 tools have REST endpoints | Automated: `curl /api/v1/tools \| jq .count` |
| OpenAPI spec validity | 1 | 0 lint errors | CI: `redocly lint openapi.json` |
| CLI command count | 2 | 44+ tool commands + 8 meta commands | `ping-mem --help` output |
| CLI startup time | 2 | <20ms | `time ping-mem --version` (10-run average) |
| Shell hook latency | 3 | <5ms per prompt | `time _ping_mem_precmd` (10-run average) |
| TS SDK type safety | 4 | 0 `any` types, `tsc --strict` passes | CI: `tsc --strict --noEmit` |
| Python SDK type safety | 4 | `mypy --strict` passes | CI: `mypy sdk/python/` |
| Test suite green | all | 0 failures | `bun test` after each phase |
| Typecheck clean | all | 0 errors | `bun run typecheck` after each phase |

---

## Effort Summary

| Phase | Description | Effort | Cumulative |
|-------|-------------|--------|-----------|
| 1 | REST API Consolidation | 3-4 days | 3-4 days |
| 2 | CLI Binary | 4-5 days | 7-9 days |
| 3 | Shell Integration | 3-4 days | 10-13 days |
| 4 | SDK Generation | 3-4 days | 13-17 days |

Each phase is independently shippable and provides standalone value:
- **Phase 1 alone**: Full REST API for integrations, OpenAPI spec for documentation
- **Phase 1 + 2**: Complete CLI experience for daily use
- **Phase 1 + 2 + 3**: Ambient context tracking from shell
- **All phases**: Full ecosystem with generated SDKs
