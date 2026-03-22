# claude-mem Architecture Deep-Dive

**Source**: https://github.com/thedotmack/claude-mem
**Version at time of research**: 10.6.2 (released 2026-03-21)
**Author**: Alex Newman (thedotmack)
**License**: AGPL-3.0 (ragtime directory: PolyForm Noncommercial 1.0.0)
**Research date**: 2026-03-22

---

## 1. High-Level Architecture

claude-mem is a persistent memory plugin for Claude Code that automatically captures tool observations during sessions, compresses them via a background AI agent, stores them in SQLite + Chroma, and injects relevant context at session start.

### Six Core Components

| Component | Description |
|-----------|-------------|
| Lifecycle Hooks (hooks.json) | 5 hook types across 6 scripts, wired into Claude Code's hook system |
| Worker Service | Express HTTP server on port 37777 managed by Bun runtime |
| SQLite Database | Primary storage: sessions, observations, summaries, prompts |
| Chroma Vector Database | Hybrid semantic + keyword search layer |
| MCP Server (mcp-server.cjs) | Exposes search tools to Claude during sessions |
| mem-search Skill | Natural language query interface with progressive disclosure |

### Runtime Requirements

- Node.js >= 18.0.0
- Bun 1.0.0+ (auto-installed if absent)
- uv Python package manager (auto-installed if absent)
- SQLite 3 (bundled)
- Claude Code (latest, with plugin support)

---

## 2. Lifecycle Hooks — Full Configuration

Source: `plugin/hooks/hooks.json` (retrieved verbatim)

```json
{
  "description": "Claude-mem memory system hooks",
  "hooks": {
    "Setup": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "_R=\"${CLAUDE_PLUGIN_ROOT}\"; [ -z \"$_R\" ] && _R=\"$HOME/.claude/plugins/marketplaces/thedotmack/plugin\"; \"$_R/scripts/setup.sh\"",
            "timeout": 300
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          { "type": "command", "command": "... node smart-install.js", "timeout": 300 },
          { "type": "command", "command": "... node bun-runner.js worker-service.cjs start", "timeout": 60 },
          { "type": "command", "command": "... node bun-runner.js worker-service.cjs hook claude-code context", "timeout": 60 }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "... node bun-runner.js worker-service.cjs hook claude-code session-init", "timeout": 60 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "... node bun-runner.js worker-service.cjs hook claude-code observation", "timeout": 120 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "... node bun-runner.js worker-service.cjs hook claude-code summarize", "timeout": 120 }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "... node bun-runner.js worker-service.cjs hook claude-code session-complete", "timeout": 30 }
        ]
      }
    ]
  }
}
```

### Hook-to-Action Mapping

| Hook | Trigger | Action | Timeout |
|------|---------|--------|---------|
| Setup | Plugin install | `setup.sh` — install dependencies | 300s |
| SessionStart | startup / clear / compact | smart-install → start worker → inject context | 60s each |
| UserPromptSubmit | Every user prompt | `session-init` — create/resume SDK session | 60s |
| PostToolUse | After every tool call | `observation` — send tool input/output to AI agent | 120s |
| Stop | Claude Stop event | `summarize` — generate session summary | 120s |
| SessionEnd | Session termination | `session-complete` — finalize session record | 30s |

### Standard Hook Response

All hooks (except SessionStart context injection) return:
```json
{ "continue": true, "suppressOutput": true }
```

SessionStart constructs its own response with `hookSpecificOutput` containing the injected context.

---

## 3. Session ID Architecture

Two distinct IDs are maintained per session:

| ID | Purpose | Notes |
|----|---------|-------|
| `contentSessionId` | Identifies the Claude Code user conversation | Used for FK on observations |
| `memorySessionId` | SDK agent's internal session ID for resume | NULL until first SDK message; never used for observations |

**Initialization sequence**:
1. `UserPromptSubmit` hook creates session with `contentSessionId`, `memorySessionId = NULL`
2. SDKAgent detects NULL and starts fresh
3. On first SDK response, actual `memorySessionId` is captured and stored
4. Subsequent prompts check for non-NULL `memorySessionId` before resuming

