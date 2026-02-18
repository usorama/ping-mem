---
title: "feat: ping-mem Web UI Observability Dashboard"
type: feat
date: 2026-02-18
version: 2.0.0
brainstorm: docs/brainstorms/2026-02-18-ping-mem-web-ui-brainstorm.md
reviews: DHH (go server-rendered), Kieran (Phase 0 underscoped), Simplicity (cut 60%)
pivot: v1 was React SPA (114 files, 6 phases). v2 is HTMX + server-rendered HTML (~25 files, 3 phases)
---

# ping-mem Web UI Observability Dashboard

## Overview

Extend the existing ping-mem Hono server with server-rendered HTML views + HTMX for interactivity. No separate frontend repo, no React, no build step, no additional Docker container. The admin panel (`src/http/admin.ts`) already proves this pattern works — scale it to a full dashboard.

**Why this approach**: The backend has direct access to MemoryManager, DiagnosticsStore, EventStore, and IngestionService. Server-rendered HTML eliminates the JSON serialization round-trip, the need for most new API endpoints, CORS configuration, and a separate deployment artifact.

## Problem Statement

Same as before: developers and agents have zero visibility into what ping-mem knows. But the solution is dramatically simpler.

## Technical Approach

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser                                             │
│  HTML + HTMX (14KB) + Chart.js (CDN) + vanilla JS   │
│  No build step. No bundler. No framework.            │
└──────────────────┬──────────────────────────────────┘
                   │ HTTP (full pages + HTMX partials)
