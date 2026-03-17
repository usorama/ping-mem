# 04 - Current Data Model Audit for Universal Consolidation

**Date**: 2026-03-17
**Status**: Complete
**Purpose**: Audit every table, node, collection, and index in ping-mem's current data model. Identify exactly what must change for universal consolidation.

---

## 1. SQLite Schema (3 Separate Databases)

ping-mem currently runs **3 independent SQLite databases**, each with its own WAL mode, busy timeout, and lifecycle. This fragmentation is a key consolidation target.

### 1.1 EventStore (`~/.ping-mem/events.db`)

The core append-only event store. All memory operations flow through here as events.

#### Table: `events`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `event_id` | TEXT | PRIMARY KEY | UUIDv7 (time-sortable, monotonic counter) |
| `timestamp` | TEXT | NOT NULL | ISO-8601 |
| `session_id` | TEXT | NOT NULL | Session scope |
| `event_type` | TEXT | NOT NULL | One of 16 event types (see below) |
| `payload` | TEXT | NOT NULL | JSON blob (session/memory/worklog data) |
| `caused_by` | TEXT | FK -> events(event_id) | Causality chain |
| `metadata` | TEXT | NOT NULL | JSON blob |
| `agent_id` | TEXT | nullable | Added via migration v2_agent_id_column |

**Indexes**: `idx_events_session(session_id, timestamp)`, `idx_events_timestamp(timestamp)`, `idx_events_type(event_type)`

**Event Types** (16 total):
`SESSION_STARTED`, `SESSION_ENDED`, `SESSION_PAUSED`, `SESSION_RESUMED`, `MEMORY_SAVED`, `MEMORY_UPDATED`, `MEMORY_DELETED`, `MEMORY_RECALLED`, `CHECKPOINT_CREATED`, `CONTEXT_LOADED`, `TOOL_RUN_RECORDED`, `DIAGNOSTICS_INGESTED`, `GIT_OPERATION_RECORDED`, `AGENT_TASK_STARTED`, `AGENT_TASK_SUMMARY`, `AGENT_TASK_COMPLETED`, `CODEBASE_INGESTION_STARTED`, `CODEBASE_INGESTION_COMPLETED`, `CODEBASE_INGESTION_FAILED`

#### Table: `checkpoints`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `checkpoint_id` | TEXT | PRIMARY KEY | UUIDv7 |
| `session_id` | TEXT | NOT NULL | |
| `timestamp` | TEXT | NOT NULL | ISO-8601 |
| `last_event_id` | TEXT | NOT NULL, FK -> events(event_id) | |
| `memory_count` | INTEGER | NOT NULL | Count at checkpoint time |
| `description` | TEXT | nullable | |

**Index**: `idx_checkpoints_session(session_id, timestamp)`

#### Table: `checkpoint_items`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `checkpoint_id` | TEXT | PK (composite), FK -> checkpoints ON DELETE CASCADE | |
| `memory_key` | TEXT | PK (composite) | |

**Index**: `idx_checkpoint_items_checkpoint(checkpoint_id)`

#### Table: `agent_quotas` (migration: v2_agent_quotas)
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `agent_id` | TEXT | PRIMARY KEY | |
| `role` | TEXT | NOT NULL | |
| `admin` | INTEGER | NOT NULL, DEFAULT 0 | Boolean |
| `ttl_ms` | INTEGER | NOT NULL, DEFAULT 86400000 | 24h default |
| `expires_at` | TEXT | nullable | |
| `current_bytes` | INTEGER | NOT NULL, DEFAULT 0 | |
| `current_count` | INTEGER | NOT NULL, DEFAULT 0 | |
| `quota_bytes` | INTEGER | NOT NULL, DEFAULT 10485760 | 10MB |
| `quota_count` | INTEGER | NOT NULL, DEFAULT 10000 | |
| `created_at` | TEXT | NOT NULL | |
| `updated_at` | TEXT | NOT NULL | |
| `metadata` | TEXT | NOT NULL, DEFAULT '{}' | JSON blob |

