# ping-mem Web UI Brainstorm

**Date**: 2026-02-18
**Status**: Approved
**Version**: 1.0

---

## What We're Building

A **full observability web UI** for ping-mem that provides total transparency into what ping-mem knows, how it's working, and what issues exist across all registered projects. Dual-purpose: serves both human developers (visual dashboard) and AI agents (queryable interface).

### Core Views (5)

1. **Memory Explorer** - Browse, search, filter all stored memories by project/session/category. View relationships, lineage, and entity graphs.

2. **Ingestion Monitor** - Real-time pipeline status, Neo4j/Qdrant health, per-project ingestion progress and error logs. Shows scan/chunk/persist/index stages.

3. **LLM Q&A Chat** - Natural language questions about everything in ping-mem. Global chat sidebar (persistent) + contextual Q&A on every dashboard view. Streams responses with citations to stored memories/code.

4. **Diagnostics Dashboard** - SARIF findings trends over time, symbol-level attribution, cross-tool comparisons (tsc/eslint/prettier), regression detection between runs.

5. **Issue Tracker** - Unresolved issues per project/codebase sourced from ping-mem's detection engines (diagnostics findings, audit results, quality gate failures). Not a generic issue tracker - a ping-mem-native view of what's broken.

---

## Why This Approach

### Architecture: Vite + React SPA

- **Vite + React 19 + TypeScript** - Fast build, hot reload, simple deployment
- **shadcn/ui + Tailwind CSS** - Polished component library, consistent design
- **Framer Motion** - Smooth transitions, animated data visualizations
- **Tanstack Query** - Server state management, caching, real-time refetch
- **React Router v7** - Client-side routing

**Rejected alternatives**:
- Next.js App Router: Overkill for a dashboard app, heavier deployment (needs Node.js runtime)
- Tanstack Start: Bleeding edge, insufficient ecosystem maturity
- Remotion: YAGNI for now, Framer Motion handles all needed animations

### LLM Strategy: Ollama Primary + Gemini Flash Fallback

- **Primary**: Ollama (local) with `qwen3:8b` (Qwen3 generation - claims 4B rivals Qwen2.5-72B)
- **Secondary local**: `llama3.1:8b-instruct` (fallback if qwen3 issues)
- **Cloud fallback**: Gemini API with `gemini-2.0-flash` (ensure LLM features are never offline)
- **Embedding**: `nomic-embed-text` via Ollama for local semantic search

The frontend proxies LLM calls through the ping-mem REST API (or a thin proxy) to avoid exposing API keys in the browser.

### Deployment: Identical Local + VPS

- **Separate frontend app** - Standalone repo/directory, connects to ping-mem REST API
- **Docker container**: nginx serves static React build + proxies API requests to ping-mem backend
- **Identical deployment**: Same Docker image deployed on both local and VPS
- **Temporary duplication**: Both environments run until VPS-only (target: ~1 week from now)

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Framework | Vite + React SPA | Fastest to build, simplest deployment |
| UI Library | shadcn/ui + Tailwind | Polished, accessible, consistent |
| Animations | Framer Motion | Sufficient for dashboard UX |
| Data fetching | Tanstack Query | Caching, refetch, optimistic updates |
| LLM primary | Ollama (qwen3:8b) | Latest gen, local, no API costs |
| LLM secondary | Ollama (llama3.1:8b) | Local fallback |
| LLM cloud fallback | Gemini 2.0 Flash | Always-on, high quality |
| Deployment | nginx Docker container | Static files + API proxy |
| Local + VPS | Identical Docker images | Same experience everywhere |
| Remotion | Skipped | YAGNI - revisit if video reports needed |
| Persona | Human + Agent dual-purpose | Agent-native from day one |

---

## Feature Details

### Memory Explorer
- Table/grid view with search and filters (project, session, category, channel, priority)
- Memory detail panel with full metadata, timestamps, relationships
- Entity graph visualization (force-directed or hierarchical)
- Lineage tracing (upstream/downstream dependencies)
- Cross-session recall indicators