**Critical rule**: Observations are stored with `contentSessionId` as the session reference, not the captured SDK `memorySessionId`. This ensures consistent user-session attribution.

---

## 4. SQLite Database Schema

### Schema Evolution (7 Migrations)

- **Migration 001**: Core tables — `sessions`, `memories`, `overviews`, `diagnostics`, `transcript_events`
- **Migration 002**: Hierarchical memory fields on `memories` — `title`, `subtitle`, `facts`, `concepts`, `files_touched`
- **Migration 003**: `streaming_sessions` (later removed)
- **Migration 004**: SDK agent tables — `sdk_sessions`, `observations`, `session_summaries`
- **Migration 005**: Remove `streaming_sessions` and `observation_queue` (shifted to Unix socket)
- **Migration 006**: FTS5 virtual tables — `observations_fts`, `session_summaries_fts`
- **Migration 007**: `discovery_tokens INTEGER DEFAULT 0` added to `observations` and `session_summaries`

### Core Tables (Migration 004 + 007)

#### `sdk_sessions`
```sql
CREATE TABLE IF NOT EXISTS sdk_sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id  TEXT UNIQUE NOT NULL,
  memory_session_id   TEXT UNIQUE,
  project             TEXT NOT NULL,
  user_prompt         TEXT,
  started_at          TEXT NOT NULL,
  started_at_epoch    INTEGER NOT NULL,
  completed_at        TEXT,
  completed_at_epoch  INTEGER,
  status              TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
);
```

#### `observations`
```sql
CREATE TABLE IF NOT EXISTS observations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id   TEXT NOT NULL,
  project             TEXT NOT NULL,
  type                TEXT NOT NULL,
  title               TEXT,
  subtitle            TEXT,
  facts               TEXT,          -- JSON array
  narrative           TEXT,
  concepts            TEXT,          -- JSON array
  files_read          TEXT,          -- JSON array
  files_modified      TEXT,          -- JSON array
  prompt_number       INTEGER,
  discovery_tokens    INTEGER DEFAULT 0,   -- added Migration 007
  content_hash        TEXT,          -- 16-char SHA256 truncation for dedup
  created_at          TEXT NOT NULL,
  created_at_epoch    INTEGER NOT NULL,
  FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
);
```

**Note**: The initial Migration 004 schema has `text TEXT NOT NULL` (plain text). Later migrations added structured fields (`title`, `subtitle`, `facts`, `concepts`, `files_read`, `files_modified`, `content_hash`, `prompt_number`). The current `store.ts` INSERT includes all structured columns.

#### `session_summaries`
```sql
CREATE TABLE IF NOT EXISTS session_summaries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id   TEXT UNIQUE NOT NULL,
  project             TEXT NOT NULL,
  request             TEXT,
  investigated        TEXT,
  learned             TEXT,
  completed           TEXT,
  next_steps          TEXT,
  files_read          TEXT,
  files_edited        TEXT,
  notes               TEXT,
  discovery_tokens    INTEGER DEFAULT 0,   -- added Migration 007
  created_at          TEXT NOT NULL,
  created_at_epoch    INTEGER NOT NULL,
  FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
);
```

#### FTS5 Virtual Tables (Migration 006)
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, subtitle, narrative, text, facts, concepts,
  content='observations', content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
  request, investigated, learned, completed, next_steps, notes,
  content='session_summaries', content_rowid='id'
);
```

FTS5 triggers are created on INSERT/UPDATE/DELETE to keep virtual tables in sync. Fallback handling exists for platforms where FTS5 is unavailable.

---

## 5. Observation Data Model

### TypeScript Interface (`ObservationInput` from `src/services/sqlite/observations/types.ts`)

```typescript
interface ObservationInput {
  type: string;          // one of: bugfix | feature | refactor | change | discovery | decision
  title: string;         // concise self-contained title
  subtitle?: string;     // optional secondary description
  facts: string[];       // array of specific atomic facts
  narrative: string;     // prose context explaining what was done and why
  concepts: string[];    // knowledge dimension tags
  files_read: string[];  // files accessed during this observation
  files_modified: string[];  // files changed during this observation
}