#### Table: `write_locks` (migration: v2_write_locks)
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `lock_key` | TEXT | PRIMARY KEY | |
| `holder_id` | TEXT | NOT NULL | |
| `acquired_at` | TEXT | NOT NULL | |
| `expires_at` | TEXT | NOT NULL | |
| `metadata` | TEXT | NOT NULL, DEFAULT '{}' | |

#### Table: `migrations`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `migration_id` | TEXT | PRIMARY KEY | |
| `applied_at` | TEXT | NOT NULL | |

**Applied migrations**: `v2_agent_id_column`, `v2_agent_quotas`, `v2_write_locks`

#### Table: `knowledge_entries` (created by KnowledgeStore, shares events.db)
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | TEXT | PRIMARY KEY | SHA-256(projectId + "::" + title) |
| `project_id` | TEXT | NOT NULL | |
| `title` | TEXT | NOT NULL | |
| `solution` | TEXT | NOT NULL | |
| `symptoms` | TEXT | nullable | |
| `root_cause` | TEXT | nullable | |
| `tags` | TEXT | NOT NULL, DEFAULT '[]' | JSON array |
| `agent_id` | TEXT | nullable | |
| `created_at` | TEXT | NOT NULL | |
| `updated_at` | TEXT | NOT NULL | |

**Index**: `idx_knowledge_project_id(project_id)`

#### Virtual Table: `knowledge_fts` (FTS5)
| Column | Indexed | Notes |
|--------|---------|-------|
| `title` | Yes | |
| `solution` | Yes | |
| `symptoms` | Yes | |
| `root_cause` | Yes | |
| `tags` | Yes | |

Content table: `knowledge_entries`. Synced via INSERT/UPDATE/DELETE triggers (`knowledge_ai`, `knowledge_ad`, `knowledge_au`).

#### Tables: `code_chunks` and `code_fts` (created by CodeChunkStore, shares events.db)

**Table: `code_chunks`**
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `chunk_id` | TEXT | PRIMARY KEY | Content-addressable SHA-256 |
| `project_id` | TEXT | NOT NULL | |
| `file_path` | TEXT | NOT NULL | |
| `content` | TEXT | NOT NULL | |
| `start_line` | INTEGER | NOT NULL | |
| `end_line` | INTEGER | NOT NULL | |
| `chunk_type` | TEXT | NOT NULL | function, class, file, block |
| `language` | TEXT | nullable | |
| `indexed_at` | TEXT | NOT NULL | |

**Virtual Table: `code_fts`** (FTS5)
| Column | Indexed | Notes |
|--------|---------|-------|
| `content` | Yes | porter + unicode61 tokenizer |
| `file_path` | Yes | |
| `chunk_id` | No (UNINDEXED) | For joining back |
| `project_id` | No (UNINDEXED) | For filtering |

---

### 1.2 DiagnosticsStore (`~/.ping-mem/diagnostics.db`)

Separate database for diagnostic runs and findings.

#### Table: `diagnostic_runs`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `run_id` | TEXT | PRIMARY KEY | UUIDv7 |
| `analysis_id` | TEXT | NOT NULL | SHA-256(projectId + treeHash + tool + config + findings) |
| `project_id` | TEXT | NOT NULL | |
| `tree_hash` | TEXT | NOT NULL | |
| `commit_hash` | TEXT | nullable | |
| `tool_name` | TEXT | NOT NULL | tsc, eslint, prettier |
| `tool_version` | TEXT | NOT NULL | |
| `config_hash` | TEXT | NOT NULL | |
| `environment_hash` | TEXT | nullable | |
| `status` | TEXT | NOT NULL | |
| `created_at` | TEXT | NOT NULL | |
| `duration_ms` | INTEGER | nullable | |
| `findings_digest` | TEXT | NOT NULL | |
| `raw_sarif` | TEXT | nullable | Full SARIF JSON (large) |
| `metadata` | TEXT | NOT NULL | JSON blob |

**Indexes**: `idx_runs_project_tree(project_id, tree_hash)`, `idx_runs_tool(tool_name, tool_version)`, `idx_runs_analysis(analysis_id)`

