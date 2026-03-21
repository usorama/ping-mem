# ping-mem CLI + REST API + SDK: Research & Recommendations

**Date**: 2026-03-16
**Purpose**: Research patterns for building a universal CLI, REST API, and SDK for the ping-mem AI memory system.

---

## 1. TypeScript CLI Framework Selection

### Candidates Evaluated

| Framework | Weekly Downloads | Dependencies | Startup Time | TypeScript | Plugin System |
|-----------|-----------------|-------------|-------------|------------|---------------|
| **Commander.js** | ~500M | 0 | ~18ms | Good (DefinitelyTyped) | No |
| **Yargs** | ~200M | ~7 | ~35ms | Good | Middleware only |
| **Oclif** | ~2M | ~30 | ~85ms | Native | Yes (full) |
| **Citty** | ~500K | 0 (ESM-only) | ~15ms | Native (TypeScript-first) | No (Issue #130 open) |

### Detailed Analysis

**Commander.js** — Veteran, most popular. Zero dependencies. Clean chainable API. TypeScript support via DefinitelyTyped (not native). Best for simple-to-moderate CLIs. Lacks built-in shell completion, plugin system, and typo suggestions.

**Yargs** — Richer middleware and configuration. Built-in shell completion and typo suggestions. Nested subcommands. 7 dependencies add weight. Good for complex argument parsing but middleware model is less intuitive than command-based patterns.

**Oclif** (Salesforce) — Full framework: scaffolding, plugins, hooks, auto-generated help, shell completion. 30+ dependencies and 85ms startup make it heavyweight. Best for large enterprise CLIs (Heroku, Salesforce). Overkill for a focused memory tool.

**Citty** (UnJS) — ESM-only, zero dependencies, TypeScript-first with native type inference. Uses `node:util.parseArgs` internally. Provides `defineCommand`, `runMain`, cleanup hooks, enum arg types, and `meta.hidden` for internal subcommands. Lightweight and modern. No plugin system yet (Issue #130 open), but ping-mem doesn't need one — extensibility comes from the REST API, not CLI plugins.

### Recommendation: **Citty**

**Justification:**
1. **TypeScript-first** — Native type inference on args, no DefinitelyTyped needed. ping-mem is 100% TypeScript; the CLI framework should be too.
2. **Zero dependencies** — Matches ping-mem's philosophy of minimal footprint. Commander also has 0 deps but lacks native TS.
3. **ESM-only** — ping-mem already uses ESM. No dual CJS/ESM headaches.
4. **Fast startup (~15ms)** — Critical for shell hook integration (runs on every prompt). Oclif's 85ms is unacceptable for prompt hooks.
5. **UnJS ecosystem** — Aligns with modern Node.js tooling (Nitro, H3, ofetch). Same design philosophy.
6. **`defineCommand` pattern** — Maps cleanly to ping-mem's tool registry: each MCP tool becomes a CLI subcommand via `defineCommand`.

**Runner-up: Commander.js** — If Citty proves too young (v0.x), Commander is the safe fallback with proven stability.

---

## 2. REST API Design for Tool/Function Registries

### Core Principles

From Microsoft Azure Architecture Center, Stack Overflow, and industry best practices:

1. **Resources as nouns, HTTP methods as verbs** — `POST /memories` (create), `GET /memories/:id` (read), `DELETE /memories/:id` (delete), `GET /memories/search?q=...` (search).
2. **Shallow hierarchy** — `/memories`, `/sessions`, `/tools` as top-level resources. Avoid deep nesting like `/users/:id/sessions/:sid/memories/:mid`.
3. **Consistent envelope** — Every response uses `{ data, error, meta }` structure.
4. **Stateless auth** — JWT or API key in `Authorization` header.

### Tool Registry Pattern for ping-mem

The key insight from service registry patterns (microservices.io) and SDK design research (vineeth.io):

```
Registry Model:
  /tools              → GET: list all registered tools (discovery)
  /tools/:name        → GET: tool schema (JSON Schema for args)
  /tools/:name/invoke → POST: execute tool with args body

Memory-Specific Routes (high-level resource API):
  /memories           → POST: store memory, GET: list/search
  /memories/:id       → GET/PUT/DELETE: CRUD on specific memory
  /sessions           → POST/GET: session management
  /codebase           → POST: index, GET: search
  /graph              → GET: query knowledge graph
```

**Dual-layer design:**
- **Resource API** (`/memories`, `/sessions`) — Clean REST for SDKs and integrations
- **Tool API** (`/tools/:name/invoke`) — Generic invocation for MCP clients and AI agents

This mirrors Mem0's architecture: FastAPI server exposing CRUD endpoints, with an OpenAPI spec at `/docs` for interactive exploration.

### Recommendation

Use **Hono** (lightweight, runs everywhere — Node, Bun, Cloudflare Workers, Deno) as the HTTP framework. It has native OpenAPI support via `@hono/zod-openapi`, which generates the spec from route definitions. This spec then drives SDK generation.

---

## 3. Thin-Client CLI Architecture (Supabase, Vercel, GitHub CLI)

### Pattern Analysis

**GitHub CLI (`gh`)**
- Built in Go with Cobra framework
- Tree-based command structure: `gh` → `gh pr` → `gh pr create`
- Factory pattern for dependency injection (API client, git operations, auth, config, terminal I/O)
- Thin client: most commands translate to 1-2 GitHub API calls (REST or GraphQL)
- Auth stored locally (`~/.config/gh/hosts.yml`), sent as Bearer token
- Extension system: external commands discovered and executed as subcommands
- `go-gh` module lets extensions reuse the same auth and API client

**Supabase CLI**
- Built in Go
- Orchestrates Docker containers for local dev, calls Supabase Management API for remote operations
- Dual mode: local (Docker) and remote (API calls to `api.supabase.com`)
- Auth via `supabase login` stores access token locally
- Config in `supabase/config.toml` per project

**Vercel CLI**
- Built in TypeScript/Node.js
- Thin client calling Vercel REST API (`api.vercel.com`)
- Auth via `vercel login` (OAuth flow), token in `~/.vercel/auth.json`
- Project linking via `.vercel/project.json` in repo root
- Env var management: CLI reads/writes via API, no local state

### Common Architecture Pattern

All three follow the same thin-client pattern:

```
┌──────────┐    HTTP/REST    ┌──────────────┐    ┌──────────┐
│   CLI    │ ──────────────→ │   REST API   │ ──→│ Database │
│ (thin)   │ ←────────────── │   Server     │ ←──│ + Store  │
└──────────┘    JSON resp    └──────────────┘    └──────────┘
     │
     ├── Auth token stored locally (~/.config/<tool>/)
     ├── Project config in repo (.vercel/, supabase/config.toml)
     └── Commands map 1:1 to API endpoints
```

### Recommendation for ping-mem

```
ping-mem CLI Architecture:
  ~/.config/ping-mem/
    ├── auth.json          # API key or JWT
    ├── config.json        # default server URL, preferences
    └── sessions/          # cached session state

  Commands map directly to REST API:
    ping-mem store "fact"     → POST /memories
    ping-mem search "query"   → GET /memories/search?q=query
    ping-mem session start    → POST /sessions
    ping-mem tools list       → GET /tools
    ping-mem tools invoke X   → POST /tools/X/invoke
```

The CLI should be a **pure API client** — zero business logic. All intelligence lives in the server. This enables the SDK, CLI, and MCP server to share identical behavior.

---

## 4. Shell Integration Patterns

### Industry Patterns

**direnv** — `eval "$(direnv hook zsh)"`:
- Outputs shell function that hooks into `precmd` (zsh) or `PROMPT_COMMAND` (bash)
- Before each prompt, checks for `.envrc` in current/parent directories
- Loads/unloads environment variables automatically
- Performance: compiled Go binary, unnoticeable latency per prompt

**Starship** — `eval "$(starship init zsh)"`:
- Outputs shell function replacing the prompt rendering
- Reads `starship.toml` for configuration
- Each prompt render queries git, directory, language versions
- Performance: compiled Rust binary, <10ms per prompt

**zoxide** — `eval "$(zoxide init zsh)"`:
- Outputs shell function wrapping `cd` command
- Tracks directory visits in a local database
- Provides `z` command for fuzzy directory jumping

### Common Pattern

```bash
# Tool outputs shell-specific code:
mytool hook zsh   # → outputs zsh-compatible shell functions

# User adds to ~/.zshrc:
eval "$(mytool hook zsh)"
```

The `hook` subcommand:
1. Detects the target shell (bash/zsh/fish)
2. Outputs shell functions that intercept events (cd, prompt, command)
3. Those functions call back to the CLI binary for logic
4. `eval` executes the output in the current shell context

### Recommendation for ping-mem

```bash
# User adds to ~/.zshrc:
eval "$(ping-mem shell-hook zsh)"

# This outputs:
# 1. precmd hook: auto-capture cd events → ping-mem codebase context
# 2. preexec hook: capture commands for session context
# 3. Helper functions: pm() wrapper for common operations
# 4. Completion: register zsh completions for ping-mem commands
```

**Key design decisions:**
- `ping-mem shell-hook <shell>` generates shell-specific code (zsh, bash, fish)
- Hook is lightweight: calls `ping-mem` binary only on meaningful events (directory change, not every keystroke)
- Auto-detect project context from `.ping-mem/` config directory
- Completions generated from the OpenAPI spec (tool names, subcommands)
- Performance budget: <5ms per prompt hook execution (Citty's 15ms startup means the hook should cache/batch)

**Performance optimization:**
- Use a background daemon (`ping-mem daemon`) that the shell hook communicates with via Unix socket
- Shell hook sends events to daemon (non-blocking), daemon batches and processes
- This avoids spawning a new Node.js process on every prompt (cold start penalty)

---

## 5. SDK Generation from OpenAPI Specs

### Tools Evaluated

| Tool | Languages | Quality | Customizable | Used By |
|------|-----------|---------|-------------|---------|
| **Stainless** | TS, Python, Go, Java, Kotlin, Ruby, C#, PHP, Terraform | Production-grade | Yes (edits persist across re-gen) | OpenAI, Anthropic, Cloudflare, Meta |
| **Fern** | TS, Python, Go, Java, C#, PHP, Ruby, Swift, Rust | Production-grade | Yes (Fern Definition or OpenAPI) | Multiple API companies |
| **hey-api/openapi-ts** | TypeScript only | Production-grade | 20+ plugins (Zod, TanStack Query) | Vercel, OpenCode, PayPal |
| **openapi-generator** | 50+ languages | Basic scaffolding | Mustache templates | Wide open-source |
| **openapi-typescript** | TypeScript types only | Types only (no client) | Limited | Type generation only |

### Key Findings

**Stainless** (used by OpenAI, Anthropic, Cloudflare):
- Generates SDKs that feel hand-crafted, not machine-generated
- Handles HTTP requests, retries with exponential backoff, streaming, pagination
- Generated code is editable — custom changes survive re-generation
- CI/CD integration: spec change → SDK regeneration → publish to npm/PyPI
- Pricing: commercial (not open-source)

**Fern**:
- Open-source alternative to Stainless
- Generates idiomatic code per language (Python snake_case, TS async/await)
- Also generates API reference docs from the same spec
- Free tier available

**hey-api/openapi-ts**:
- TypeScript-only but extremely good at it
- 20+ plugins: Zod validation schemas, TanStack Query hooks, fetch/axios clients
- Used by Vercel and PayPal — production proven
- Open source, actively maintained

### Recommendation: **hey-api/openapi-ts** (TypeScript) + **Fern** (Python)

**Justification:**
1. **hey-api/openapi-ts for TypeScript SDK** — ping-mem's primary audience is TypeScript developers (Claude Code, Cursor, VS Code extensions). hey-api generates the best TypeScript output with Zod validation, proper types, and modern fetch client. Used by Vercel — proven at scale. Open source, no vendor lock-in.
2. **Fern for Python SDK** — Python is essential for LangChain/LlamaIndex/CrewAI integrations. Fern generates idiomatic Python with type hints and docstrings. Free tier covers ping-mem's needs.
3. **OpenAPI spec as single source of truth** — Use `@hono/zod-openapi` to define routes with Zod schemas. The spec is auto-generated from code, not hand-maintained. Both SDK generators consume the same spec.

**Pipeline:**
```
Hono routes (with Zod schemas)
  → @hono/zod-openapi generates OpenAPI spec
    → hey-api/openapi-ts generates TypeScript SDK
    → Fern generates Python SDK
    → Spec published at /openapi.json for third-party generators
```

Stainless is the gold standard but is commercial and overkill for ping-mem's current stage. Revisit when the API stabilizes and paid users need enterprise-grade SDKs.

---

## 6. AI Memory System API Patterns (Mem0, Zep, LangChain)

### Mem0

**Architecture**: Three-tier — client layer, core memory system, storage backends.

**API Surface (FastAPI REST)**:
```
POST   /v1/memories/           # Add memory (text + metadata)
GET    /v1/memories/           # List memories (filter by user_id, agent_id, run_id)
GET    /v1/memories/{id}/      # Get specific memory
PUT    /v1/memories/{id}/      # Update memory
DELETE /v1/memories/{id}/      # Delete memory
POST   /v1/memories/search/    # Semantic search with filters
DELETE /v1/memories/           # Reset (delete all for a user/agent)
GET    /health/                # Health check
```

**Key design decisions:**
- Memories are scoped by `user_id`, `agent_id`, or `run_id` — always multi-tenant
- Search supports advanced filtering (logical AND/OR, metadata queries)
- Conflict resolution: LLM-based — extracts facts, searches existing memories, decides ADD/UPDATE/DELETE/NONE
- Self-hosted stack: FastAPI + PostgreSQL/pgvector + Neo4j (3 Docker containers)
- OpenAPI explorer at `/docs` for interactive testing
- SDKs: Python (`mem0ai`), JavaScript (`mem0ai`), REST/cURL

**What ping-mem can learn:**
- The `/memories/search` endpoint with rich filtering is essential
- Multi-tenant scoping (user_id, agent_id, run_id) maps to ping-mem's session/project/user model
- FastAPI + OpenAPI auto-docs is the pattern to follow (Hono + zod-openapi is the TS equivalent)

### Zep

**Architecture**: Knowledge graph-based memory with temporal awareness.

**Key differentiator:** Powered by Graphiti (open-source temporal knowledge graph). Relationships between memories are first-class, not just vector similarity.

**API Surface:**
- Session-based memory (conversation history)
- Entity extraction and relationship tracking
- Fact synthesis and classification
- SDKs: Python, TypeScript, Go
- Cloud + self-hosted options

**What ping-mem can learn:**
- Temporal awareness (when was something learned, has it changed?) is valuable
- Graph relationships between memories enable richer retrieval than pure vector search
- Session-based grouping is essential for conversation context

### LangChain Memory

**Architecture:** Memory as a pluggable component in agent chains.

**Types:**
- `ConversationBufferMemory` — raw history
- `ConversationSummaryMemory` — LLM-summarized
- `VectorStoreRetrieverMemory` — semantic search over history
- `EntityMemory` — tracks entities mentioned in conversation

**Integration pattern:** Memory components are injected into chains/agents, storing and retrieving context automatically.

**What ping-mem can learn:**
- The pluggable memory type model is powerful — ping-mem already has this via tools
- LangChain's memory is chain-scoped, not cross-chain — ping-mem's cross-session, cross-project memory is a differentiator

### Supermemory

**Architecture:** "Memory API for the AI era" — fast, scalable memory engine.

**What ping-mem can learn:**
- Positioning as "memory API" rather than "memory database" emphasizes the intelligence layer
- Speed and scalability are marketing differentiators

---

## 7. Consolidated Architecture Recommendation

### Stack

| Layer | Technology | Justification |
|-------|-----------|---------------|
| **CLI Framework** | Citty (UnJS) | TypeScript-first, 0 deps, ESM-only, ~15ms startup |
| **HTTP Framework** | Hono + @hono/zod-openapi | Lightweight, runs everywhere, auto-generates OpenAPI spec |
| **Auth** | API key (simple) + JWT (sessions) | API key for CLI/SDK, JWT for web dashboard |
| **TypeScript SDK** | hey-api/openapi-ts | Best TS output, Zod validation, used by Vercel |
| **Python SDK** | Fern (free tier) | Idiomatic Python, type hints, docstrings |
| **Shell Integration** | `eval "$(ping-mem shell-hook zsh)"` | direnv/starship pattern, background daemon for perf |
| **API Pattern** | Dual-layer (Resource + Tool invocation) | Clean REST for humans, generic tool invoke for AI agents |

### Command Structure

```
ping-mem
  ├── store <text>              # Store a memory
  ├── search <query>            # Semantic search
  ├── recall <query>            # Alias for search (natural language)
  ├── forget <id>               # Delete a memory
  ├── session
  │   ├── start                 # Begin a new session
  │   ├── end                   # End current session
  │   └── list                  # List sessions
  ├── codebase
  │   ├── index [path]          # Index a codebase
  │   └── search <query>        # Search codebase knowledge
  ├── tools
  │   ├── list                  # List available tools
  │   └── invoke <name> [args]  # Invoke a tool directly
  ├── config
  │   ├── set <key> <value>     # Set configuration
  │   └── get [key]             # Get configuration
  ├── auth
  │   ├── login                 # Authenticate
  │   └── logout                # Clear credentials
  ├── server
  │   ├── start                 # Start REST API server
  │   └── status                # Check server status
  ├── shell-hook <shell>        # Output shell integration code
  └── completions <shell>       # Output shell completions
```

### Data Flow

```
Shell Hook ──→ Unix Socket ──→ ping-mem daemon ──→ SQLite/pgvector
     │                              ↑
CLI ─────────→ REST API ────────────┘
     │              ↑
SDK ─────────→──────┘
     │
MCP Server ──→ Tool Registry ──→ same REST API internally
```

The daemon is the single source of truth. CLI, SDK, MCP, and shell hook all communicate with it. The REST API can run embedded in the daemon (local mode) or as a standalone server (remote/cloud mode).

---

## Sources

### CLI Frameworks
- [CLI Framework Comparison: Commander vs Yargs vs Oclif](https://www.grizzlypeaksoftware.com/library/cli-framework-comparison-commander-vs-yargs-vs-oclif-utxlf9v9)
- [In-Depth Comparison of CLI Frameworks](https://www.oreateai.com/blog/indepth-comparison-of-cli-frameworks-technical-features-and-application-scenarios-of-yargs-commander-and-oclif/24440ae03bfbae6c4916c403a728f6da)
- [Citty — Elegant CLI Builder by UnJS](https://github.com/unjs/citty)
- [Oclif: The Open CLI Framework](https://oclif.io/)
- [Stricli Alternatives Considered](https://bloomberg.github.io/stricli/docs/getting-started/alternatives)
- [npm-compare: commander vs oclif vs yargs](https://npm-compare.com/commander,oclif,vorpal,yargs)

### REST API Design
- [Web API Design Best Practices — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/best-practices/api-design)
- [REST API Design Guidance — Microsoft Engineering Playbook](https://microsoft.github.io/code-with-engineering-playbook/design/design-patterns/rest-api-design-guidance/)
- [Best Practices for REST API Design — Stack Overflow](https://stackoverflow.blog/2020/03/02/best-practices-for-rest-api-design/)
- [SDK Design Patterns](https://vineeth.io/posts/sdk-development)
- [Service Registry Pattern](https://microservices.io/patterns/service-registry.html)

### Thin-Client CLI Architecture
- [GitHub CLI Architecture — Augment Code](https://www.augmentcode.com/open-source/cli/cli)
- [go-gh: A Go module for interacting with gh](https://github.com/cli/go-gh)
- [Supabase CLI Docs](https://supabase.com/docs/guides/local-development/cli/getting-started)
- [Supabase CLI Source](https://github.com/supabase/cli)

### Shell Integration
- [direnv Hook Setup](https://direnv.net/docs/hook.html)
- [Starship Cross-Shell Prompt](https://starship.rs/)
- [Devbox Shell Integration — DeepWiki](https://deepwiki.com/jetify-com/devbox/4.2-shell-integration)

### SDK Generation
- [Stainless — SDKs for OpenAI, Anthropic, Cloudflare](https://www.stainless.com/)
- [Stainless SDK Generator Announcement](https://www.stainless.com/blog/announcing-the-stainless-sdk-generator)
- [hey-api/openapi-ts — Used by Vercel, PayPal](https://github.com/hey-api/openapi-ts)
- [Fern — Best SDK Generation Tools 2025](https://buildwithfern.com/post/best-sdk-generation-tools-multi-language-api)
- [OpenAPI TypeScript](https://openapi-ts.dev/)
- [FastAPI — Generating SDKs](https://fastapi.tiangolo.com/advanced/generate-clients/)

### AI Memory Systems
- [Mem0 REST API Server](https://docs.mem0.ai/open-source/features/rest-api)
- [Mem0 Architecture — DeepWiki](https://deepwiki.com/mem0ai/mem0)
- [Mem0 REST API Reference — DeepWiki](https://deepwiki.com/mem0ai/mem0/7.2-rest-api-reference)
- [Survey of AI Agent Memory Frameworks — Graphlit](https://www.graphlit.com/blog/survey-of-ai-agent-memory-frameworks)
- [Agent Memory: Letta vs Mem0 vs Zep vs Cognee](https://forum.letta.com/t/agent-memory-letta-vs-mem0-vs-zep-vs-cognee/88)
- [Zep GitHub](https://github.com/getzep/zep)
- [Supermemory GitHub](https://github.com/supermemoryai/supermemory)