interface StoreObservationResult {
  id: number;
  createdAtEpoch: number;
}
```

### Observation Types (from `plugin/modes/code.json`)

| Type | Icon | Meaning |
|------|------|---------|
| `bugfix` | 🔴 | Broken functionality restored |
| `feature` | 🟣 | New capabilities introduced |
| `refactor` | 🔄 | Code restructured without behavior change |
| `change` | ✅ | Documentation, configuration, miscellaneous updates |
| `discovery` | 🔵 | System understanding and learning |
| `decision` | ⚖️ | Architectural or design choices with rationale |

### Knowledge Concepts (7 categories)

`how-it-works` | `why-it-exists` | `what-changed` | `problem-solution` | `gotcha` | `pattern` | `trade-off`

### XML Format for AI Output

The AI agent is prompted to produce observations in this XML structure:

```xml
<observation>
  <type>bugfix|feature|refactor|change|discovery|decision</type>
  <title>Concise self-contained title describing the deliverable</title>
  <subtitle>Optional secondary description</subtitle>
  <facts>
    <fact>Specific atomic fact with concrete details</fact>
    <fact>Complete file path from project root</fact>
  </facts>
  <narrative>Prose context: what was done, why it matters, full file paths</narrative>
  <concepts>
    <concept>how-it-works</concept>
    <concept>pattern</concept>
  </concepts>
  <files_read>
    <file>src/path/to/file.ts</file>
  </files_read>
  <files_modified>
    <file>src/path/to/changed.ts</file>
  </files_modified>
</observation>
```

### Summary XML Format

```xml
<summary>
  <request>What was originally requested</request>
  <investigated>What was examined / explored</investigated>
  <learned>Key learnings from this session</learned>
  <completed>What was actually completed</completed>
  <next_steps>Remaining or follow-up work</next_steps>
  <notes>Additional context or caveats</notes>