#### Table: `diagnostic_findings`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `finding_id` | TEXT | PRIMARY KEY | SHA-256(analysisId + location + rule + message) |
| `analysis_id` | TEXT | NOT NULL | |
| `rule_id` | TEXT | NOT NULL | |
| `severity` | TEXT | NOT NULL | error, warning, note |
| `message` | TEXT | NOT NULL | |
| `file_path` | TEXT | NOT NULL | |
| `start_line` | INTEGER | nullable | |
| `start_col` | INTEGER | nullable | |
| `end_line` | INTEGER | nullable | |
| `end_col` | INTEGER | nullable | |
| `chunk_id` | TEXT | nullable | Link to code chunk |
| `fingerprint` | TEXT | nullable | |
| `symbol_id` | TEXT | nullable | |
| `symbol_name` | TEXT | nullable | |
| `symbol_kind` | TEXT | nullable | |
| `properties` | TEXT | NOT NULL | JSON blob |

**Indexes**: `idx_findings_analysis(analysis_id)`, `idx_findings_file(file_path)`, `idx_findings_rule(rule_id)`, `idx_findings_symbol(symbol_id)`

#### Table: `diagnostic_summaries`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `summary_id` | TEXT | PRIMARY KEY | |
| `analysis_id` | TEXT | NOT NULL, UNIQUE | Content-addressable cache |
| `summary_text` | TEXT | NOT NULL | |
| `llm_model` | TEXT | NOT NULL | |
| `llm_provider` | TEXT | NOT NULL | |
| `generated_at` | TEXT | NOT NULL | |
| `prompt_tokens` | INTEGER | NOT NULL | |
| `completion_tokens` | INTEGER | NOT NULL | |
| `cost_usd` | REAL | nullable | |
| `source_finding_ids` | TEXT | NOT NULL | JSON array |

**Index**: `idx_summaries_analysis(analysis_id)`

---

### 1.3 AdminStore (`~/.ping-mem/admin.db`)

Separate database for admin panel, API keys, and project registry.

#### Table: `admin_api_keys`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | TEXT | PRIMARY KEY | UUID v4 |
| `key_hash` | TEXT | NOT NULL, UNIQUE | SHA-256 of raw key |
| `key_last4` | TEXT | NOT NULL | Last 4 chars for display |
| `created_at` | TEXT | NOT NULL | |
| `active` | INTEGER | NOT NULL, DEFAULT 1 | Boolean |

**Index**: `idx_admin_api_keys_active(active, created_at)`

#### Table: `admin_projects`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `project_id` | TEXT | PRIMARY KEY | SHA-256(remote + path) |
| `project_dir` | TEXT | NOT NULL | |
| `tree_hash` | TEXT | nullable | |
| `last_ingested_at` | TEXT | nullable | |

**Index**: `idx_admin_projects_dir(project_dir)`

#### Table: `admin_llm_config`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | INTEGER | PRIMARY KEY, CHECK(id = 1) | Singleton row |
| `provider` | TEXT | NOT NULL | openai, anthropic, etc. |
| `api_key_ciphertext` | TEXT | NOT NULL | AES-256-GCM encrypted |
| `api_key_iv` | TEXT | NOT NULL | |
| `api_key_tag` | TEXT | NOT NULL | |
| `model` | TEXT | nullable | |
| `base_url` | TEXT | nullable | |
| `updated_at` | TEXT | NOT NULL | |

---

## 2. Neo4j Graph Model

Two parallel graph systems exist in Neo4j, using different node labels and patterns.

### 2.1 Temporal Code Graph (TemporalCodeGraph.ts)

**Node Labels and Properties:**