┌──────────────────▼──────────────────────────────────┐
│  ping-mem Hono server (existing)                     │
│  /ui/*           → Server-rendered HTML views        │
│  /ui/partials/*  → HTMX partial responses            │
│  /api/v1/*       → Existing REST API (unchanged)     │
│  /admin          → Existing admin panel (unchanged)  │
│                                                      │
│  Direct access: MemoryManager, DiagnosticsStore,     │
│  EventStore, IngestionService, Neo4j, Qdrant         │
└─────────────────────────────────────────────────────┘
```

**Key insight**: No new API endpoints needed for most views. The rendering layer queries data stores directly, just like `admin.ts` already does.

### What We Ship

4 views served from the existing ping-mem process:

1. **Dashboard** (`/ui`) — Stats, recent events, quick-access links
2. **Memory Explorer** (`/ui/memories`) — Browse, search, filter, detail panel
3. **Diagnostics** (`/ui/diagnostics`) — Runs list, findings, diffs, severity summary
4. **Ingestion Monitor** (`/ui/ingestion`) — Project list, health, reingest trigger

Plus a **LLM Chat** component (vanilla JS, 200-300 lines) for Q&A — deferred to Phase 3.

### Dependencies Added

| Dependency | Size | Delivery |
|-----------|------|----------|
| HTMX | 14KB gzip | CDN or vendored in `/static/` |
| Chart.js | 67KB gzip | CDN (`<script>` tag) |
| CSS (custom) | ~5KB | Served from `/static/styles.css` |

**Total frontend payload: ~86KB**. Compare to React SPA: ~300-500KB minimum.

---

## Implementation Phases

### Phase 1: Foundation + Dashboard + Memory Explorer

**Goal**: Working dashboard home + memory browsing with search/filter. Proves the pattern.

**Tasks:**

1. **HTML template system**
   - Create a `renderLayout(title, content, activeRoute)` function returning full HTML page
   - Layout: sidebar nav (Dashboard, Memories, Diagnostics, Ingestion) + main content area
   - Include HTMX via CDN `<script>`, Chart.js via CDN `<script>`
   - CSS file with variables for theming (light/dark via `prefers-color-scheme` + manual toggle)
   - Responsive: sidebar collapses to hamburger on small screens (CSS-only, no JS)
   - Extract from existing `admin.ts` pattern but generalized
   - File: `src/http/ui/layout.ts` (layout template + CSS)
   - File: `src/http/ui/components.ts` (reusable HTML components: table, card, badge, pagination, empty-state)
   - File: `src/static/styles.css` (served via Hono `serveStatic()`)

2. **Static file serving**
   - Configure Hono to serve `/static/*` from `src/static/` directory
   - Vendor HTMX into `src/static/htmx.min.js` (no CDN dependency in prod)
   - File: `src/static/htmx.min.js` (14KB, vendored)
   - Update: `src/http/rest-server.ts` (add static file route, ~3 lines)

3. **Dashboard view (`/ui`)**
   - Stats cards: total memories, active sessions, registered projects, events count
   - Data source: **direct** query to MemoryManager, SessionManager, EventStore (no HTTP call)
   - Recent events: last 20 from EventStore (needs to expose a `getRecentEvents(limit)` method)
   - Quick-access links to other views
   - File: `src/http/ui/dashboard.ts`
   - Update: `src/storage/EventStore.ts` (add `getRecentEvents(limit: number)` public method)

4. **Memory Explorer (`/ui/memories`)**
   - Full-page render: search bar + filter dropdowns + results table + pagination
   - Data source: **direct** query to MemoryManager (needs a `listAll(filters, limit, offset)` method)
   - HTMX search: `hx-get="/ui/partials/memories?query=...&category=..."` → returns just the `<tbody>` + pagination
   - HTMX detail: click row → `hx-get="/ui/partials/memory/:key"` → slides in detail panel (`hx-swap="innerHTML"` into a side panel div)
   - HTMX delete: button in detail → `hx-delete="/ui/partials/memory/:key"` → removes row from table
   - Pagination: `offset` + `limit` in URL, server computes total count
   - Filter state in URL query params (bookmarkable, agent-friendly)
   - File: `src/http/ui/memories.ts`
   - File: `src/http/ui/partials/memories.ts` (HTMX partial responses)
   - Update: `src/memory/MemoryManager.ts` (add `listAll()` method — query across all sessions)

5. **Route registration**
   - Register all `/ui/*` routes on the Hono app
   - Auth: reuse existing API key middleware (optional, same as REST API)
   - File: `src/http/ui/routes.ts` (registers all UI routes on the Hono app)
   - Update: `src/http/rest-server.ts` (import and mount UI routes, ~5 lines)

6. **Tests**
   - Test layout rendering (returns valid HTML with expected elements)
   - Test dashboard data aggregation
   - Test memory search partial response
   - File: `src/http/ui/__tests__/dashboard.test.ts`
   - File: `src/http/ui/__tests__/memories.test.ts`

**New backend methods needed (minimal):**
- `EventStore.getRecentEvents(limit: number)` — simple query on existing `events` table
- `MemoryManager.listAll(filters?, limit?, offset?)` — cross-session memory query

**Success criteria:**
- [x] `/ui` renders dashboard with real stats (no JS required for initial render)
- [x] `/ui/memories` renders memory table, search works via HTMX (no full page reload)
- [x] Memory detail slides in via HTMX partial
- [x] Filter state preserved in URL
- [x] Page loads in <200ms (server-rendered, no JS framework)
- [x] Dark mode works via CSS `prefers-color-scheme`
- [x] `bun run typecheck` — 0 errors
- [x] `bun test` — all pass

**Files:**
- New: 8 (layout.ts, components.ts, dashboard.ts, memories.ts, partials/memories.ts, routes.ts, styles.css, htmx.min.js)
- Modified: 3 (rest-server.ts, EventStore.ts, MemoryManager.ts)
- Tests: 2
- **Total: ~13**

---

### Phase 2: Diagnostics + Ingestion Monitor

**Goal**: Complete the remaining two views.

**Tasks:**

1. **Diagnostics view (`/ui/diagnostics`)**
   - Analysis list: recent runs per project/tool from DiagnosticsStore (needs `listRuns()` method)
   - HTMX: select a run → `hx-get="/ui/partials/diagnostics/findings/:analysisId"` → findings table loads
   - Severity summary: bar chart rendered via Chart.js (data injected as `<script>const data = ${JSON.stringify(counts)}</script>`)
   - Diff view: select two runs → `hx-get="/ui/partials/diagnostics/diff?a=...&b=..."` → shows introduced/resolved/unchanged in a table
   - LLM summary: button calls existing `POST /api/v1/diagnostics/summarize/:id` via `fetch()` (vanilla JS, ~20 lines) → injects result into a `<div>`
   - Filters in URL: `?projectId=&tool=&analysisId=`
   - File: `src/http/ui/diagnostics.ts`
   - File: `src/http/ui/partials/diagnostics.ts`
   - Update: `src/diagnostics/DiagnosticsStore.ts` (add `listRuns(projectId?, toolName?, limit?)`)

2. **Ingestion Monitor (`/ui/ingestion`)**
   - Project list: read from `~/.ping-mem/registered-projects.txt` + AdminStore project data
   - Per-project card: name, last ingested, file/chunk counts, status
   - HTMX polling: `hx-get="/ui/partials/ingestion/status" hx-trigger="every 5s"` → refreshes project cards
   - Reingest button: per-project, calls `POST /api/v1/codebase/ingest` via HTMX `hx-post`
   - Health panel: Neo4j + Qdrant connection status (from IngestionService health check)
   - File: `src/http/ui/ingestion.ts`
   - File: `src/http/ui/partials/ingestion.ts`

3. **Tests**
   - Test diagnostics run listing
   - Test ingestion project card rendering
   - File: `src/http/ui/__tests__/diagnostics.test.ts`
   - File: `src/http/ui/__tests__/ingestion.test.ts`

**New backend methods needed:**
- `DiagnosticsStore.listRuns(projectId?, toolName?, limit?)` — query `analyses` table ordered by timestamp

**Success criteria:**
- [x] `/ui/diagnostics` shows runs list, click loads findings
- [x] Chart.js bar chart renders severity counts
- [x] Diff view shows introduced/resolved correctly
- [ ] LLM summary button works (existing OpenAI endpoint) — deferred to Phase 3 with chat
- [x] `/ui/ingestion` lists registered projects with health status
- [ ] HTMX polling updates ingestion status every 5s — deferred (reingest button works)
- [x] Reingest triggers successfully from button click
- [x] `bun run typecheck` — 0 errors
- [x] `bun test` — all pass (1009 pass, 0 fail)

**Files:**
- New: 4 (diagnostics.ts, partials/diagnostics.ts, ingestion.ts, partials/ingestion.ts)
- Modified: 1 (DiagnosticsStore.ts)
- Tests: 2
- **Total: ~7**

---

### Phase 3: LLM Chat + Polish + Deployment

**Goal**: Add conversational Q&A and production-harden.

**Tasks:**

1. **LLM Chat (vanilla JS)**
   - Floating chat button (bottom-right corner, CSS-positioned)
   - Click opens chat panel (absolutely-positioned, 400px wide, full height)
   - Input box at bottom, messages scroll above
   - Submit: `fetch('/ui/api/chat', { method: 'POST', body: JSON.stringify({message}) })`
   - Streaming: response uses `ReadableStream` reader, tokens appended to message div
   - Backend handler: queries ping-mem data for context (memory search + codebase search), sends to Ollama → Gemini fallback
   - Ollama timeout: 8 seconds, then try Gemini Flash
   - Model indicator: small badge showing which model responded
   - No conversation persistence (stateless, refreshes clear chat)
   - All JS in one `<script>` block or a single `/static/chat.js` file (~200-300 lines)
   - File: `src/static/chat.js` (vanilla JS, streaming fetch, DOM manipulation)
   - File: `src/http/ui/chat-api.ts` (POST handler: context enrichment + Ollama/Gemini proxy)
   - File: `src/llm/LLMProxy.ts` (Ollama client + Gemini fallback, reusable)
   - File: `src/llm/types.ts` (chat message types)

2. **Polish**
   - Dark mode toggle button in topbar (JS: toggle `data-theme` attribute, store in localStorage)
   - Add `<script>` to layout that checks localStorage for theme preference on load (prevents flash)
   - Toast notifications: CSS-only toast div, HTMX response headers (`HX-Trigger: showToast`) for action feedback
   - Active route highlighting in sidebar
   - Health dot in topbar: green/yellow/red based on service status
   - File: update `src/http/ui/layout.ts` (add dark mode toggle, toast container, health dot)
   - File: update `src/static/styles.css` (dark mode variables, toast animation, health dot)

3. **Deployment**
   - No new Docker container needed — UI is served by existing ping-mem process
   - Update `docker-compose.prod.yml` to include env var for UI auth if needed
   - Verify UI works on VPS (same process, same port, same container)
   - Add `/ui` health check verification to `scripts/smoke-test.sh`
   - Update: `docker-compose.prod.yml` (minor: env vars)
   - Update: `scripts/smoke-test.sh` (add UI checks)

4. **Tests**
   - Test LLMProxy (mock Ollama + Gemini responses)
   - Test chat API handler (mock LLMProxy)
   - Test dark mode toggle behavior
   - File: `src/llm/__tests__/LLMProxy.test.ts`
   - File: `src/http/ui/__tests__/chat-api.test.ts`

**Success criteria:**
- [x] Chat button opens panel, messages stream from Ollama
- [x] 8s Ollama timeout → automatic Gemini fallback
- [x] Both down → graceful error message in chat
- [x] Dark mode toggle works, preference persists
- [x] Toast notifications appear for actions (reingest, delete memory)
- [ ] UI works identically on local and VPS — needs manual deploy verification
- [x] `bun run typecheck` — 0 errors
- [x] `bun test` — all pass (1021 pass, 0 fail)

**Files:**
- New: 6 (chat.js, chat-api.ts, LLMProxy.ts, llm/types.ts, partials/health.ts, LLMProxy.test.ts)
- Modified: 3 (layout.ts, routes.ts, smoke-test.sh)
- Tests: 2 (LLMProxy.test.ts, chat-api.test.ts)
- **Total: ~11**

---

## What We Cut (and Why)

| Feature | Reason | Revisit When |
|---------|--------|-------------|
| Issue Tracker | YAGNI — use GitHub Issues | Users request it |
| Graph/Lineage visualization | Backend `queryRelationships` not implemented (tests are skipped) | Backend implements it |
| Framer Motion animations | CSS transitions sufficient for a dev tool | Never (CSS is fine) |
| React Flow | Only needed for graph viz (cut above) | Graph viz is added |
| API docs page | Agents use REST API directly, docs in CLAUDE.md | Public API launch |
| JSON export buttons | DevTools exist, agents use curl | Users request it |
| Zod client-side validation | Server renders HTML — no client-side data parsing | If we ever build an SPA |
| Separate Docker container | UI served from same process | If UI needs independent scaling |
| 9 Tanstack Query hook files | No React, no hooks | Never |
| Recharts | Chart.js via CDN is sufficient | Complex viz needs |

## File Summary

| Phase | New | Modified | Tests | Total |
|-------|-----|----------|-------|-------|
| Phase 1: Foundation + Dashboard + Memory | 8 | 3 | 2 | 13 |
| Phase 2: Diagnostics + Ingestion | 4 | 1 | 2 | 7 |
| Phase 3: LLM Chat + Polish | 4 | 3 | 2 | 9 |
| **Total** | **16** | **7** | **6** | **~29** |

**From 114 files → 29 files (75% reduction)**
**From 6 phases → 3 phases**
**From 2 Docker containers → 0 new containers**
**From ~500KB JS payload → ~86KB total**

## New Directory Structure

```
src/http/ui/
  layout.ts              # HTML layout + shared CSS
  components.ts          # Reusable HTML components (table, card, badge, pagination)
  routes.ts              # Hono route registration
  dashboard.ts           # /ui — dashboard view
  memories.ts            # /ui/memories — memory explorer
  diagnostics.ts         # /ui/diagnostics — diagnostics dashboard
  ingestion.ts           # /ui/ingestion — ingestion monitor
  chat-api.ts            # POST /ui/api/chat — LLM proxy handler
  partials/
    memories.ts          # HTMX partials for memory search/detail
    diagnostics.ts       # HTMX partials for findings/diff
    ingestion.ts         # HTMX partials for status polling
  __tests__/
    dashboard.test.ts
    memories.test.ts
    diagnostics.test.ts
    ingestion.test.ts
    chat-api.test.ts
src/llm/
  LLMProxy.ts            # Ollama + Gemini fallback client
  types.ts               # Chat types
  __tests__/
    LLMProxy.test.ts
src/static/
  styles.css             # All CSS (light/dark themes)
  htmx.min.js            # Vendored HTMX (14KB)
  chat.js                # Vanilla JS chat component (~250 lines)
```

## Backend Methods Needed (Minimal)

| Store | Method | Complexity |
|-------|--------|-----------|
| `EventStore` | `getRecentEvents(limit)` | Simple: `SELECT * FROM events ORDER BY timestamp DESC LIMIT ?` |
| `MemoryManager` | `listAll(filters?, limit?, offset?)` | Medium: cross-session query on SQLite |
| `DiagnosticsStore` | `listRuns(projectId?, toolName?, limit?)` | Simple: `SELECT * FROM analyses ORDER BY timestamp DESC` |

**3 new methods total.** No new REST endpoints needed for the UI views — data is queried directly.

## Quality Gates

| Gate | Command | Requirement |
|------|---------|-------------|
| TypeScript | `bun run typecheck` | 0 errors |
| Tests | `bun test` | All pass |
| Build | `bun run build` | No errors |
| Manual | Visit `/ui` in browser | All 4 views render with real data |

## Risk Analysis

| Risk | Impact | Mitigation |
|------|--------|------------|
| HTMX learning curve | Low | Simple API — `hx-get`, `hx-post`, `hx-trigger`, `hx-swap` cover 95% of cases |
| HTML templates become unwieldy | Medium | Extract reusable components in `components.ts`; keep each view file <300 lines |
| Chart.js CDN unavailable | Low | Vendor locally like HTMX if needed |
| Ollama timeout UX (8s hang) | Medium | Show "Connecting..." indicator immediately, "Switching to Gemini..." at 8s |
| No hot reload for HTML templates | Low | `bun run dev` (watch mode) restarts server on file change |

## Deployment

**Zero new infrastructure.** The UI is served by the existing ping-mem Hono server on the same port. Both local and VPS deployments get the UI automatically when the ping-mem container is rebuilt.

| Environment | UI URL | Backend | Container Changes |
|-------------|--------|---------|-------------------|
| Local dev | `http://localhost:3000/ui` | Same process | None |
| Local Docker | `http://localhost:3003/ui` | Same container | Rebuild image |
| VPS | `https://ping-mem.ping-gadgets.com/ui` | Same container | Rebuild + deploy |

## References

- Brainstorm: `docs/brainstorms/2026-02-18-ping-mem-web-ui-brainstorm.md`
- Existing admin panel pattern: `src/http/admin.ts` (lines 259-596)
- REST server: `src/http/rest-server.ts`
- HTMX docs: https://htmx.org/docs/
- Chart.js docs: https://www.chartjs.org/docs/