</summary>
```

### Deduplication

Content hash deduplication: 30-second window, 16-character SHA256 truncation on the observation content. Duplicate observations within 30 seconds return the existing record's ID without a new INSERT.

---

## 6. AI Compression Pipeline

### Agent Architecture

Three interchangeable AI providers:

| Agent | Provider | Notes |
|-------|----------|-------|
| `SDKAgent` | Claude Agent SDK (v0.1.76) | Primary; observer-only, no tools allowed |
| `GeminiAgent` | Google Gemini REST API | Free-tier rate limiting enforced |
| `OpenRouterAgent` | OpenRouter | Fallback option |

The system implements graceful degradation: when the primary SDK session terminates, it automatically attempts `GeminiAgent`, then `OpenRouterAgent`, before abandoning the pending message.

### Compression Trigger

Every PostToolUse hook call sends tool input + output to the background worker via `worker-service.cjs hook claude-code observation`. The worker enqueues the observation and processes it through the active AI provider.

### `processAgentResponse()` Lifecycle

1. Update `lastGeneratorActivity` timestamp (stale detection)
2. Append assistant response to conversation history
3. Parse XML — extract `<observation>` blocks and `<summary>` block
4. Atomic SQLite transaction: store observations + summary using `memorySessionId` FK
5. Confirm processed messages from queue (prevent data loss)
6. Async fire-and-forget: Chroma sync + SSE broadcast to web UI + Cursor context update

### XML Parsing (from `src/sdk/parser.ts`)

- Non-greedy regex `[\s\S]*?` handles nested tags and embedded code snippets
- Observation parser **always saves** — never skips even on partial data
- Summary parser returns `null` only if `<skip_summary>` directive is present OR no `<summary>` tag found
- Type validation runs against active ModeManager configuration; invalid types fall back to defaults
- Concept arrays filter out observation type strings (treated as separate categorical dimensions)

### Prompt Functions (from `src/sdk/prompts.ts`)

| Function | Hook | Purpose |
|----------|------|---------|
| `buildInitPrompt()` | session-init | Initialize new SDK session; includes system identity + XML template |
| `buildObservationPrompt()` | PostToolUse observation | Wraps tool input/output in XML; handles JSON parse failures gracefully |
| `buildSummaryPrompt()` | Stop summarize | Generates progress checkpoint using `<summary>` tags |
| `buildContinuationPrompt()` | Resume | Threads session ID through hooks for multi-turn coherence |

### Token Accounting

- `discovery_tokens` column tracks token cost per observation and session summary
- Cache creation counts as discovery; cache read does not
- Cumulative discovery token metrics tracked at session summary level for ROI reporting

### Background AI Process (Worker Service)

- Express HTTP server starts immediately; SQLite + Chroma initialize in background (staggered init)
- Zombie prevention: orphan reapers run every 30 seconds; stale session cleanup every 2 minutes
- Restart invariant: every generator exit either restarts (fresh abort controllers) or terminates — no suspended sessions
- Unrecoverable errors (missing executables, invalid API keys) trigger immediate termination, not restart loops

---

## 7. Search System — 3-Layer Progressive Disclosure

### Architecture

Three search backends with automatic strategy selection:

| Backend | When Used | Mechanism |
|---------|-----------|-----------|
| `SQLiteSearchStrategy` | Filter-only queries (no text query) | FTS5 full-text search + metadata filters |
| `ChromaSearchStrategy` | Semantic queries (text present, Chroma available) | Vector embedding query + recency filter |
| `HybridSearchStrategy` | Text + metadata constraints | SQLite intersection of Chroma semantic ranking |

### Strategy Decision Tree (`SearchOrchestrator.executeWithFallback()`)

1. No query text → SQLiteSearchStrategy
2. Query text + Chroma available → ChromaSearchStrategy (SQLite fallback on failure)
3. Query text + Chroma unavailable → Empty results (degraded mode)

Specialized methods `findByConcept()`, `findByType()`, `findByFile()` use hybrid/SQLite fallbacks.

### Chroma Integration Details

- `ChromaSync.queryChroma()` called with query text, batch size (100), and where-filter for doc type + project
- Results filtered to 90-day recency window using `created_at_epoch`
- Deduplication: `queryChroma()` returns deduplicated IDs, but `metadatas` array may contain multiple entries per `sqlite_id` (narrative + facts stored separately); a Map resolves this
- Full records hydrated from SQLite after vector ranking

### Hybrid Merge Algorithm

1. SQLite retrieves all observations matching metadata constraints
2. Chroma queries vector database for semantic ranking
3. `intersectWithRanking()`: keeps IDs in both sets, **preserving Chroma's rank order**
4. SQLite hydration restores full records sorted by semantic rank (`indexOf()` comparison)
5. If Chroma fails: fallback to metadata-only results with `fellBack: true` flag

### The 3-Layer Workflow (mem-search skill)

**Goal**: ~10x token savings by filtering before fetching

| Layer | MCP Tool | Token Cost | Output |
|-------|----------|-----------|--------|
| Layer 1 | `search` | ~50-100 tokens/result | Compact index: IDs + metadata only |
| Layer 2 | `timeline` | medium | Chronological context around anchor observation |
| Layer 3 | `get_observations` | ~500-1,000 tokens/observation | Full details for filtered ID set |

**Pattern**: search → identify relevant IDs → (optionally) timeline for context → get_observations for selected IDs only

### Search Parameters

```
query           string          — natural language search text
limit           integer         — max results (default 20, max 100)
project         string          — filter to specific project
type            string[]        — observation types: bugfix|feature|refactor|change|discovery|decision
concepts        string[]        — knowledge concept tags
files           string[]        — file path filters (LIKE matching)
date_from       string          — ISO date range start
date_to         string          — ISO date range end
result_types    string[]        — observations|sessions|prompts
```

---

## 8. HTTP API — Worker Service Endpoints (port 37777)

### Search Routes (`/api/search`, `/api/timeline`, etc.)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/search` | GET | Combined observations + sessions + prompts search |
| `GET /api/timeline` | GET | Anchor or query-based timeline |
| `GET /api/decisions` | GET | Semantic shortcut — decision observations |
| `GET /api/changes` | GET | Semantic shortcut — change observations |
| `GET /api/how-it-works` | GET | Semantic shortcut — explanatory observations |
| `GET /api/search/observations` | GET | FTS5 observation search (backward compat) |
| `GET /api/search/sessions` | GET | FTS5 session summary search |
| `GET /api/search/prompts` | GET | FTS5 user prompt search |
| `GET /api/search/by-concept` | GET | Filter by concept tag |
| `GET /api/search/by-file` | GET | Filter by file path |
| `GET /api/search/by-type` | GET | Filter by observation type |
| `GET /api/context/recent` | GET | Recent session context with summaries |
| `GET /api/context/timeline` | GET | Timeline around anchor |
| `GET /api/context/preview` | GET | Context preview for settings modal |
| `GET /api/context/inject` | GET | Pre-formatted context for hooks |
| `GET /api/timeline/by-query` | GET | Search then timeline around best match |
| `GET /api/search/help` | GET | Documentation and examples |