| Label | Properties | Identity Key |
|-------|-----------|--------------|
| `Project` | `projectId`, `name`, `rootPath`, `treeHash`, `lastIngestedAt` | `projectId` (UNIQUE constraint) |
| `File` | `fileId`, `path`, `sha256`, `lastIngestedAt`, `isExternal` | `fileId` (SHA-256 of path) |
| `Chunk` | `chunkId`, `type` (code/comment/docstring), `start`, `end`, `lineStart`, `lineEnd`, `content`, `lastIngestedAt` | `chunkId` |
| `Symbol` | `symbolId`, `name`, `kind`, `startLine`, `endLine`, `signature`, `lastIngestedAt` | `symbolId` |
| `Commit` | `hash`, `shortHash`, `authorName`, `authorEmail`, `authorDate`, `committerName`, `committerEmail`, `committerDate`, `message` | `hash` |

**Relationship Types:**

| Type | From | To | Properties |
|------|------|----|-----------|
| `HAS_FILE` | Project | File | `ingestedAt` |
| `HAS_CHUNK` | File | Chunk | `ingestedAt` |
| `DEFINES_SYMBOL` | File | Symbol | `ingestedAt` |
| `CONTAINS_SYMBOL` | Chunk | Symbol | `ingestedAt` |
| `HAS_COMMIT` | Project | Commit | (none) |
| `PARENT` | Commit | Commit | (none) |
| `MODIFIES` | Commit | File | `changeType` (A/M/D/R/C) |
| `CHANGES` | Commit | Chunk | `hunkId`, `oldStart`, `oldLines`, `newStart`, `newLines` |
| `STRUCTURAL_EDGE` | File | File | `edgeId`, `kind`, `symbolName`, `line`, `isExternal`, `projectId`, `ingestedAt` |

**Structural Edge Kinds** (StructuralAnalyzer): `IMPORTS_FROM`, `CALLS`, `EXPORTS`

**Neo4j Constraints**: `project_id_unique` on `Project.projectId`

### 2.2 Knowledge Graph (GraphManager.ts)

**Node Labels and Properties:**

| Label | Properties | Identity Key |
|-------|-----------|--------------|
| `Entity` | `id` (UUID), `type` (EntityType enum), `name`, `properties` (JSON string), `createdAt`, `updatedAt`, `eventTime`, `ingestionTime` | `id` or MERGE on `(name, type)` |

**EntityType Enum Values**: `CONCEPT`, `PERSON`, `ORGANIZATION`, `LOCATION`, `EVENT`, `CODE_FILE`, `CODE_FUNCTION`, `CODE_CLASS`, `DECISION`, `TASK`, `ERROR`, `FACT`

**Relationship Types:**

| Type | From | To | Properties |
|------|------|----|-----------|
| `RELATIONSHIP` | Entity | Entity | `id`, `type` (RelationshipType), `properties` (JSON), `weight`, `createdAt`, `updatedAt`, `eventTime`, `ingestionTime` |

**RelationshipType Enum Values**: `DEPENDS_ON`, `RELATED_TO`, `CAUSES`, `IMPLEMENTS`, `USES`, `REFERENCES`, `FOLLOWS`, `CONTAINS`, `DERIVED_FROM`, `BLOCKS`, `CONTRADICTS`

### 2.3 Graph Model Issues

1. **Two parallel graph systems**: TemporalCodeGraph and GraphManager both write to the same Neo4j instance but use completely different schemas and patterns. No cross-referencing.
2. **Entity label collision risk**: GraphManager uses a generic `Entity` label for everything. TemporalCodeGraph uses specific labels (`Project`, `File`, `Chunk`, `Symbol`, `Commit`). A code file is a `File` node in one system and an `Entity{type:CODE_FILE}` node in the other.
3. **No unified identity**: No way to link a GraphManager `Entity{type:CODE_FILE}` to a TemporalCodeGraph `File` node.

---

## 3. Qdrant Collections

### 3.1 Memory Vectors (QdrantClient)

**Collection**: configurable via `QDRANT_COLLECTION_NAME` (default: `ping-mem-vectors`)

**Vector Config**: configurable dimensions (default 768), Cosine distance