### Ingestion Monitor
- Per-project pipeline status cards (scanning, chunking, persisting, indexing)
- Real-time progress bars during active ingestion
- Neo4j connection health (node counts, relationship counts)
- Qdrant health (collection stats, vector counts)
- Error log with timestamps and stack traces
- Registered projects list with last-ingested timestamps

### LLM Q&A Chat
- **Global sidebar**: Persistent chat that follows you across views
- **Contextual Q&A**: Each view has a "Ask about this" input that pre-fills context
- Streaming responses with token-by-token rendering
- Citations linking back to specific memories, code chunks, or diagnostics
- Model indicator showing Ollama vs Gemini (fallback awareness)
- Conversation history within session

### Diagnostics Dashboard
- Trend charts: findings count over time by severity
- Tool comparison: tsc vs eslint vs prettier side-by-side
- Symbol-level drill-down: which functions/classes have the most issues
- Diff view: introduced vs resolved findings between runs
- LLM-powered summaries (via existing `diagnostics_summarize` endpoint)

### Issue Tracker (ping-mem native)
- Aggregated unresolved issues from all detection engines
- Grouped by project, then by severity (P0/P1/P2/P3)
- Source attribution (diagnostics, audit, quality gate)
- Status tracking (open/in-progress/resolved)
- Timeline of when issues were detected and resolved

---

## API Surface (Existing - Ready to Consume)

The ping-mem REST API already exposes everything needed:

| Feature | Endpoints |
|---------|-----------|
| Memory | `POST /api/v1/context`, `GET /api/v1/context/:key`, `GET /api/v1/search` |
| Sessions | `POST /api/v1/session/start`, `GET /api/v1/session/list` |
| Diagnostics | `GET /api/v1/diagnostics/latest`, `POST /api/v1/diagnostics/diff`, `POST /api/v1/diagnostics/summarize/:id` |
| Codebase | `GET /api/v1/codebase/search`, `GET /api/v1/codebase/timeline` |
| Status | `GET /api/v1/status`, `GET /api/v1/memory/stats` |
| Admin | `GET /api/admin/projects`, `GET /api/admin/keys`, `GET /api/admin/llm-config` |
| Health | `GET /health` |

**New endpoints needed**:
- `POST /api/v1/llm/chat` - Proxy LLM calls (Ollama primary, Gemini fallback)
- `GET /api/v1/issues` - Aggregated unresolved issues (or client-side aggregation from diagnostics)
- `GET /api/v1/ingestion/status` - Real-time ingestion pipeline status (may need SSE)

---

## Open Questions

1. **Should we pull `qwen2.5-coder:7b`** for better code Q&A, or stick with llama3.1:8b?
2. **Issue Tracker persistence** - Store issue status in ping-mem (new SQLite table) or derive entirely from diagnostics data?
3. **Real-time updates** - Use SSE endpoint for live ingestion progress, or poll with Tanstack Query refetchInterval?
4. **Auth for UI** - Reuse admin Basic Auth? Add proper session-based auth? Or no auth for local (auth only on VPS)?
5. **Repo location** - New repo `ping-mem-ui`? Or `packages/web` in ping-mem monorepo?

---

## Tech Stack Summary

```
Frontend:
  - Vite 6.x + React 19 + TypeScript 5.x
  - shadcn/ui + Tailwind CSS 4.x
  - Framer Motion 12.x
  - Tanstack Query v5
  - React Router v7
  - Recharts or Nivo (charts)
  - React Flow or d3-force (graph visualization)

LLM Integration:
  - Primary: Ollama (qwen3:8b, local)
  - Fallback: Gemini 2.0 Flash (API)
  - Embedding: nomic-embed-text (local)

Deployment:
  - Docker (nginx:alpine + static build)
  - Environments: local (localhost:5173 dev / :8080 prod) + VPS (ping-mem-ui.ping-gadgets.com)

Backend (existing):
  - ping-mem REST API (:3003 Docker / :3000 local)
  - New: /api/v1/llm/chat proxy endpoint
```

---

## Next Steps

Run `/workflows:plan` to create the implementation plan with waves, file lists, and test gates.