### Data Routes

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/observations` | GET | Paginated observations |
| `GET /api/observation/:id` | GET | Single observation by ID |
| `POST /api/observations/batch` | POST | Batch fetch by ID array |
| `GET /api/session/:id` | GET | Session by ID |
| `POST /api/sdk-sessions/batch` | POST | SDK sessions by memory session IDs |
| `GET /api/summaries` | GET | Paginated session summaries |
| `GET /api/prompts` | GET | Paginated user prompts |
| `GET /api/prompt/:id` | GET | Single prompt by ID |
| `GET /api/stats` | GET | Database statistics + worker metadata |
| `GET /api/projects` | GET | Distinct project list |
| `GET /api/processing-status` | GET | Current processing state |
| `POST /api/processing` | POST | Update processing status |
| `GET /api/pending-queue` | GET | Queue contents + statistics |
| `POST /api/pending-queue/process` | POST | Process queued sessions |
| `DELETE /api/pending-queue/failed` | DELETE | Clear failed messages |
| `DELETE /api/pending-queue/all` | DELETE | Clear entire queue |
| `POST /api/import` | POST | Import sessions/summaries/observations/prompts |

### SSE (Server-Sent Events)

SSE broadcast to web UI clients for real-time observation + summary streaming. `ObservationBroadcaster` and `SSEBroadcaster` handle fanout to connected clients.

---

## 9. Context Injection at SessionStart

The SessionStart `context` hook calls `/api/context/inject` which returns pre-formatted context as plain text. This text is embedded in the hook's `hookSpecificOutput` field to inject into the Claude Code system prompt.

As of v10.6.0, the system shifted from writing to `MEMORY.md` files toward injecting observation timelines directly into agent system prompts via this hook mechanism, keeping memory files under agent control.

Context generation pipeline: `ContextBuilder` → `ContextConfigLoader` → `ObservationCompiler` → `TokenCalculator` → formatters → sections → final output string.

---

## 10. Timeline Service

`TimelineService.buildTimeline()` combines observations, sessions, and user prompts into a unified, epoch-sorted collection.

**Anchor-based filtering** (`filterByDepth()`):
- Accepts numeric observation IDs
- Session identifiers prefixed with `'S'`
- Timestamp anchors
- Returns a window slice bounded by configurable `depth_before` / `depth_after` parameters

**Markdown output** includes:
- Day-based grouping headers
- Markdown tables for observations (type icons + token estimates)
- Session and prompt items break table formatting
- `**ANCHOR**` marker on the pivot observation
- Emoji legend: 🎯 anchor, 🔴 bugfix, etc.

---

## 11. Mode System

Modes are JSON configuration files in `plugin/modes/`. The `ModeManager` singleton loads mode profiles with parent-override inheritance (e.g., `code--ko` inherits from `code`).

Active mode determines:
- Observation types (and their labels/icons)
- Validation rules for observation type
- System prompt text injected into AI agent

Available modes:
- `code` (default — software development)
- `email-investigation` (entity/relationship/timeline extraction)
- `law-study` (case holdings, doctrine synthesis)
- 30 language variants of `code` (e.g., `code--ja`, `code--ko`, `code--fr`)

---

## 12. Privacy Controls

Content wrapped in `<private>` tags is excluded from storage entirely. The observation capture pipeline strips private-tagged content before it reaches the AI compression step.

---

## 13. "Endless Mode" — Research Finding

The README mentions "Endless Mode" as an experimental feature available via a "beta channel" / version switching. However, no files, code, or documentation for "Endless Mode" were found in the current main branch of the repository. The GitHub code search returned zero matches for "endless mode." The term "biomimetic memory" was not found anywhere in the codebase or documentation.

The "ragtime" directory (separately licensed under PolyForm Noncommercial) implements a batch processor for long-running corpus analysis (specifically email investigation). This may be the feature the README refers to as "Endless Mode" — it processes a corpus file-by-file, starting a NEW session per file to avoid context exhaustion. This is the closest analog to "biomimetic memory" found: processing is segmented into many short sessions rather than one continuous long session.

---

## 14. Key Architectural Decisions and Patterns

### What claude-mem Does Differently from Basic Memory Systems

1. **Observer-only AI agent**: The compression AI has all tools disabled — it only reads tool input/output piped to it, preventing it from taking actions
2. **Dual session ID isolation**: `contentSessionId` for observations vs `memorySessionId` for agent resumption prevents FK constraint violations
3. **Fire-and-forget async for non-critical paths**: Chroma sync and UI broadcast are async; only SQLite storage is synchronous and blocking
4. **FTS5 + vector hybrid**: Both keyword precision and semantic relevance — fallback to keyword-only when Chroma unavailable
5. **Staggered initialization**: HTTP server binds immediately (health checks pass); SQLite + Chroma init in background
6. **Content hash deduplication**: 30-second window prevents identical rapid observations
7. **Progressive disclosure search**: Index first, timeline for context, full fetch only for confirmed relevant IDs

### Token Economics

- Layer 1 search: ~50-100 tokens per result
- Layer 3 full observation: ~500-1,000 tokens per observation
- 10x token savings claimed through pre-filtering
- `discovery_tokens` tracked per observation for ROI measurement
- v10.6.1 compressed context output by ~53% by switching to timeline injection

---

## 15. Source File Map

| Path | Purpose |
|------|---------|
| `plugin/hooks/hooks.json` | Hook configuration (verbatim above) |
| `plugin/modes/code.json` | Default mode with observation type definitions |
| `plugin/scripts/worker-service.cjs` | Worker service entry point (compiled) |
| `plugin/scripts/mcp-server.cjs` | MCP tool server (compiled, minified) |
| `plugin/skills/mem-search/SKILL.md` | mem-search skill definition |
| `src/sdk/prompts.ts` | AI prompt builders (observation/summary XML templates) |
| `src/sdk/parser.ts` | XML observation/summary extractor |
| `src/services/sqlite/migrations.ts` | All 7 SQL migrations |
| `src/services/sqlite/observations/store.ts` | INSERT with dedup logic |
| `src/services/sqlite/observations/get.ts` | Query functions (by ID, batch, session) |
| `src/services/worker/SDKAgent.ts` | Claude SDK agent (references prompts.ts) |
| `src/services/worker/GeminiAgent.ts` | Gemini fallback agent |
| `src/services/worker/agents/ResponseProcessor.ts` | XML parse → DB store → async broadcast |
| `src/services/worker/search/SearchOrchestrator.ts` | Strategy selection + fallback |
| `src/services/worker/search/strategies/ChromaSearchStrategy.ts` | Vector search impl |
| `src/services/worker/search/strategies/HybridSearchStrategy.ts` | Merge algorithm |
| `src/services/worker/TimelineService.ts` | Anchor-based timeline builder |
| `src/services/worker/http/routes/SearchRoutes.ts` | All search HTTP endpoints |
| `src/services/worker/http/routes/DataRoutes.ts` | All data HTTP endpoints |
| `src/services/worker-types.ts` | Shared TypeScript types |
| `src/hooks/hook-response.ts` | Standard hook response constant |
| `docs/SESSION_ID_ARCHITECTURE.md` | Session ID dual-ID design doc |