**Point Schema** (per memory):
| Field | Location | Type | Notes |
|-------|----------|------|-------|
| `id` | point ID | string (MemoryId) | |
| `vector` | embedding | Float32Array | 768 dimensions default |
| `session_id` | payload | string | |
| `content` | payload | string | |
| `category` | payload | string or null | |
| `indexed_at` | payload | ISO-8601 string | |
| `metadata` | payload | object or null | |

### 3.2 Code Chunk Vectors (CodeIndexer)

**Collection**: same collection as above (shared)

**Point Schema** (per code chunk):
| Field | Location | Type | Notes |
|-------|----------|------|-------|
| `id` | point ID | UUID v5 (derived from chunkId SHA-256) | |
| `vector` | embedding | number[] | DeterministicVectorizer (hash-based, no ML) |
| `projectId` | payload | string | |
| `filePath` | payload | string | |
| `chunkId` | payload | string | Original SHA-256 chunk ID |
| `sha256` | payload | string | File content hash |
| `type` | payload | string | code/comment/docstring |
| `content` | payload | string | Truncated to 2000 chars |
| `contentTruncated` | payload | boolean | |
| `contentFullLength` | payload | number | |
| `start` | payload | number | Byte offset |
| `end` | payload | number | Byte offset |
| `lineStart` | payload | number | |
| `lineEnd` | payload | number | |
| `ingestedAt` | payload | string | |

### 3.3 Qdrant Issues

1. **Shared collection**: Memory vectors and code chunk vectors share the same Qdrant collection with no namespace separation. Different vector dimensions (ML-based 768 for memories vs hash-based for code) in the same collection is a collision risk.
2. **No project-scoped cleanup**: Memory vectors have no `projectId` field, only `session_id`. Cleaning up a project's code vectors is possible (filter by `projectId`), but cleaning memory vectors requires session-level cleanup.

---

## 4. What's Missing for Consolidation

### 4.1 Agent Identity Store

**Current state**: `agent_quotas` table stores minimal registration data:
- `agent_id`, `role`, `admin` flag, `ttl_ms`, `expires_at`, quota counters, `metadata` JSON blob
- No structured capabilities, behavioral rules, correction history, preferences, or soul values
- The `metadata` blob is the only extension point, but nothing writes structured agent profiles there

**Needed for consolidation**:
```
NEW TABLE: agent_profiles
  agent_id TEXT PRIMARY KEY (FK -> agent_quotas)
  display_name TEXT
  capabilities TEXT NOT NULL DEFAULT '[]'     -- JSON array of capability strings
  behavioral_rules TEXT NOT NULL DEFAULT '[]' -- JSON array of rules
  preferences TEXT NOT NULL DEFAULT '{}'      -- JSON object
  soul_values TEXT NOT NULL DEFAULT '{}'      -- JSON object (agent personality/values)
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL

NEW TABLE: agent_corrections
  correction_id TEXT PRIMARY KEY
  agent_id TEXT NOT NULL (FK -> agent_quotas)
  session_id TEXT NOT NULL
  correction_type TEXT NOT NULL               -- 'behavioral', 'factual', 'preference'
  original_action TEXT NOT NULL               -- What the agent did
  corrected_action TEXT NOT NULL              -- What it should have done
  context TEXT                                -- Surrounding context
  learned_rule TEXT                           -- Extracted behavioral rule
  created_at TEXT NOT NULL
```

### 4.2 Universal Memory Store

**Current state**: Memories are stored as `MEMORY_SAVED` events in the `events` table. The actual memory key/value is buried in the `payload` JSON blob. There is no structured memory table -- all memory retrieval requires scanning events and replaying state.

**Problems**:
- No direct key lookup -- must scan all `MEMORY_SAVED`/`MEMORY_UPDATED`/`MEMORY_DELETED` events for a session
- No cross-session memory (each memory is scoped to a session_id)
- No namespace or project scoping on the memory itself
- No compression tier tracking
- No access pattern tracking for importance scoring

**Needed for consolidation**:
```
NEW TABLE: memories
  memory_id TEXT PRIMARY KEY (UUIDv7)
  key TEXT NOT NULL
  value TEXT NOT NULL
  namespace TEXT NOT NULL DEFAULT 'default'   -- 'project', 'agent', 'global', 'session'
  project_id TEXT                              -- NULL for global memories
  session_id TEXT                              -- NULL for persistent memories
  agent_id TEXT                                -- Who created it
  category TEXT                                -- note, decision, fact, preference, etc.
  priority TEXT DEFAULT 'medium'               -- low, medium, high, critical
  compression_tier INTEGER DEFAULT 0           -- 0=raw, 1=summarized, 2=digest
  access_count INTEGER DEFAULT 0
  last_accessed_at TEXT
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL
  expires_at TEXT                              -- TTL support
  UNIQUE(namespace, project_id, key)

INDEX: idx_memories_namespace(namespace, project_id)
INDEX: idx_memories_key(key)
INDEX: idx_memories_agent(agent_id)
```

### 4.3 Task/Work Tracking

**Current state**: No task tracking in ping-mem at all. Tasks exist in:
- `~/.claude/tasks/` as JSON files (~182 task JSON files across multiple sessions)
- Understory's `memory.sqlite` has a tasks table (separate system)
- Worklog events (`TOOL_RUN_RECORDED`, `AGENT_TASK_STARTED`, etc.) capture activity but not task state

**Needed for consolidation**:
```
NEW TABLE: tasks
  task_id TEXT PRIMARY KEY (UUIDv7)
  title TEXT NOT NULL
  description TEXT
  status TEXT NOT NULL DEFAULT 'pending'       -- pending, in_progress, blocked, completed, cancelled
  owner_agent_id TEXT                          -- Which agent owns this
  project_id TEXT                              -- Which project
  session_id TEXT                              -- Which session created it
  parent_task_id TEXT                          -- Subtask support (FK -> tasks)
  priority TEXT DEFAULT 'medium'
  dependencies TEXT DEFAULT '[]'               -- JSON array of task_ids
  metadata TEXT DEFAULT '{}'                   -- JSON blob for extra data
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL
  started_at TEXT
  completed_at TEXT
  due_at TEXT

INDEX: idx_tasks_status(status, project_id)
INDEX: idx_tasks_owner(owner_agent_id)
INDEX: idx_tasks_parent(parent_task_id)
```

### 4.4 Decision Log

**Current state**: Decisions are stored in two places:
- `.ai/decisions.jsonl` (770 lines, JSONL format, project-scoped)
- As `MEMORY_SAVED` events with category='decision' in EventStore

**Problems**: Dual-write with no sync. The JSONL file has richer structure (type, rationale, linked issues) while the EventStore version is a flat key/value.

**Needed for consolidation**:
```
NEW TABLE: decisions
  decision_id TEXT PRIMARY KEY (UUIDv7)
  project_id TEXT NOT NULL
  session_id TEXT
  agent_id TEXT
  title TEXT NOT NULL
  type TEXT NOT NULL                           -- 'architectural', 'implementation', 'process', 'tool'
  rationale TEXT NOT NULL
  status TEXT DEFAULT 'active'                 -- active, superseded, reverted
  alternatives_considered TEXT DEFAULT '[]'    -- JSON array
  linked_plan TEXT                             -- Path or ID of related plan
  linked_issues TEXT DEFAULT '[]'              -- JSON array of issue refs
  superseded_by TEXT                           -- FK -> decisions(decision_id)
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL

INDEX: idx_decisions_project(project_id, created_at)
INDEX: idx_decisions_status(status)
```

### 4.5 Learning Store

**Current state**: Learnings exist in:
- `~/.claude/learnings/domains/*.json` (~908 lines across 11 domain files)
- `~/.claude/learnings/index.json` (71 lines, cross-reference index)
- `~/.claude/learnings/v2/injections.jsonl` and `outcomes.jsonl` (v2 learning system)
- `knowledge_entries` table in EventStore DB (KnowledgeStore, FTS5-searchable)

**Problems**: The file-based learnings have structured domain categorization, confidence levels, and application contexts that `knowledge_entries` lacks. KnowledgeStore is designed for troubleshooting knowledge (symptoms, root cause, solution), not behavioral learnings.

**Needed for consolidation**:
```
NEW TABLE: learnings
  learning_id TEXT PRIMARY KEY (UUIDv7)
  domain TEXT NOT NULL                         -- typescript, testing, security, etc.
  title TEXT NOT NULL
  content TEXT NOT NULL                        -- The learning itself
  confidence REAL DEFAULT 0.5                  -- 0.0 to 1.0
  source TEXT NOT NULL                         -- 'user_correction', 'observation', 'research', 'outcome'
  source_session_id TEXT                       -- Which session produced it
  source_project_id TEXT                       -- Which project context
  when_to_apply TEXT                           -- Conditions for applying this learning
  verification_status TEXT DEFAULT 'unverified' -- unverified, verified, disputed, deprecated
  verified_at TEXT
  applied_count INTEGER DEFAULT 0
  last_applied_at TEXT
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL

INDEX: idx_learnings_domain(domain)
INDEX: idx_learnings_confidence(confidence DESC)

VIRTUAL TABLE: learnings_fts USING fts5(title, content, domain, when_to_apply)
```

---

## 5. Migration Path

### 5.1 decisions.jsonl -> decisions table

| Attribute | Value |
|-----------|-------|
| **Source** | `/Users/umasankr/Projects/ping-mem/.ai/decisions.jsonl` |
| **Format** | JSONL (one JSON object per line) |
| **Row count** | ~770 entries |
| **Migration strategy** | Bulk import script: read JSONL, parse each line, INSERT into `decisions` table. Map existing fields to new schema. Run once, then redirect writes to new table. |
| **Data loss risk** | LOW. JSONL is append-only and well-structured. Reverse mapping is straightforward. Keep JSONL as read-only backup for 30 days. |

### 5.2 ~/.claude/learnings/ -> learnings table

| Attribute | Value |
|-----------|-------|
| **Source** | `~/.claude/learnings/domains/*.json` (11 files), `index.json`, `v2/*.jsonl` |
| **Format** | JSON files (domain-keyed) + JSONL (v2 injections/outcomes) |
| **Row count** | ~50-100 learnings across all files (908 lines includes JSON formatting) |
| **Migration strategy** | Bridge script: parse each domain JSON, extract individual learnings, INSERT with domain tag. Parse v2 JSONL for outcome-based learnings. Merge with existing `knowledge_entries` where overlap exists. |
| **Data loss risk** | LOW. Files are small and well-structured. Keep original files as backup. The main risk is deduplication -- some learnings may already exist as `knowledge_entries`. |

### 5.3 ~/.claude/tasks/ -> tasks table

| Attribute | Value |
|-----------|-------|
| **Source** | `~/.claude/tasks/<uuid>/*.json` |
| **Format** | JSON files (one per task message/update) |
| **Row count** | ~182 JSON files across multiple task sessions |
| **Migration strategy** | Parse task JSONs to extract task identity, status, and metadata. These are Claude Code internal task tool messages, so structure may vary. Import as historical records with `status='completed'` or `status='unknown'`. |
| **Data loss risk** | MEDIUM. Task JSON format is Claude Code internal and may change. Some files may be partial (lock files, highwatermark files exist alongside data). Historical value is limited -- focus on extracting task titles and outcomes rather than full replay. |

### 5.4 EventStore memories -> memories table

| Attribute | Value |
|-----------|-------|
| **Source** | `events` table, filtered by `event_type IN ('MEMORY_SAVED', 'MEMORY_UPDATED', 'MEMORY_DELETED')` |
| **Format** | JSON payloads in SQLite rows |
| **Row count** | Variable (depends on usage; likely 100s-1000s) |
| **Migration strategy** | Replay-based migration: scan events in timestamp order, apply SAVED/UPDATED/DELETED operations to build final state, INSERT result into `memories` table. Keep events table as the audit log (do NOT delete events). |
| **Data loss risk** | LOW. Event replay is deterministic. The events table continues to exist as the immutable audit trail. The `memories` table is a materialized view of current state. |

### 5.5 knowledge_entries -> learnings table (partial merge)

| Attribute | Value |
|-----------|-------|
| **Source** | `knowledge_entries` table in events.db |
| **Format** | SQLite table with FTS5 |
| **Row count** | Variable |
| **Migration strategy** | Gradual sync. Knowledge entries that represent troubleshooting knowledge stay in `knowledge_entries` (it has the right schema for that). Entries that are actually behavioral learnings get copied to `learnings` table with appropriate domain tagging. KnowledgeStore continues to operate for its intended purpose. |
| **Data loss risk** | NONE. This is additive -- no data is removed from knowledge_entries. |

---

## 6. Database Consolidation Strategy

### Current State: 3 databases

```
~/.ping-mem/events.db      -- events, checkpoints, agent_quotas, write_locks, knowledge_entries, code_chunks
~/.ping-mem/diagnostics.db -- diagnostic_runs, diagnostic_findings, diagnostic_summaries
~/.ping-mem/admin.db       -- admin_api_keys, admin_projects, admin_llm_config
```

### Recommended Target: 2 databases

```
~/.ping-mem/ping-mem.db    -- EVERYTHING except diagnostics
  events, checkpoints, checkpoint_items, migrations,
  agent_quotas, agent_profiles, agent_corrections, write_locks,
  knowledge_entries, knowledge_fts,
  code_chunks, code_fts,
  memories, memories_fts (if needed),
  tasks,
  decisions,
  learnings, learnings_fts,
  admin_api_keys, admin_projects, admin_llm_config

~/.ping-mem/diagnostics.db -- Diagnostics only (kept separate due to size)
  diagnostic_runs, diagnostic_findings, diagnostic_summaries
```

**Rationale for keeping diagnostics separate**: Raw SARIF blobs in `diagnostic_runs.raw_sarif` can be multi-MB each. A busy CI pipeline can generate thousands of runs. Keeping diagnostics in its own DB prevents WAL bloat and VACUUM contention from affecting the core memory store.

**Rationale for merging admin into main**: admin.db has 3 tiny tables (API keys, project registry, LLM config). The overhead of a separate database + separate WAL + separate connection is not justified.

### Neo4j: No Schema Changes Required

The two parallel graph systems (TemporalCodeGraph + GraphManager) serve different purposes and can coexist. The consolidation of external data into SQLite does not require Neo4j changes. However, a future improvement should:
- Add cross-references between `Entity{type:CODE_FILE}` nodes and `File` nodes
- Consider using TemporalCodeGraph labels for code entities instead of generic `Entity` label

### Qdrant: Namespace Separation Needed

- Add a `namespace` payload field to all points: `"memory"` for memory vectors, `"code"` for code chunk vectors
- Use payload filter on `namespace` in all queries to prevent cross-contamination
- Long-term: consider separate collections for memory vs code search

---

## 7. Summary of Changes

| Change | Type | Effort | Priority |
|--------|------|--------|----------|
| Add `memories` table | New table | Medium | P0 -- Core consolidation |
| Add `tasks` table | New table | Medium | P1 -- Replaces file-based tasks |
| Add `decisions` table | New table | Medium | P1 -- Replaces JSONL dual-write |
| Add `learnings` table + FTS5 | New table | Medium | P1 -- Replaces file-based learnings |
| Add `agent_profiles` table | New table | Low | P2 -- Agent identity enrichment |
| Add `agent_corrections` table | New table | Low | P2 -- Behavioral learning |
| Merge admin.db into main db | Schema migration | Low | P2 -- Simplifies connection management |
| Qdrant namespace separation | Payload change | Low | P2 -- Prevents vector collision |
| decisions.jsonl migration script | One-time script | Low | P1 -- Alongside decisions table |
| learnings/ migration script | One-time script | Low | P1 -- Alongside learnings table |
| tasks/ migration script | One-time script | Low | P1 -- Alongside tasks table |
| Event replay -> memories materialization | One-time script | Medium | P0 -- Alongside memories table |
