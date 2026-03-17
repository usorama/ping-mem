---
title: "feat: Universal Intelligence Consolidation — single memory backend for all agents, IDEs, and humans"
type: feat
date: 2026-03-17
status: verified
github_issues: []
github_pr: null
research: docs/ping-mem-consolidation-research/ (6 documents)
synthesis: docs/ping-mem-consolidation-research/05-synthesis.md
eval_iteration: 1
review_iteration: 1
verification_iteration: 1
verification_method: "3-eval + 1-review + 1-verify agents (32 claims checked, 22 verified, 10 fixed)"
---

# Universal Intelligence Consolidation Plan

## 1. Problem Statement

### The Fragmentation Problem

ping-mem's ecosystem currently has **31+ SQLite databases**, **5 decisions.jsonl files**, and **7 separate systems** performing memory operations across different projects and tools. Data is siloed, duplicated, and often contradictory.

**Evidence of fragmentation**:

| Source | Location | Records | Problem |
|--------|----------|---------|---------|
| EventStore (events.db) | `~/.ping-mem/events.db` | ~5,000+ events | Memories buried in JSON payloads; requires replay for reads |
| DiagnosticsStore | `~/.ping-mem/diagnostics.db` | ~hundreds of runs | Separate DB, separate connection, separate lifecycle |
| AdminStore | `~/.ping-mem/admin.db` | 3 tiny tables | Unjustified separate DB for ~10 rows total |
| decisions.jsonl | `.ai/decisions.jsonl` per project | ~770 entries (ping-mem) | Dual-write with EventStore; no structured query |
| Learnings files | `~/.claude/learnings/domains/*.json` | ~100 learnings across 11 files | Not searchable; no FTS5; no confidence tracking |
| Task files | `~/.claude/tasks/<uuid>/*.json` | ~182 files | Claude Code internal; no ping-mem awareness |
| MEMORY.md files | `~/.claude/memory/*.md` | Hierarchical markdown | Human-readable but not machine-queryable |
| Understory memory.db | Per-project SQLite | Variable | Separate system entirely |
| u-os memory.db | Per-project SQLite | Variable | Yet another separate memory system |

**Impact**: Agents lose context between sessions, make contradictory decisions, and waste tokens re-discovering information that exists in a different silo. Cross-project learnings do not propagate. No single view of what the system knows.

### Core Principle

**ping-mem becomes the single read authority for all memory.** File-based stores become write-through backups during a 3-month transition. After dashboard metrics confirm parity, file reads are deprecated.

---

## 2. Proposed Solution

### Architecture: ping-mem as Universal Hub

```
┌────────────────────────────────────────────────────────────────────┐
│                         AI Clients                                  │
│  Claude Code  Cursor  Codex  VS Code  Continue  Cline  Windsurf   │
│      │          │       │       │        │        │        │       │
│      └──────────┴───────┴───────┴────────┴────────┴────────┘       │
│                           │ stdio / HTTP                            │
│  ┌────────────────────────▼───────────────────────────────────┐    │
│  │              ping-mem MCP Server                            │    │
│  │  47+ tools (context, codebase, diagnostics, agents,        │    │
│  │  knowledge, worklog, memory, causal, structural)           │    │
│  │  + NEW: decisions, learnings, tasks, context_retrieve,     │    │
│  │         memory_explain, memory_check_contradictions        │    │
│  └──────────────────────┬─────────────────────────────────────┘    │
│                          │                                          │
│  ┌───────────┬───────────┼───────────┬─────────────────────────┐   │
│  │           │           │           │                         │   │
│  ▼           ▼           ▼           ▼                         ▼   │
│ SQLite     Neo4j      Qdrant    File Fallback            Embedding │
│ (2 DBs)   (graph)    (vectors)  (write-through)          Chain     │
│                                                                     │
│ ping-mem.db:              Temporal      Memory ns    decisions.jsonl │
│  events                   Code Graph    Code ns      learnings/     │
│  checkpoints              Knowledge     (separated)  tasks/         │
│  memories (NEW)           Graph                      MEMORY.md      │
│  decisions (NEW)          Causal Graph                              │
│  learnings (NEW)          (existing)                 Ollama (local) │
│  tasks (NEW)                                         → Gemini       │
│  admin_api_keys (merged)                             → OpenAI       │
│  admin_projects (merged)                                            │
│  admin_llm_config (merged)                                          │
│  system_config (NEW)                                                │
│  compression_audit_log (NEW)                                        │
│  eval_scores (NEW)                                                  │
│                                                                     │
│ diagnostics.db:                                                     │
│  diagnostic_runs                                                    │
│  diagnostic_findings                                                │
│  diagnostic_summaries                                               │
└────────────────────────────────────────────────────────────────────┘
```

---

## 3. Gap Coverage Matrix

Every gap from the synthesis (25 gaps) mapped to a phase and component.

| Gap | Description | Phase | Component | New File(s) |
|-----|-------------|-------|-----------|-------------|
| G1 | No structured `memories` table | 1 | MemoryStore | `src/storage/MemoryStore.ts` |
| G2 | 3 separate SQLite databases | 1 | Migration | `scripts/migrate-admin-to-main.ts` |
| G3 | No dual-write middleware | 1 | DualWriteMiddleware | `src/integration/DualWriteMiddleware.ts` |
| G4 | Event replay too slow for reads | 1 | MemoryStore | `src/storage/MemoryStore.ts` |
| G5 | No migration scripts | 1 | Migration scripts | `scripts/migrate-*.ts` (4 scripts) |
| G6 | Shared Qdrant without namespace | 1 | QdrantClient | Modify `src/search/QdrantClient.ts` |
| G7 | No token-budget retrieval | 2 | ContextRetriever | `src/search/ContextRetriever.ts` |
| G8 | No temporal relevance decay | 2 | TemporalDecay | `src/search/TemporalDecay.ts` |
| G9 | No `decisions` table | 1 | DecisionStore | `src/storage/DecisionStore.ts` |
| G10 | No `learnings` table with FTS5 | 1 | LearningStore | `src/storage/LearningStore.ts` |
| G11 | No `tasks` table | 1 | TaskStore | `src/storage/TaskStore.ts` |
| G12 | No contradiction detection | 1 | ContradictionDetector | Integrate existing `src/graph/ContradictionDetector.ts` into write path |
| G13 | Digest->Essence compression missing | 2 | SemanticCompressor | Modify `src/memory/SemanticCompressor.ts` |
| G14 | No eval baseline recorded | 4 | EvalBaseline | `src/eval/baseline.ts` |
| G15 | Only 1 IDE configured | 4 | Static docs | `docs/client-configs/` (8 template files) — CLI generator cut (S4) |
| G16 | No causal memory chains | 1 | CausalMemoryGraph | Modify existing `src/graph/CausalGraphManager.ts` |
| G17 | ~~No agent identity persistence~~ | ~~3~~ | ~~AgentProfileStore~~ | **CUT (S1)** — no consumer exists |
| G18 | No Session Resume Score eval | 4 | SRS eval | `src/eval/session-resume-score.ts` |
| G19 | No access-frequency tracking | 2 | MemoryStore | Modify `src/storage/MemoryStore.ts` |
| G20 | ~~No impact/staleness prediction~~ | ~~3~~ | ~~StalenessDetector~~ | **CUT (S6)** — speculative, no evidence of real problem |
| G21 | No longitudinal eval tracking | 4 | EvalTracker | `src/eval/longitudinal-tracker.ts` |
| G22 | ~~No cross-project entity linking~~ | ~~5~~ | ~~EntityLinker~~ | **CUT (S7)** — no consumer; existing `crossProject: true` search suffices |
| G23 | Two parallel Neo4j graph systems | 4 | GraphUnifier | Modify `src/graph/GraphManager.ts` — deferred to eval phase |
| G24 | ~~No config generate CLI~~ | ~~5~~ | ~~CLI~~ | **Replaced** with static `docs/client-configs/` (S4) |
| G25 | No compression audit trail | 2 | CompressionAudit | `src/memory/CompressionAuditLog.ts` |

---

## 4. Critical Questions -- Answers

### Q1: Memory Table Identity -- UUIDv7 or Content-Addressable?

**Answer**: UUIDv7 for `memory_id` (primary key, time-sortable). Add `content_hash = SHA-256(namespace + project_id + key)` with UNIQUE constraint for dedup. This satisfies both P2 (deterministic provenance) and time-ordering needs.

### Q2: How Does the Dual-Write Middleware Intercept File Writes?

**Answer**: ping-mem is the primary write target. The `DualWriteMiddleware` wraps MemoryStore/DecisionStore/LearningStore. On every write, it: (1) writes to SQLite first, (2) replicates to the corresponding file (decisions.jsonl, learnings/*.json, MEMORY.md) as best-effort. External tools that currently write directly to files must be updated to write to ping-mem instead via MCP tools. A file watcher (`FileChangeWatcher`) can detect external writes and sync them to ping-mem during the 3-month transition.

### Q3: What Happens to knowledge_entries During Consolidation?

**Answer**: Coexist. `knowledge_entries` stays for troubleshooting knowledge (symptoms/root_cause/solution schema is purpose-built). `learnings` is for behavioral learnings (domain/confidence/when_to_apply). Migration script copies behavioral entries from knowledge_entries to learnings, leaving troubleshooting entries in place.

### Q4: How Are Existing Qdrant Vectors Migrated to Include Namespace?

**Answer**: Batch update via Qdrant `set_payload` API. Script iterates all points, checks if `projectId` payload exists (code vector) or `session_id` payload exists (memory vector), and sets `namespace: "code"` or `namespace: "memory"` accordingly. Non-destructive, runs while system is live.

### Q5: What Is the Embedding Dimension for Memory Vectors?

**Answer**: Standardize on 768 dimensions (Ollama nomic-embed-text default). EmbeddingService already handles dimension configuration. Store provider ID as metadata on each vector for re-indexing if provider changes.

### Q6: How Does the memories Table Handle Cross-Session Memory?

**Answer**: The `namespace` field controls scope: `global` (no project, no session), `project` (project_id set), `session` (session-scoped), `agent` (agent_id set). The UNIQUE constraint on `(namespace, project_id, key)` prevents collisions. Session-scoped memories encode session_id in namespace as `session:{session_id}`.

### Q7: What Token Counter Is Used for Budget-Aware Retrieval?

**Answer**: Use the `js-tiktoken` package with `cl100k_base` encoding (GPT-4/Claude compatible). Apply 10% safety margin (return results fitting 90% of requested budget). Accept optional `tokenizer` parameter for callers with specific needs.

### Q8: How Is the Frozen Eval Dataset Created?

**Answer**: Semi-automated: (1) sample 50+ real queries from EventStore logs, (2) run current retrieval for each, (3) LLM-as-Judge labels relevance per result, (4) human validates 100% of labels, (5) freeze with version hash SHA-256. Stored at `src/eval/datasets/frozen-v1.json`. Review quarterly.

### Q9: How Does Admin DB Merge Work Without Downtime?

**Answer**: SQLite ATTACH database. Migration script: (1) creates tables in ping-mem.db if not exist, (2) `INSERT OR IGNORE INTO main.admin_api_keys SELECT * FROM admin_db.admin_api_keys`, (3) updates runtime.ts to use single connection. Zero downtime -- reads from either DB work during transition.

### Q10: What Is the Agent Correction Extraction Strategy?

**Answer**: Initially manual -- agents call `agent_correction_record` with explicit `original_action`, `corrected_action`, and `learned_rule`. Future: LLM-based detection from conversation patterns (when user says "no, do X instead").

### Q11: How Are File-Based Store Readers Updated?

**Answer**: Phase 1 updates CLAUDE.md and AGENTS.md to instruct agents to use ping-mem MCP tools for reads. cc-memory and cc-connect skills updated to call ping-mem first, file as fallback. 3-month transition allows both paths.

### Q12: Where Are Tunable Parameters Stored?

**Answer**: New `system_config` table in ping-mem.db (`config_key TEXT PK, config_value TEXT, updated_at TEXT`). HybridSearchEngine reads on init, caches, refreshes on config change event via MemoryPubSub.

---

## 5. Phase 1: Core Consolidation

**Goal**: Establish ping-mem as the single structured store for all memory types. Create foundation tables, migration scripts, and dual-write middleware.

**Effort**: 2-3 weeks
**Prerequisites**: None (foundational phase)

### 5.1 Database Schema -- New Tables

All tables added to `~/.ping-mem/ping-mem.db` (the existing events.db, renamed).

#### Table: `memories`

```sql
CREATE TABLE IF NOT EXISTS memories (
  memory_id     TEXT PRIMARY KEY,           -- UUIDv7
  content_hash  TEXT NOT NULL,              -- SHA-256(namespace + project_id + key)
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  namespace     TEXT NOT NULL DEFAULT 'default',
  project_id    TEXT,
  session_id    TEXT,
  agent_id      TEXT,
  category      TEXT CHECK(category IN ('note','decision','fact','preference','observation')),
  priority      TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
  compression_tier INTEGER DEFAULT 0,       -- 0=raw, 1=digest, 2=essence
  access_count  INTEGER DEFAULT 0,
  last_accessed_at TEXT,
  embedding_status TEXT DEFAULT 'pending' CHECK(embedding_status IN ('pending','indexed','failed')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  expires_at    TEXT,
  caused_by_event_id TEXT,                  -- FK -> events(event_id)
  token_count       INTEGER                -- cached token count of value (avoids re-tokenization)
  -- NOTE: UNIQUE constraint handled via COALESCE index below (NULL project_id safe)
);

-- NULL-safe unique constraint: COALESCE ensures NULL project_id doesn't break uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_unique_key
  ON memories(namespace, COALESCE(project_id, ''), key);

CREATE INDEX idx_memories_namespace ON memories(namespace, project_id);
CREATE INDEX idx_memories_key ON memories(key);
CREATE INDEX idx_memories_agent ON memories(agent_id);
CREATE INDEX idx_memories_category ON memories(category);
CREATE INDEX idx_memories_hash ON memories(content_hash);
CREATE INDEX idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;
```

#### Table: `decisions`

```sql
CREATE TABLE IF NOT EXISTS decisions (
  decision_id          TEXT PRIMARY KEY,     -- UUIDv7
  project_id           TEXT NOT NULL,
  session_id           TEXT,
  agent_id             TEXT,
  title                TEXT NOT NULL,
  type                 TEXT NOT NULL CHECK(type IN ('architectural','implementation','process','tool')),
  rationale            TEXT NOT NULL,
  status               TEXT DEFAULT 'active' CHECK(status IN ('active','superseded','reverted')),
  alternatives_considered TEXT DEFAULT '[]',  -- JSON array
  linked_plan          TEXT,
  linked_issues        TEXT DEFAULT '[]',     -- JSON array
  superseded_by        TEXT,                  -- FK -> decisions(decision_id)
  tags                 TEXT DEFAULT '[]',     -- JSON array
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX idx_decisions_project ON decisions(project_id, created_at DESC);
CREATE INDEX idx_decisions_status ON decisions(status);
CREATE INDEX idx_decisions_type ON decisions(type);

-- FTS5 virtual table for full-text search on decisions
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  title, rationale, tags,
  content='decisions',
  content_rowid='rowid'
);

-- Sync triggers for decisions FTS
CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, title, rationale, tags)
  VALUES (NEW.rowid, NEW.title, NEW.rationale, NEW.tags);
END;

CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, title, rationale, tags)
  VALUES('delete', OLD.rowid, OLD.title, OLD.rationale, OLD.tags);
END;

CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, title, rationale, tags)
  VALUES('delete', OLD.rowid, OLD.title, OLD.rationale, OLD.tags);
  INSERT INTO decisions_fts(rowid, title, rationale, tags)
  VALUES (NEW.rowid, NEW.title, NEW.rationale, NEW.tags);
END;
```

#### Table: `learnings`

```sql
CREATE TABLE IF NOT EXISTS learnings (
  learning_id         TEXT PRIMARY KEY,       -- UUIDv7
  domain              TEXT NOT NULL,           -- typescript, testing, security, git, etc.
  title               TEXT NOT NULL,
  content             TEXT NOT NULL,
  confidence          REAL DEFAULT 0.5,        -- 0.0 to 1.0
  source              TEXT NOT NULL CHECK(source IN ('user_correction','observation','research','outcome')),
  source_session_id   TEXT,
  source_project_id   TEXT,
  agent_id            TEXT,
  when_to_apply       TEXT,                    -- Conditions for applying
  verification_status TEXT DEFAULT 'unverified' CHECK(verification_status IN ('unverified','verified','disputed','deprecated')),
  verified_at         TEXT,
  applied_count       INTEGER DEFAULT 0,
  last_applied_at     TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_learnings_domain ON learnings(domain);
CREATE INDEX idx_learnings_confidence ON learnings(confidence DESC);
CREATE INDEX idx_learnings_source ON learnings(source);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(
  title, content, domain, when_to_apply,
  content='learnings',
  content_rowid='rowid'
);

-- Sync triggers
CREATE TRIGGER IF NOT EXISTS learnings_ai AFTER INSERT ON learnings BEGIN
  INSERT INTO learnings_fts(rowid, title, content, domain, when_to_apply)
  VALUES (NEW.rowid, NEW.title, NEW.content, NEW.domain, NEW.when_to_apply);
END;

CREATE TRIGGER IF NOT EXISTS learnings_ad AFTER DELETE ON learnings BEGIN
  INSERT INTO learnings_fts(learnings_fts, rowid, title, content, domain, when_to_apply)
  VALUES('delete', OLD.rowid, OLD.title, OLD.content, OLD.domain, OLD.when_to_apply);
END;

CREATE TRIGGER IF NOT EXISTS learnings_au AFTER UPDATE ON learnings BEGIN
  INSERT INTO learnings_fts(learnings_fts, rowid, title, content, domain, when_to_apply)
  VALUES('delete', OLD.rowid, OLD.title, OLD.content, OLD.domain, OLD.when_to_apply);
  INSERT INTO learnings_fts(rowid, title, content, domain, when_to_apply)
  VALUES (NEW.rowid, NEW.title, NEW.content, NEW.domain, NEW.when_to_apply);
END;
```

#### Table: `tasks`

```sql
CREATE TABLE IF NOT EXISTS tasks (
  task_id         TEXT PRIMARY KEY,           -- UUIDv7
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','blocked','completed','cancelled')),
  owner_agent_id  TEXT,
  project_id      TEXT,
  session_id      TEXT,
  parent_task_id  TEXT,                       -- FK -> tasks(task_id)
  priority        TEXT DEFAULT 'medium',
  dependencies    TEXT DEFAULT '[]',           -- JSON array of task_ids
  metadata        TEXT DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  due_at          TEXT
);

CREATE INDEX idx_tasks_status ON tasks(status, project_id);
CREATE INDEX idx_tasks_owner ON tasks(owner_agent_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_tasks_project ON tasks(project_id, created_at DESC);
```

#### Table: `agent_profiles`

```sql
CREATE TABLE IF NOT EXISTS agent_profiles (
  agent_id          TEXT PRIMARY KEY,          -- FK -> agent_quotas(agent_id)
  display_name      TEXT,
  capabilities      TEXT NOT NULL DEFAULT '[]', -- JSON array
  behavioral_rules  TEXT NOT NULL DEFAULT '[]', -- JSON array
  preferences       TEXT NOT NULL DEFAULT '{}', -- JSON object
  soul_values       TEXT NOT NULL DEFAULT '{}', -- JSON object (immutable core)
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
```

#### Table: `agent_corrections`

```sql
CREATE TABLE IF NOT EXISTS agent_corrections (
  correction_id     TEXT PRIMARY KEY,          -- UUIDv7
  agent_id          TEXT NOT NULL,             -- FK -> agent_quotas(agent_id)
  session_id        TEXT NOT NULL,
  project_id        TEXT,
  correction_type   TEXT NOT NULL CHECK(correction_type IN ('behavioral','factual','preference')),
  original_action   TEXT NOT NULL,
  corrected_action  TEXT NOT NULL,
  context           TEXT,
  learned_rule      TEXT,
  applied           INTEGER DEFAULT 0,         -- Has rule been applied to profile?
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_corrections_agent ON agent_corrections(agent_id, created_at DESC);
CREATE INDEX idx_corrections_type ON agent_corrections(correction_type);
```

#### Table: `system_config`

```sql
CREATE TABLE IF NOT EXISTS system_config (
  config_key    TEXT PRIMARY KEY,
  config_value  TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  updated_by    TEXT                           -- agent_id or 'system'
);
```

#### Table: `project_access_rules` (Moved from Phase 5 per Security EVAL)

Cross-project isolation must be enforced from day one, not deferred.

```sql
CREATE TABLE IF NOT EXISTS project_access_rules (
  rule_id           TEXT PRIMARY KEY,
  source_project_id TEXT NOT NULL,
  target_project_id TEXT NOT NULL,
  access_level      TEXT NOT NULL DEFAULT 'read' CHECK(access_level IN ('read','none')),
  created_at        TEXT NOT NULL,
  UNIQUE(source_project_id, target_project_id)
);

CREATE INDEX idx_access_source ON project_access_rules(source_project_id);
```

**Enforcement**: All cross-project queries (in HybridSearchEngine, CodeIndexer, ContextRetriever) must check `project_access_rules` before returning results. Default behavior when no rule exists: `read` (open by default, closed by explicit deny).

### 5.2 New Files to Create

| File | Purpose | Est. Lines |
|------|---------|------------|
| `src/storage/MemoryStore.ts` | CRUD for `memories` table, access tracking, TTL expiry | ~300 |
| `src/storage/DecisionStore.ts` | CRUD for `decisions` table, supersession chain | ~200 |
| `src/storage/LearningStore.ts` | CRUD for `learnings` table, FTS5 search | ~250 |
| `src/storage/TaskStore.ts` | CRUD for `tasks` table, status transitions, hierarchy | ~250 |
| ~~`src/storage/AgentProfileStore.ts`~~ | ~~CRUD for `agent_profiles` + `agent_corrections`~~ | **CUT (S1, S2)** |
| `src/storage/SystemConfigStore.ts` | CRUD for `system_config`, cached reads | ~100 |
| `src/integration/DualWriteMiddleware.ts` | Write-through to files + sync audit | ~250 |
| `scripts/migrate-decisions.ts` | Import decisions.jsonl -> decisions table | ~150 |
| `scripts/migrate-learnings.ts` | Import learnings/*.json -> learnings table | ~150 |
| `scripts/migrate-tasks.ts` | Import tasks/*.json -> tasks table | ~150 |
| `scripts/migrate-memories.ts` | Event replay -> memories table | ~200 |
| `scripts/migrate-admin-to-main.ts` | Merge admin.db tables into ping-mem.db | ~100 |
| `scripts/migrate-qdrant-namespaces.ts` | Add namespace payload to existing Qdrant points | ~100 |
| `src/storage/__tests__/MemoryStore.test.ts` | Tests for MemoryStore | ~200 |
| `src/storage/__tests__/DecisionStore.test.ts` | Tests for DecisionStore | ~150 |
| `src/storage/__tests__/LearningStore.test.ts` | Tests for LearningStore | ~200 |
| `src/storage/__tests__/TaskStore.test.ts` | Tests for TaskStore | ~150 |
| ~~`src/storage/__tests__/AgentProfileStore.test.ts`~~ | ~~Tests for AgentProfileStore~~ | **CUT (S1, S2)** |
| `src/mcp/handlers/DecisionToolModule.ts` | MCP tool definitions for decisions | ~200 |
| `src/mcp/handlers/LearningToolModule.ts` | MCP tool definitions for learnings | ~200 |
| `src/mcp/handlers/TaskToolModule.ts` | MCP tool definitions for tasks | ~200 |
| `scripts/audit-sync.ts` | Diff file stores vs DB tables; report parity gaps; used in deprecation timeline | ~200 |
| `src/validation/consolidation-schemas.ts` | Zod validation schemas for all new POST/PUT endpoints (17 endpoints) | ~300 |

### 5.3 Files to Modify

| File | Line Count | Change Description |
|------|------------|-------------------|
| `src/storage/EventStore.ts` | 1068 | Add schema migration for new tables; rename DB from events.db to ping-mem.db with backward compat |
| `src/config/runtime.ts` | 185 | Add MemoryStore, DecisionStore, LearningStore, TaskStore, AgentProfileStore to RuntimeServices |
| `src/mcp/PingMemServer.ts` | 430 | Register DecisionToolModule, LearningToolModule, TaskToolModule |
| `src/mcp/handlers/index.ts` | 18 | Export new tool modules |
| `src/http/rest-server.ts` | 3498 | **Do NOT add endpoints here** — use route files in `src/http/routes/*.ts` (see Section 19 architectural fix) |
| `src/search/QdrantClient.ts` | 723 | Add namespace payload to all upsert/search operations |
| `src/search/CodeIndexer.ts` | 478 | Add `namespace: "code"` to all indexed points |
| `src/search/VectorIndex.ts` | 593 | Add `namespace: "memory"` to all memory vector operations |
| `src/memory/MemoryManager.ts` | 1439 | Delegate to MemoryStore for writes; update read path to use materialized table |

### 5.4 Function Signatures

```typescript
// src/storage/MemoryStore.ts
export class MemoryStore {
  constructor(db: Database);
  initialize(): void;
  save(params: {
    key: string; value: string; namespace?: string;
    projectId?: string; sessionId?: string; agentId?: string;
    category?: string; priority?: string; expiresAt?: string;
    causedByEventId?: string;
  }): MemoryRecord;
  get(key: string, namespace?: string, projectId?: string): MemoryRecord | null;
  getById(memoryId: string): MemoryRecord | null;
  search(query: string, opts?: { namespace?: string; projectId?: string; limit?: number }): MemoryRecord[];
  update(key: string, value: string, namespace?: string, projectId?: string): MemoryRecord;
  delete(key: string, namespace?: string, projectId?: string): boolean;
  incrementAccess(memoryId: string): void;
  expireStale(): number;  // Returns count of expired memories
  listByAgent(agentId: string, limit?: number): MemoryRecord[];
  rebuild(eventStore: EventStore): number;  // Replay events; returns count
}

// src/storage/DecisionStore.ts
export class DecisionStore {
  constructor(db: Database);
  initialize(): void;
  save(params: {
    projectId: string; title: string; type: string;
    rationale: string; sessionId?: string; agentId?: string;
    alternativesConsidered?: string[]; linkedPlan?: string;
    linkedIssues?: string[]; tags?: string[];
  }): DecisionRecord;
  get(decisionId: string): DecisionRecord | null;
  list(projectId: string, opts?: { status?: string; type?: string; limit?: number }): DecisionRecord[];
  supersede(decisionId: string, newDecisionId: string): void;
  revert(decisionId: string): void;
  search(query: string, projectId?: string): DecisionRecord[];
}

// src/storage/LearningStore.ts
export class LearningStore {
  constructor(db: Database);
  initialize(): void;
  save(params: {
    domain: string; title: string; content: string;
    source: string; confidence?: number;
    sourceSessionId?: string; sourceProjectId?: string; agentId?: string;
    whenToApply?: string;
  }): LearningRecord;
  get(learningId: string): LearningRecord | null;
  search(query: string, opts?: { domain?: string; projectId?: string; limit?: number }): LearningRecord[];
  verify(learningId: string): void;
  deprecate(learningId: string): void;
  incrementApplied(learningId: string): void;
  listByDomain(domain: string, limit?: number): LearningRecord[];
}

// src/storage/TaskStore.ts
export class TaskStore {
  constructor(db: Database);
  initialize(): void;
  save(params: {
    title: string; description?: string; status?: string;
    ownerAgentId?: string; projectId?: string; sessionId?: string;
    parentTaskId?: string; priority?: string; dependencies?: string[];
    dueAt?: string;
  }): TaskRecord;
  get(taskId: string): TaskRecord | null;
  list(opts?: { projectId?: string; status?: string; ownerAgentId?: string; limit?: number }): TaskRecord[];
  updateStatus(taskId: string, status: string): TaskRecord;
  getSubtasks(parentTaskId: string): TaskRecord[];
  getDependencyTree(taskId: string): TaskRecord[];
}

// src/storage/AgentProfileStore.ts
export class AgentProfileStore {
  constructor(db: Database);
  initialize(): void;
  upsertProfile(params: {
    agentId: string; displayName?: string; capabilities?: string[];
    behavioralRules?: string[]; preferences?: Record<string, unknown>;
    soulValues?: Record<string, unknown>;
  }): AgentProfileRecord;
  getProfile(agentId: string): AgentProfileRecord | null;
  recordCorrection(params: {
    agentId: string; sessionId: string; projectId?: string;
    correctionType: string; originalAction: string; correctedAction: string;
    context?: string; learnedRule?: string;
  }): AgentCorrectionRecord;
  getCorrections(agentId: string, limit?: number): AgentCorrectionRecord[];
  addBehavioralRule(agentId: string, rule: string): void;
}

// src/integration/DualWriteMiddleware.ts
export class DualWriteMiddleware {
  constructor(stores: {
    memoryStore: MemoryStore; decisionStore: DecisionStore;
    learningStore: LearningStore; taskStore: TaskStore;
  });
  saveDecisionWithFallback(decision: DecisionInput, jsonlPath: string): DecisionRecord;
  saveLearningWithFallback(learning: LearningInput, domainFilePath: string): LearningRecord;
  saveMemoryWithFallback(memory: MemoryInput, memoryMdPath: string): MemoryRecord;
  auditSync(diffs: SyncDiffResult[]): void;
}
```

### 5.5 REST Endpoints Added (Phase 1)

> **AMENDED (Review A1)**: All new endpoints MUST be added as route files in `src/http/routes/*.ts`, NOT in rest-server.ts (already 3498 lines / 59 endpoints). Create `src/http/routes/memories.ts`, `src/http/routes/decisions.ts`, `src/http/routes/learnings.ts`, `src/http/routes/tasks.ts`.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/v1/memories` | Save a memory |
| GET | `/api/v1/memories/:key` | Get memory by key (query params: namespace, projectId) |
| GET | `/api/v1/memories` | List memories (query params: namespace, projectId, agent, limit) |
| PUT | `/api/v1/memories/:key` | Update a memory |
| DELETE | `/api/v1/memories/:key` | Delete a memory |
| POST | `/api/v1/decisions` | Save a decision |
| GET | `/api/v1/decisions` | List decisions (query: projectId, status, type, limit) |
| GET | `/api/v1/decisions/:id` | Get decision by ID |
| PUT | `/api/v1/decisions/:id/supersede` | Supersede a decision |
| POST | `/api/v1/learnings` | Save a learning |
| GET | `/api/v1/learnings/search` | Search learnings (query: q, domain, limit) |
| GET | `/api/v1/learnings/:id` | Get learning by ID |
| PUT | `/api/v1/learnings/:id/verify` | Verify a learning |
| POST | `/api/v1/tasks` | Create a task |
| GET | `/api/v1/tasks` | List tasks (query: projectId, status, owner, limit) |
| GET | `/api/v1/tasks/:id` | Get task by ID |
| PUT | `/api/v1/tasks/:id/status` | Update task status |

### 5.6 MCP Tools Added (Phase 1)

| Tool Name | Description |
|-----------|-------------|
| `memory_save` | Save a memory to the materialized memories table |
| `memory_get` | Direct key lookup (fast, no event replay) |
| `memory_list` | List memories by namespace/project/agent |
| `memory_delete` | Delete a memory by key |
| `decision_save` | Save a structured decision with rationale |
| `decision_list` | List decisions for a project |
| `decision_get` | Get a specific decision |
| `decision_supersede` | Mark a decision as superseded |
| `learning_save` | Save a behavioral learning |
| `learning_search` | FTS5 search across learnings |
| `learning_verify` | Mark a learning as verified |
| `task_save` | Create or update a task |
| `task_list` | List tasks by project/status/owner |
| `task_update_status` | Transition task status |

### 5.7 Migration Scripts

**`scripts/migrate-decisions.ts`**:
```
Usage: bun run scripts/migrate-decisions.ts --source <path> --db <ping-mem.db> [--dry-run]
- Reads JSONL line by line
- Maps fields: timestamp -> created_at, decision -> title, type -> type, rationale -> rationale
- Generates UUIDv7 for decision_id
- Wraps entire import in SQLite transaction
- --dry-run reports count and sample without writing
```

**`scripts/migrate-learnings.ts`**:
```
Usage: bun run scripts/migrate-learnings.ts --source <dir> --db <ping-mem.db> [--dry-run]
- Reads each domain/*.json file
- Extracts individual learnings from JSON arrays
- Maps: domain from filename, confidence from source data or default 0.5
- Handles v2/injections.jsonl and v2/outcomes.jsonl separately
```

**`scripts/migrate-tasks.ts`**:
```
Usage: bun run scripts/migrate-tasks.ts --source <dir> --db <ping-mem.db> [--dry-run]
- Walks ~/.claude/tasks/<uuid>/ directories
- Parses JSON files for task title, status
- Marks all historical tasks as 'completed' or 'unknown'
- Preserves original timestamps
```

**`scripts/migrate-memories.ts`**:
```
Usage: bun run scripts/migrate-memories.ts --db <ping-mem.db> [--dry-run]
- Scans events table for MEMORY_SAVED/UPDATED/DELETED events
- Replays in timestamp order to build final state
- INSERTs resulting state into memories table
- Reports: total events processed, final memory count, conflicts resolved
```

### 5.8 Verification Checklist (Phase 1)

| # | Check | Method | PASS/FAIL |
|---|-------|--------|-----------|
| 1 | `memories` table created with correct schema | `sqlite3 ping-mem.db ".schema memories"` | |
| 2 | `decisions` table created with correct schema | `sqlite3 ping-mem.db ".schema decisions"` | |
| 3 | `learnings` table + FTS5 created | `sqlite3 ping-mem.db ".schema learnings"` + `.schema learnings_fts` | |
| 4 | `tasks` table created | `sqlite3 ping-mem.db ".schema tasks"` | |
| 5 | `agent_profiles` table created | `sqlite3 ping-mem.db ".schema agent_profiles"` | |
| 6 | `agent_corrections` table created | `sqlite3 ping-mem.db ".schema agent_corrections"` | |
| 7 | admin.db tables merged into main DB | `sqlite3 ping-mem.db "SELECT COUNT(*) FROM admin_api_keys"` | |
| 8 | decisions.jsonl migrated (count matches) | `wc -l decisions.jsonl` == `SELECT COUNT(*) FROM decisions` | |
| 9 | learnings migrated (count matches) | Count files == `SELECT COUNT(*) FROM learnings` | |
| 10 | Memory event replay produces correct count | `SELECT COUNT(*) FROM memories` > 0 | |
| 11 | Qdrant vectors have namespace payload | `curl Qdrant scroll` -> all points have namespace field | |
| 12 | Dual-write saves to both DB and file | Save decision via MCP -> check both table and JSONL | |
| 13 | `bun run typecheck` passes with 0 errors | `bun run typecheck` | |
| 14 | `bun test` passes with 0 failures | `bun test` | |
| 15 | REST endpoints return correct data | `curl` each new endpoint | |
| 16 | MCP tools discoverable via `tools/list` | Connect MCP client -> verify new tools listed | |

---

## 6. Phase 2: Context Engineering

**Goal**: Make retrieval token-budget-aware with temporal decay, position-aware ordering, and enhanced compression.

**Effort**: 2-3 weeks
**Prerequisites**: Phase 1 (`memories` table with `access_count`, `last_accessed_at`, `compression_tier`)

### 6.1 New Files to Create

| File | Purpose | Est. Lines |
|------|---------|------------|
| `src/search/ContextRetriever.ts` | Token-budget-aware retrieval with budget allocation | ~350 |
| `src/search/TemporalDecay.ts` | Attention-based decay model with configurable parameters | ~150 |
| `src/search/TokenCounter.ts` | Token counting using js-tiktoken | ~80 |
| `src/memory/CompressionAuditLog.ts` | Compression audit trail SQLite table + CRUD | ~150 |
| `src/search/__tests__/ContextRetriever.test.ts` | Tests for token-budget retrieval | ~250 |
| `src/search/__tests__/TemporalDecay.test.ts` | Tests for decay model | ~150 |
| `src/memory/__tests__/CompressionAuditLog.test.ts` | Tests for audit log | ~100 |
| `src/mcp/handlers/ContextRetrieveToolModule.ts` | MCP tool for context_retrieve | ~150 |

### 6.2 Files to Modify

| File | Change |
|------|--------|
| `src/search/HybridSearchEngine.ts` (1156 lines) | Add temporal decay re-ranking after fusion; read decay params from system_config |
| `src/memory/SemanticCompressor.ts` (260 lines) | Add Digest->Essence tier; integrate CompressionAuditLog |
| `src/storage/MemoryStore.ts` | Add `incrementAccess()` calls on read path |
| `src/mcp/PingMemServer.ts` | Register ContextRetrieveToolModule |
| `src/http/rest-server.ts` | Add `/api/v1/context/retrieve` endpoint |

### 6.3 Database Schema

```sql
-- Compression audit log
CREATE TABLE IF NOT EXISTS compression_audit_log (
  audit_id        TEXT PRIMARY KEY,           -- UUIDv7
  memory_id       TEXT NOT NULL,
  from_tier       INTEGER NOT NULL,           -- 0=raw, 1=digest
  to_tier         INTEGER NOT NULL,           -- 1=digest, 2=essence
  facts_before    INTEGER NOT NULL,
  facts_preserved INTEGER NOT NULL,
  facts_discarded INTEGER NOT NULL,
  anchor_facts    TEXT DEFAULT '[]',           -- JSON array of preserved anchor facts
  discarded_facts TEXT DEFAULT '[]',           -- JSON array of discarded facts
  compressor_mode TEXT NOT NULL,              -- 'heuristic' or 'llm'
  compressed_at   TEXT NOT NULL
);

CREATE INDEX idx_compression_memory ON compression_audit_log(memory_id);
```

### 6.4 Function Signatures

```typescript
// src/search/ContextRetriever.ts
export class ContextRetriever {
  constructor(deps: {
    hybridSearch: HybridSearchEngine;
    memoryStore: MemoryStore;
    decisionStore: DecisionStore;
    learningStore: LearningStore;
    tokenCounter: TokenCounter;
    temporalDecay: TemporalDecay;
  });
  async retrieve(params: {
    query: string;
    tokenBudget: number;
    scopes?: { namespace?: string; projectId?: string; crossProject?: boolean };
    includeDecisions?: boolean;
    includeLearnings?: boolean;
  }): Promise<ContextRetrievalResult>;
}

export interface ContextRetrievalResult {
  results: RankedContextItem[];
  budgetUsed: number;
  budgetRemaining: number;
  searchLatencyMs: number;
  sourceCounts: { memories: number; decisions: number; learnings: number; code: number };
}

// src/search/TemporalDecay.ts
export class TemporalDecay {
  constructor(params?: { lambda?: number; alpha?: number; sourceWeights?: Record<string, number> });
  computeRelevance(item: {
    baseScore: number;
    createdAt: string;
    accessCount: number;
    category?: string;
  }): number;
  static readonly DECAY_FLOORS: Record<string, number>;
}

// src/search/TokenCounter.ts
export class TokenCounter {
  constructor(encoding?: string);
  count(text: string): number;
  fitsInBudget(items: string[], budget: number): { fitted: string[]; tokensUsed: number };
}
```

### 6.5 Temporal Decay Parameters (Initial)

Stored in `system_config` table, tunable by self-improvement loop:

| Parameter | Key | Initial Value | Description |
|-----------|-----|---------------|-------------|
| Lambda | `decay.lambda` | 0.005 | Exponential decay rate (~139h half-life) |
| Alpha | `decay.alpha` | 0.1 | Access-count boost factor |
| Architecture weight | `decay.weight.architecture` | 2.0 | Source quality weight |
| Decision weight | `decay.weight.decision` | 1.5 | |
| Fact weight | `decay.weight.fact` | 1.0 | |
| Observation weight | `decay.weight.observation` | 0.7 | |
| Debugging weight | `decay.weight.debugging` | 0.5 | |
| Decay floor (architecture) | `decay.floor.architecture` | 0.5 | |
| Decay floor (contract) | `decay.floor.contract` | 0.5 | |
| Decay floor (breaking_change) | `decay.floor.breaking_change` | 0.5 | |

### 6.6 MCP Tools Added (Phase 2)

| Tool | Description |
|------|-------------|
| `context_retrieve` | Token-budget-aware retrieval with priority ordering and position-aware placement |

### 6.7 REST Endpoints Added (Phase 2)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/v1/context/retrieve` | Token-budget-aware retrieval (body: `{query, tokenBudget, scopes}`) |

### 6.8 Verification Checklist (Phase 2)

| # | Check | Method | PASS/FAIL |
|---|-------|--------|-----------|
| 1 | `context_retrieve` returns results within budget | Call with budget=1000, verify tokensUsed <= 1000 | |
| 2 | Temporal decay reduces score of old memories | Compare same query with old vs new memory | |
| 3 | Access count increments on read | Read memory, verify access_count++ | |
| 4 | Digest->Essence compression produces smaller output | Compress, compare sizes | |
| 5 | Compression audit log records preserved/discarded | Check compression_audit_log after compress | |
| 6 | Position-aware ordering places high relevance at edges | Verify first and last results have highest scores | |
| 7 | `bun run typecheck && bun test` passes | Quality gate | |

---

## 7. Phase 3: ~~Agent Identity and~~ Causal Memory

> **AMENDED (Review iteration 1)**: Agent profiles, agent corrections, and StalenessDetector cut from this phase. See Section 19.2 for rationale. ContradictionDetector already exists at `src/graph/ContradictionDetector.ts` — this phase integrates it into the write path.

**Goal**: ~~Give agents persistent identity and~~ Enable causal reasoning over memory chains and integrate contradiction detection into write path.

**Effort**: 1 week (reduced from 2 weeks)
**Prerequisites**: Phase 1 (memories, decisions tables), Phase 2 (temporal decay)

### 7.1 New Files to Create

| File | Purpose | Est. Lines |
|------|---------|------------|
| `src/mcp/handlers/CausalMemoryToolModule.ts` | MCP tools for causal chain queries | ~150 |

**Files that already exist** (integrate, do not recreate):
- `src/graph/ContradictionDetector.ts` (existing, verified)
- `src/graph/__tests__/ContradictionDetector.test.ts` (existing, verified)

### 7.2 Files to Modify

| File | Change |
|------|--------|
| `src/graph/CausalGraphManager.ts` | Add `(Decision)-[:CAUSED_BY]->(Evidence)` edge creation via existing `addCausalLink()` |
| `src/memory/MemoryManager.ts` | Integrate existing ContradictionDetector on write path |
| `src/mcp/PingMemServer.ts` | Register CausalMemoryToolModule |
| `src/http/routes/causal.ts` | Add causal query endpoints (route file already exists with 4 endpoints) |

### 7.3 Function Signatures

```typescript
// src/memory/ContradictionDetector.ts
export class ContradictionDetector {
  constructor(deps: { memoryStore: MemoryStore; decisionStore: DecisionStore });
  detect(newMemory: { key: string; value: string; category?: string; projectId?: string }): ContradictionResult;
}

export interface ContradictionResult {
  hasContradiction: boolean;
  contradictingMemories: Array<{ memoryId: string; key: string; value: string; createdAt: string }>;
  resolution: 'newer_wins' | 'flagged_for_review' | 'no_conflict';
}

// src/memory/StalenessDetector.ts
export class StalenessDetector {
  constructor(deps: { neo4jClient: Neo4jClient });
  detectStale(changedMemoryId: string): StaleMemoryResult[];
  flagDependents(sourceId: string): number; // Returns count of flagged memories
}

// Neo4j causal edge creation
// In CausalGraphManager — uses EXISTING method names (verified from source):
//   addCausalLink() — NOT createCausalEdge()
//   getCausalChain() — NOT traverseCausalChain()
export async function addCausalLink(params: {
  sourceId: string;
  targetId: string;
  relationship: string;
  evidenceType: 'memory' | 'commit' | 'decision' | 'learning';
}): Promise<void>;

export async function getCausalChain(
  startId: string,
  maxDepth?: number
): Promise<CausalChainNode[]>;
```

### 7.4 MCP Tools Added (Phase 3)

| Tool | Description |
|------|-------------|
| `memory_explain_why` | Traverse causal graph via `getCausalChain()` to explain a decision or memory |
| `memory_check_contradictions` | Check if a memory contradicts existing records (uses existing ContradictionDetector) |

> **Cut tools** (see Section 19.2): `agent_profile_get`, `agent_profile_update`, `agent_correction_record`, `memory_detect_stale`

### 7.5 Verification Checklist (Phase 3)

| # | Check | Method | PASS/FAIL |
|---|-------|--------|-----------|
| 1 | Contradiction detected for conflicting memories | Save "use Postgres", then "use MongoDB" -> flagged | |
| 2 | Causal chain traversal returns ordered chain | Create decision -> evidence chain via `addCausalLink()`, query via `getCausalChain()`, verify order | |
| 3 | `memory_explain_why` MCP tool returns causal chain | Call tool with decision ID, verify chain returned | |
| 4 | `bun run typecheck && bun test` passes | Quality gate | |

---

## 8. Phase ~~4~~ 3: Eval Baseline ~~and Self-Improvement~~

> **AMENDED (Review iteration 1)**: Renumbered to Phase 3 in revised structure. Self-improvement hardening deferred (see Section 10). Metrics reduced from 20 to 15+ (cut metrics for removed features).

**Goal**: Establish baseline measurements across 15+ metrics; enable automated regression detection.

**Effort**: 1-2 weeks (reduced from 2 weeks)
**Prerequisites**: Phase 2 (token-budget retrieval, temporal decay)

### 8.1 New Files to Create

| File | Purpose | Est. Lines |
|------|---------|------------|
| `src/eval/baseline.ts` | Baseline recording and comparison | ~200 |
| `src/eval/session-resume-score.ts` | Session Resume Score eval | ~250 |
| `src/eval/contradiction-eval.ts` | Contradiction detection accuracy eval | ~150 |
| `src/eval/compression-fidelity.ts` | Compression fidelity measurement | ~150 |
| `src/eval/longitudinal-tracker.ts` | Store and track eval scores over time | ~200 |
| `src/eval/canary.ts` | Canary evaluation (5% of eval set) | ~100 |
| `src/eval/datasets/frozen-v1.json` | Frozen eval dataset (50+ query-answer pairs) | ~500 |
| `src/eval/__tests__/baseline.test.ts` | Tests for baseline | ~100 |
| `src/eval/__tests__/session-resume-score.test.ts` | Tests for SRS | ~150 |
| `src/eval/__tests__/longitudinal-tracker.test.ts` | Tests for tracker | ~100 |

### 8.2 Database Schema

```sql
-- Eval scores longitudinal tracking
CREATE TABLE IF NOT EXISTS eval_scores (
  score_id      TEXT PRIMARY KEY,             -- UUIDv7
  eval_run_id   TEXT NOT NULL,                -- Groups metrics from same run
  metric_name   TEXT NOT NULL,                -- e.g., 'recall_at_10', 'srs', 'contradiction_accuracy'
  metric_value  REAL NOT NULL,
  layer         INTEGER NOT NULL,             -- 1-5 (eval layer)
  dataset_hash  TEXT NOT NULL,                -- SHA-256 of frozen dataset version
  config_hash   TEXT NOT NULL,                -- SHA-256 of system_config at eval time
  recorded_at   TEXT NOT NULL
);

CREATE INDEX idx_eval_metric ON eval_scores(metric_name, recorded_at DESC);
CREATE INDEX idx_eval_run ON eval_scores(eval_run_id);
```

### 8.3 Eval Metrics (20 Total)

| # | Metric | Layer | Status | Implementation |
|---|--------|-------|--------|----------------|
| 1 | Precision@10 | 1 | New | `src/eval/metrics.ts` (add) |
| 2 | Recall@10 | 1 | Exists | `src/eval/metrics.ts` |
| 3 | MRR@10 | 1 | Exists | `src/eval/metrics.ts` |
| 4 | NDCG@10 | 1 | Exists | `src/eval/metrics.ts` |
| 5 | MAP@10 | 1 | New | `src/eval/metrics.ts` (add) |
| 6 | Tokens per Useful Fact | 4 | New | `src/eval/metrics.ts` (add) |
| 7 | Search Latency p50 | 4 | New | Instrumented in HybridSearchEngine |
| 8 | Search Latency p95 | 4 | New | Instrumented in HybridSearchEngine |
| 9 | Session Resume Score | 3 | New | `src/eval/session-resume-score.ts` |
| 10 | Contradiction Detection Accuracy | 2 | New | `src/eval/contradiction-eval.ts` |
| 11 | Compression Fidelity | 2 | New | `src/eval/compression-fidelity.ts` |
| 12 | Self-Improvement Delta | 5 | New | `src/eval/longitudinal-tracker.ts` |
| 13 | Client Coverage | 5 | Manual | Count of verified client configs |
| 14 | Database Count | 4 | Manual | Verify 2 DBs |
| 15 | Memory Completeness | 2 | New | Audit script: diff file stores vs tables |
| 16 | Cross-Project Precision | 5 | New | Eval with cross-project queries |
| 17 | Temporal Accuracy | 2 | New | Point-in-time query eval |
| 18 | Learning Propagation Latency | 5 | New | Cross-project learning timing |
| 19 | Causal Chain Completeness | 3 | New | "Why" query eval |
| 20 | Isolation Violation Rate | 5 | New | Cross-project leak detection |

### 8.4 Baseline Establishment Script

```
Usage: bun run src/eval/baseline.ts --dataset src/eval/datasets/frozen-v1.json --output baseline-v1.json

Steps:
1. Load frozen eval dataset
2. Run each query against current system
3. Compute all 20 metrics
4. Store results in eval_scores table
5. Output summary JSON with all metric values
```

### 8.5 Verification Checklist (Phase 4)

| # | Check | Method | PASS/FAIL |
|---|-------|--------|-----------|
| 1 | Frozen eval dataset has 50+ queries | `jq length frozen-v1.json` | |
| 2 | All 20 metrics compute without error | Run baseline script | |
| 3 | Baseline scores stored in eval_scores table | `SELECT DISTINCT metric_name FROM eval_scores` -> 20 rows | |
| 4 | Longitudinal tracker detects regression | Inject lower score, verify alert | |
| 5 | Canary eval aborts on score drop | Inject bad config, verify canary stops | |
| 6 | SRS eval completes end-to-end | Run SRS eval, verify score in [0, 1] | |
| 7 | `bun run typecheck && bun test` passes | Quality gate | |

---

## 9. ~~Phase 5: Multi-Client Rollout and Cross-Project~~ Phase 4: Documentation

> **AMENDED (Review iteration 1)**: CLI config generator replaced with static docs. CrossProjectLinker cut. See Section 19.2 S4, S7.

**Goal**: Provide static config templates for all major AI IDEs.

**Effort**: 1 day
**Prerequisites**: None (can be done in parallel with any phase)

### 9.1 New Files to Create

> **AMENDED**: CLI generator (`config-generate.ts`) replaced with static docs. CrossProjectLinker cut.

| File | Purpose | Est. Lines |
|------|---------|------------|
| `docs/client-configs/README.md` | Overview and instructions | ~50 |
| `docs/client-configs/claude-code.json` | Template for Claude Code | ~20 |
| `docs/client-configs/cursor.json` | Template for Cursor | ~20 |
| `docs/client-configs/codex.toml` | Template for Codex CLI | ~15 |
| `docs/client-configs/vscode-copilot.json` | Template for VS Code Copilot | ~20 |
| `docs/client-configs/continue.yaml` | Template for Continue | ~20 |
| `docs/client-configs/cline.json` | Template for Cline | ~20 |
| `docs/client-configs/windsurf.json` | Template for Windsurf | ~20 |
| `docs/client-configs/opencode.json` | Template for OpenCode | ~20 |

### 9.2 Client Config Details

**Claude Code** (`~/.claude/mcp.json`):
```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "{{PING_MEM_DIST}}/mcp/cli.js"],
      "env": {
        "PING_MEM_DB_PATH": "{{DB_PATH}}",
        "NEO4J_URI": "{{NEO4J_URI}}",
        "NEO4J_USERNAME": "{{NEO4J_USERNAME}}",
        "NEO4J_PASSWORD": "{{NEO4J_PASSWORD}}",
        "QDRANT_URL": "{{QDRANT_URL}}"
      }
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "${userHome}/Projects/ping-mem/dist/mcp/cli.js"],
      "env": {
        "PING_MEM_DB_PATH": "${userHome}/.ping-mem/ping-mem.db"
      }
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`):
```toml
[mcp_servers.ping-mem]
command = "bun"
args = ["run", "{{PING_MEM_DIST}}/mcp/cli.js"]
env = { PING_MEM_DB_PATH = "{{DB_PATH}}" }
```

**VS Code Copilot** (`.vscode/mcp.json`):
```json
{
  "servers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "{{PING_MEM_DIST}}/mcp/cli.js"]
    }
  }
}
```

**Continue** (`.continue/mcpServers/ping-mem.yaml`):
```yaml
name: ping-mem
version: 0.0.1
schema: v1
mcpServers:
  - name: ping-mem
    command: bun
    args:
      - run
      - "{{PING_MEM_DIST}}/mcp/cli.js"
    env:
      PING_MEM_DB_PATH: "{{DB_PATH}}"
```

**Cline** (`cline_mcp_settings.json`):
```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "{{PING_MEM_DIST}}/mcp/cli.js"],
      "env": {
        "PING_MEM_DB_PATH": "{{DB_PATH}}"
      }
    }
  }
}
```

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`):
```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "{{PING_MEM_DIST}}/mcp/cli.js"],
      "env": {
        "PING_MEM_DB_PATH": "{{DB_PATH}}"
      }
    }
  }
}
```

**OpenCode** (`opencode.json`):
```json
{
  "mcp": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "{{PING_MEM_DIST}}/mcp/cli.js"],
      "env": {
        "PING_MEM_DB_PATH": "{{DB_PATH}}"
      }
    }
  }
}
```

### 9.3 Database Schema (Phase 5)

**Note**: `project_access_rules` table moved to Phase 1 (Section 5.1) per Security EVAL finding. Cross-project isolation is enforced from day one.

### 9.4 ~~CLI Commands Added~~ Static Config Templates

> **AMENDED**: CLI generator cut (S4). Users copy templates from `docs/client-configs/` and fill in placeholder values manually. This avoids adding `yaml` and `@iarna/toml` dependencies for a feature with no proven demand.

Placeholder variables in templates: `{{PING_MEM_DIST}}`, `{{DB_PATH}}`, `{{NEO4J_URI}}`, `{{NEO4J_USERNAME}}`, `{{NEO4J_PASSWORD}}`, `{{QDRANT_URL}}`.

### 9.5 Verification Checklist (Phase 4 — Documentation)

| # | Check | Method | PASS/FAIL |
|---|-------|--------|-----------|
| 1 | Claude Code template is valid JSON | `jq . docs/client-configs/claude-code.json` | |
| 2 | All 8 template files exist | `ls docs/client-configs/` | |
| 3 | Windsurf config uses `serverUrl` (not `url`) | Visual inspection | |
| 4 | VS Code Copilot config uses `servers` (not `mcpServers`) | Visual inspection | |
| 5 | All placeholder variables documented in README | Check README lists all `{{...}}` vars | |

---

## 10. ~~Phase 6: Self-Improvement Loop Production Hardening~~ DEFERRED

> **AMENDED (Review iteration 1)**: Entire phase deferred. Premature without months of eval data. Existing `src/eval/improvement-loop.ts` suffices for now. See Section 19.2 S3. Reintroduce when 3+ months of eval data shows the existing loop is insufficient.

**Goal**: ~~Automate the full improvement cycle with production safeguards.~~

**Effort**: ~~1 week~~ Deferred
**Prerequisites**: ~~Phase 4 (eval suite, longitudinal tracking)~~ 3+ months of eval data

### 10.1 Files to Modify

| File | Change |
|------|--------|
| `src/eval/improvement-loop.ts` | Add canary evaluation, statistical significance test, mutation strategies, longitudinal recording |
| `scripts/nightly-improvement.sh` | Add canary gate, human review threshold, rollback on regression |
| `docker-compose.improvement.yml` | Add eval_scores volume mount |

### 10.2 New Files to Create

| File | Purpose | Est. Lines |
|------|---------|------------|
| `src/eval/mutation-strategies.ts` | Parameter mutation strategies for self-improvement | ~200 |
| `src/eval/statistical-test.ts` | Paired t-test for eval comparison | ~100 |
| `src/eval/__tests__/mutation-strategies.test.ts` | Tests | ~150 |
| `src/eval/__tests__/statistical-test.test.ts` | Tests | ~100 |

### 10.3 Mutation Strategies

```typescript
// src/eval/mutation-strategies.ts
export interface MutationStrategy {
  name: string;
  apply(currentConfig: SystemConfig): SystemConfig;
  describe(): string;
}

export const STRATEGIES: MutationStrategy[] = [
  // Retrieval weight mutations
  { name: 'bm25_weight_up', apply: (c) => ({ ...c, 'search.bm25_weight': c['search.bm25_weight'] * 1.1 }) },
  { name: 'bm25_weight_down', apply: (c) => ({ ...c, 'search.bm25_weight': c['search.bm25_weight'] * 0.9 }) },
  { name: 'vector_weight_up', apply: (c) => ({ ...c, 'search.vector_weight': c['search.vector_weight'] * 1.1 }) },
  { name: 'vector_weight_down', apply: (c) => ({ ...c, 'search.vector_weight': c['search.vector_weight'] * 0.9 }) },
  // Decay parameter mutations
  { name: 'decay_lambda_up', apply: (c) => ({ ...c, 'decay.lambda': c['decay.lambda'] * 1.2 }) },
  { name: 'decay_lambda_down', apply: (c) => ({ ...c, 'decay.lambda': c['decay.lambda'] * 0.8 }) },
  { name: 'decay_alpha_up', apply: (c) => ({ ...c, 'decay.alpha': c['decay.alpha'] * 1.2 }) },
  // Compression threshold mutations
  { name: 'compress_threshold_up', apply: (c) => ({ ...c, 'compress.threshold': c['compress.threshold'] + 100 }) },
  { name: 'compress_threshold_down', apply: (c) => ({ ...c, 'compress.threshold': c['compress.threshold'] - 100 }) },
];
```

### 10.4 Nightly Improvement Flow

```
1. [22:00] Cron fires
2. Load current system_config (Blue)
3. Run full eval suite against Blue -> baseline scores
4. Select random mutation strategy
5. Apply mutation -> candidate config (Green)
6. Run canary eval (5% of eval set) against Green
   - If canary drops >5%: ABORT, discard Green
7. Run full eval suite against Green -> candidate scores
8. Paired t-test: is Green significantly better? (p < 0.05)
   - If yes AND delta < 20% from baseline: PROMOTE automatically
   - If yes AND delta >= 20%: FLAG for human review
   - If no: DISCARD Green
9. Record all scores in eval_scores table
10. Check for regression: any metric >2 std dev below trailing 4-week mean?
    - If yes: ROLLBACK to last known good config, ALERT
11. [~22:30] Complete
```

### 10.5 Verification Checklist (Phase 6)

| # | Check | Method | PASS/FAIL |
|---|-------|--------|-----------|
| 1 | Nightly cron runs end-to-end | Trigger manually, verify completion | |
| 2 | Canary evaluation aborts on score drop | Inject bad mutation, verify abort | |
| 3 | Statistical test correctly identifies improvement | Inject known-better config, verify promotion | |
| 4 | Human review gate triggers for large changes | Apply >20% mutation, verify flag | |
| 5 | Regression detection fires alert | Inject regression, verify alert | |
| 6 | Longitudinal dashboard shows trend | Visit `/ui/eval`, verify chart | |
| 7 | `bun run typecheck && bun test` passes | Quality gate | |

---

## 11. Deprecation Timeline

### Month 1-3: Dual-Write Mode

| Week | Action | Verification |
|------|--------|-------------|
| 1 | Deploy Phase 1 tables + migration scripts. Run all migrations. Enable dual-write middleware. | All migration counts match source |
| 2 | Verify 100% write parity via audit script. Fix sync gaps. | `scripts/audit-sync.ts` -> 0 diffs |
| 3-4 | Switch read path to ping-mem-first with file fallback. Log all file-fallback reads as telemetry events. | File-read telemetry events visible in `/ui/events` |
| 5-8 | Monitor file-fallback read count. Target: declining trend toward zero. | Dashboard metric shows decline |
| 9-12 | If file reads reach zero for 14+ consecutive days, mark files as deprecated. | Telemetry confirms zero |

### Month 3+: File Fallback Removal

**Gating criteria (ALL must be met)**:
1. Zero file-fallback reads logged for 30 consecutive days
2. ping-mem Precision@10 >= 0.75 (eval suite verified)
3. Memory Completeness = 100% (all file data exists in ping-mem)
4. User explicit approval

**Removal sequence** (lowest risk first):
1. `~/.claude/tasks/` -> `tasks` table reads (Claude Code internal, lowest risk)
2. `decisions.jsonl` -> `decisions` table reads (keep JSONL as read-only archive)
3. `~/.claude/learnings/` -> `learnings` table reads (keep files as read-only archive)
4. `~/.claude/memory/` -> `memories` table reads (highest frequency, remove last)

### GitHub Issues to Create

| Issue Title | Milestone | Labels | Create When |
|-------------|-----------|--------|-------------|
| `feat: Add memories table with materialized state` | Phase 1 | `consolidation`, `P0` | Day 1 |
| `feat: Add decisions table and migrate decisions.jsonl` | Phase 1 | `consolidation`, `P1` | Day 1 |
| `feat: Add learnings table with FTS5` | Phase 1 | `consolidation`, `P1` | Day 1 |
| `feat: Add tasks table and migrate task files` | Phase 1 | `consolidation`, `P1` | Day 1 |
| `feat: Merge admin.db into main ping-mem.db` | Phase 1 | `consolidation`, `P2` | Day 1 |
| `feat: Qdrant namespace separation` | Phase 1 | `consolidation`, `P2` | Day 1 |
| `feat: Dual-write middleware for file fallbacks` | Phase 1 | `consolidation`, `P0` | Day 1 |
| `feat: Token-budget-aware context_retrieve tool` | Phase 2 | `context-engineering`, `P0` | Week 3 |
| `feat: Temporal relevance decay in HybridSearchEngine` | Phase 2 | `context-engineering`, `P0` | Week 3 |
| `feat: Digest-to-Essence compression with audit trail` | Phase 2 | `context-engineering`, `P1` | Week 3 |
| `feat: Agent profiles and corrections tables` | Phase 3 | `agent-identity`, `P2` | Week 5 |
| `feat: Contradiction detection in memory write path` | Phase 3 | `agent-identity`, `P1` | Week 5 |
| `feat: Causal memory chains in Neo4j` | Phase 3 | `agent-identity`, `P2` | Week 5 |
| `feat: Frozen eval dataset and baseline recording` | Phase 4 | `eval`, `P1` | Week 7 |
| `feat: Longitudinal eval tracking with regression detection` | Phase 4 | `eval`, `P1` | Week 7 |
| `feat: Multi-client config templates and generate CLI` | Phase 5 | `multi-client`, `P1` | Week 9 |
| `feat: Cross-project entity linking and ACL` | Phase 5 | `cross-project`, `P2` | Week 9 |
| `chore: Deprecate task file reads (month 3+ gate)` | Deprecation | `deprecation` | Month 3 |
| `chore: Deprecate decisions.jsonl reads (month 3+ gate)` | Deprecation | `deprecation` | Month 3 |
| `chore: Deprecate learnings file reads (month 3+ gate)` | Deprecation | `deprecation` | Month 3 |
| `chore: Deprecate MEMORY.md reads (month 3+ gate)` | Deprecation | `deprecation` | Month 3 |

---

## 12. Integration Points

### 12.1 Claude Code (Primary Client)

| Integration Point | Current | After Consolidation |
|-------------------|---------|---------------------|
| Memory read | `~/.claude/memory/MEMORY.md` | `memory_get` / `context_retrieve` MCP tools -> ping-mem.db |
| Decision storage | `.ai/decisions.jsonl` | `decision_save` MCP tool -> ping-mem.db + JSONL fallback |
| Learning storage | `~/.claude/learnings/domains/*.json` | `learning_save` MCP tool -> ping-mem.db + file fallback |
| Task tracking | `~/.claude/tasks/*.json` | `task_save` MCP tool -> ping-mem.db |
| Session start | cc-memory skill reads files | cc-memory calls `context_session_start` -> loads profile + recent context |
| CLAUDE.md | Static file | Still static; ping-mem supplements with dynamic context |

### 12.2 Understory (Knowledge Management)

| Integration Point | Current | After Consolidation |
|-------------------|---------|---------------------|
| Knowledge base | `memory.sqlite` per project | `knowledge_search` via ping-mem MCP (existing) |
| Learnings | Not connected | `learning_search` via ping-mem MCP for shared learnings |
| Cross-project | Not connected | `crossProject: true` queries surface understory knowledge |

### 12.3 u-os (Agent Orchestrator)

| Integration Point | Current | After Consolidation |
|-------------------|---------|---------------------|
| Memory | `memory.db` per project | `memory_save` / `memory_get` via ping-mem MCP |
| Agent state | In-process | `agent_profile_get` on session start; `agent_correction_record` on user feedback |
| Task management | Internal | `task_save` / `task_list` via ping-mem MCP |

### 12.4 Other Clients (Cursor, Codex, etc.)

All clients connect via stdio MCP transport. They receive identical tool sets via `tools/list`. No client-specific logic in ping-mem server. Client-specific differences are config format only, handled by `ping-mem config generate`.

---

## 13. Risk Analysis

| Risk | Likelihood | Impact | Mitigation | Phase |
|------|-----------|--------|------------|-------|
| Migration script corrupts data | Low | High | Run all migrations in SQLite transactions; keep source files as backup; --dry-run mode | 1 |
| Multiple stdio processes cause WAL contention | Medium | Medium | SQLite WAL mode + busy_timeout(5000ms); document single-server mode for constrained environments | 1 |
| Temporal decay drops important old memories | Medium | High | Decay floor for critical categories; access-count boost; eval suite monitors regression | 2 |
| Contradiction detector false positives | Medium | Low | Start conservative (high similarity threshold); flag for review rather than auto-resolve | 3 |
| Token counter inaccuracy across models | Low | Low | Use tiktoken cl100k_base; 10% safety margin; accept optional tokenizer param | 2 |
| Frozen eval dataset unrepresentative | Medium | Medium | Semi-automated generation from real queries; human validation; quarterly review | 4 |
| Self-improvement promotes bad config | Low | High | Canary evaluation; human review gate for >20% changes; automatic rollback on regression | 6 |
| Client config formats change | Medium | Low | Version-pin examples; integration test per client; config generate CLI handles changes | 5 |
| Embedding provider unavailable | Medium | Medium | Tiered fallback (Ollama -> Gemini -> OpenAI); store without vector if all fail; queue for retry | 1-2 |
| Cross-project queries leak sensitive data | Low | High | ACL model (Phase 5); crossProject=false by default; isolation violation rate metric | 5 |

---

## 14. Dependencies

| Package | Version | Purpose | Phase |
|---------|---------|---------|-------|
| `bun:sqlite` | Built-in | SQLite database access | 1 |
| `@modelcontextprotocol/sdk` | ^1.x | MCP server implementation | 1 |
| `js-tiktoken` | ^1.x | Token counting for budget-aware retrieval | 2 |
| `uuidv7` | ^1.x | UUIDv7 generation for all new table primary keys | 1 |
| `lru-cache` | ^10.x | Embedding query cache (~8KB, zero deps) | 2 |
| `neo4j-driver` | ^5.x | Neo4j graph operations (existing) | 1 |
| `@qdrant/js-client-rest` | ^1.x | Qdrant vector operations (existing) | 1 |
| `zod` | ^3.x | Input validation (existing) | 1 |
| ~~`yaml`~~ | ~~^2.x~~ | ~~YAML generation for Continue config~~ | ~~Cut (S4)~~ |
| ~~`@iarna/toml`~~ | ~~^3.x~~ | ~~TOML generation for Codex config~~ | ~~Cut (S4)~~ |

---

## 15. Success Metrics

| # | Metric | Baseline | Target | Timeline |
|---|--------|----------|--------|----------|
| 1 | Retrieval Precision@10 | Not measured | >= 0.75 | Phase 4 (Week 8) |
| 2 | Retrieval Recall@10 | Implemented, no baseline | >= 0.80 | Phase 4 |
| 3 | MRR@10 | Implemented, no baseline | >= 0.70 | Phase 4 |
| 4 | NDCG@10 | Implemented, no baseline | >= 0.75 | Phase 4 |
| 5 | Tokens per Useful Fact | Not measured | <= 150 | Phase 4 |
| 6 | Search Latency p50 | Not measured | <= 100ms | Phase 2 |
| 7 | Search Latency p95 | Not measured | <= 500ms | Phase 2 |
| 8 | Session Resume Score | Not measured | >= 0.70 | Phase 4 |
| 9 | Contradiction Detection Accuracy | 0% | >= 0.80 | Phase 4 |
| 10 | Compression Fidelity | Not measured | >= 0.75 | Phase 4 |
| 11 | Self-Improvement Delta | No tracking | Positive trend over 4 weeks | Phase 6 |
| 12 | Client Coverage | 1 (Claude Code) | >= 6 of 8 IDEs | Phase 5 |
| 13 | Database Count | 3 | 2 | Phase 1 |
| 14 | Memory Completeness | Unknown | 100% | Phase 1 (Week 2) |
| 15 | Cross-Project Precision | Not measured | >= 0.65 | Phase 5 |
| 16 | Temporal Accuracy | Not measured | >= 0.80 | Phase 4 |
| 17 | Learning Propagation Latency | Not measured | <= 60s | Phase 5 |
| 18 | Causal Chain Completeness | Not measured | >= 0.60 | Phase 4 |
| 19 | Staleness Detection Recall | 0% | >= 0.70 | Phase 4 |
| 20 | Isolation Violation Rate | Not measured | 0% | Phase 5 |

---

## 16. Verification Checklist (Global)

Master checklist combining all phase verifications.

| # | Component | Verification | Phase | PASS/FAIL |
|---|-----------|-------------|-------|-----------|
| 1 | 6 new tables created in ping-mem.db | `.schema` check for each | 1 | |
| 2 | admin.db merged into main DB | Connection count = 2 (main + diagnostics) | 1 | |
| 3 | All 4 migration scripts run successfully | Counts match sources | 1 | |
| 4 | Qdrant namespace separation complete | All points have namespace payload | 1 | |
| 5 | Dual-write middleware active | Save via MCP -> verify both DB and file | 1 | |
| 6 | 14 new MCP tools registered | `tools/list` returns new tools | 1 | |
| 7 | 17 new REST endpoints respond | `curl` each endpoint | 1 | |
| 8 | Token-budget retrieval respects budget | Test with budget=1000 | 2 | |
| 9 | Temporal decay applied to search results | Old vs new memory score comparison | 2 | |
| 10 | Compression audit trail records operations | Check audit log after compress | 2 | |
| 11 | Agent profiles persist across sessions | Save, restart, load | 3 | |
| 12 | Contradiction detection flags conflicts | Insert conflicting pair, verify flag | 3 | |
| 13 | Causal chain traversal works | Create chain, query, verify order | 3 | |
| 14 | 20 eval metrics compute without error | Run baseline script | 4 | |
| 15 | Longitudinal tracking stores scores | Check eval_scores table | 4 | |
| 16 | Config generate works for 7 clients | Run for each, validate format | 5 | |
| 17 | Cross-project ACL blocks unauthorized | Set 'none', verify empty results | 5 | |
| 18 | Nightly improvement loop completes | Manual trigger, verify completion | 6 | |
| 19 | Canary evaluation aborts on regression | Inject bad config, verify abort | 6 | |
| 20 | `bun run typecheck` = 0 errors | Run after each phase | All | |
| 21 | `bun test` = 0 failures | Run after each phase | All | |
| 22 | `bun run lint` = 0 errors | Run after each phase | All | |
| 23 | File-fallback read count declining | Dashboard metric over 4 weeks | 1-3 | |
| 24 | Zero isolation violations in eval | Eval suite cross-project test | 5 | |
| 25 | Positive self-improvement trend | 4 consecutive weekly evals | 6 | |

---

## 17. Summary

**Total new files**: ~35 (stores, tools, migrations, tests, eval, validation, audit, types, static configs)
**Total modified files**: ~12 (core infrastructure)
**Total new tables**: 8 (memories, decisions, learnings, tasks, system_config, project_access_rules, compression_audit_log, eval_scores)
**Total new MCP tools**: ~14
**Total new REST endpoints**: ~18 (in route files, NOT rest-server.ts)
**Total new CLI commands**: 0 (replaced by static docs -- see Section 19.2 S4)
**Estimated total effort**: 7-8 weeks across 4 phases (revised down from 10-13 weeks; see Section 19.4)
**Key dependency**: Phase 1 is the foundation; Phases 2-3 depend on it; Phase 4 is independent

The plan builds on ping-mem's existing 47 MCP tools, ~83 REST endpoints (59 in rest-server.ts + 24 in route files), 16 CLI commands, eval suite, and infrastructure. No rewrites -- only extensions. File-based fallbacks stay for 3 months. Removal is gated on dashboard metrics and user approval.

> **Note**: See Section 19 for REVIEW & VERIFY amendments that reduced scope, fixed 10 factual bugs, and added architectural requirements.

---

## 18. EVAL Amendments (Iteration 1)

Amendments addressing all findings from Completeness EVAL (83/100), Security EVAL (52/100), and Performance EVAL (62/100). Each amendment references the original finding ID and severity.

### 18.1 CRITICAL Fixes (Applied Inline)

#### C1: NULL uniqueness in memories table (Completeness)

**Fixed inline in Section 5.1.** Replaced `UNIQUE(namespace, project_id, key)` with:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_unique_key
  ON memories(namespace, COALESCE(project_id, ''), key);
```

SQLite treats each NULL as distinct in UNIQUE constraints. COALESCE maps NULL to empty string for uniqueness comparison only. The column itself remains nullable.

#### C2: ContextRetriever.retrieve() must be async (Completeness)

**Fixed inline in Section 6.4.** Signature changed from `retrieve(...): ContextRetrievalResult` to `async retrieve(...): Promise<ContextRetrievalResult>`. The method calls HybridSearchEngine (which queries Qdrant/Neo4j) and MemoryStore (SQLite) -- both I/O-bound operations that must be awaited.

#### C3: Database connection threading (Completeness)

**New subsection below (18.2)** specifies that all new stores use `eventStore.getDatabase()`.

#### C4: MemoryManager delegation (Completeness)

**New subsection below (18.3)** specifies method-level delegation details.

#### C5: scripts/audit-sync.ts unspecified (Completeness)

**Fixed inline in Section 5.2.** Added `scripts/audit-sync.ts` (~200 lines) to new files table. Function signature specified in 18.4 below.

#### C6: CausalGraphManager integration bridge (Completeness)

**New subsection below (18.5)** specifies the SQLite-to-Neo4j bridge for decisions.

#### C7: No Zod validation on 17 new endpoints (Security)

**Fixed inline in Section 5.2.** Added `src/validation/consolidation-schemas.ts` (~300 lines) to new files table. Full schema specification in 18.6 below.

#### C8: Cross-project isolation deferred to Phase 5 (Security)

**Fixed inline.** `project_access_rules` table moved from Phase 5 (Section 9.3) to Phase 1 (Section 5.1). Cross-project queries are gated from day one.

#### C9: Migration atomicity (Security)

**New subsection below (18.7)** specifies the migration safety protocol.

#### C10: Query embedding LRU cache (Performance)

**New subsection below (18.8)** specifies the EmbeddingService LRU cache.

#### C11: SQLite busy_timeout enforcement (Performance)

**New subsection below (18.9)** specifies verification and enforcement of busy_timeout=5000.

### 18.2 Database Connection Architecture

All new stores (`MemoryStore`, `DecisionStore`, `LearningStore`, `TaskStore`, `AgentProfileStore`, `SystemConfigStore`) receive their `Database` instance from `EventStore.getDatabase()`, which is exposed at line ~940 of `src/storage/EventStore.ts`.

**Single connection rule**: There is exactly ONE `Database` instance per SQLite file. `EventStore` owns the connection lifecycle. New stores are consumers, not owners.

**Initialization order** (in `src/config/runtime.ts`):

```
1. EventStore creates/opens the database
   const eventStore = new EventStore(dbPath);
   eventStore.initialize(); // Creates tables, sets WAL mode, busy_timeout

2. Get the shared database handle
   const db = eventStore.getDatabase();

3. All new stores receive the shared handle
   const memoryStore = new MemoryStore(db);
   const decisionStore = new DecisionStore(db);
   const learningStore = new LearningStore(db);
   const taskStore = new TaskStore(db);
   const agentProfileStore = new AgentProfileStore(db);
   const systemConfigStore = new SystemConfigStore(db);

4. Each store's initialize() creates its own tables via the shared connection
   memoryStore.initialize();
   decisionStore.initialize();
   // ... etc
```

**WAL mode**: EventStore already enables WAL mode on initialization. All stores benefit from this automatically since they share the same connection.

### 18.3 MemoryManager Delegation Details

`src/memory/MemoryManager.ts` (1439 lines) currently performs CRUD by writing to EventStore and replaying events for reads. After consolidation, MemoryManager delegates to MemoryStore while maintaining backward compatibility.

**Method-level changes**:

| Method | Current Behavior | After Consolidation |
|--------|-----------------|---------------------|
| `save(key, value, opts)` | Writes CONTEXT_SAVED event to EventStore | Writes to `MemoryStore.save()` first, then EventStore event as audit log |
| `update(key, value)` | Writes CONTEXT_UPDATED event | Calls `MemoryStore.update()` first, then EventStore |
| `delete(key)` | Writes CONTEXT_DELETED event | Calls `MemoryStore.delete()` first, then EventStore |
| `get(key)` | Replays events to reconstruct | Direct `MemoryStore.get(key)` -- O(1) lookup, no replay |
| `search(query, filters)` | Full-text search on events.data JSON | `MemoryStore.search()` with proper FTS5 index |
| `getAll()` | Event replay | `MemoryStore.list()` -- direct table scan |

**Backward compatibility**: All existing callers of `MemoryManager.save()` continue to work unchanged. The internal implementation changes from event-replay to direct-table, but the public API is identical. EventStore events are still written (append-only audit trail), but reads no longer depend on replay.

### 18.4 audit-sync.ts Function Signatures

```
// scripts/audit-sync.ts

interface AuditSyncResult {
  source: string;          // e.g., 'decisions.jsonl', 'learnings/typescript.json'
  table: string;           // e.g., 'decisions', 'learnings'
  fileCount: number;       // Records in file source
  dbCount: number;         // Records in DB table
  missingInDb: string[];   // Keys/IDs present in file but not DB
  missingInFile: string[]; // Keys/IDs present in DB but not file
  contentDiffs: Array<{    // Records that exist in both but differ
    id: string;
    field: string;
    fileValue: string;
    dbValue: string;
  }>;
}

async function auditSync(dbPath: string): Promise<AuditSyncResult[]>;
// Compares: decisions.jsonl <-> decisions table
//           learnings/*.json <-> learnings table
//           MEMORY.md sections <-> memories table
//           tasks/*.json <-> tasks table
// Outputs summary to stdout; exits 0 if parity, 1 if diffs found
```

**Usage**: `bun run scripts/audit-sync.ts --db ~/.ping-mem/ping-mem.db [--fix] [--dry-run]`

The `--fix` flag writes missing records to DB (file wins for content diffs during dual-write phase).

### 18.5 CausalGraphManager Bridge: SQLite to Neo4j

The `decisions` table lives in SQLite. Causal relationships (`CAUSED_BY`, `LED_TO`) live in Neo4j. The bridge uses `decision_id` as the shared identifier.

**Edge creation pattern** (in `src/graph/CausalGraphManager.ts`):

When a decision is saved via DecisionStore:

1. `bridgeDecisionToGraph(decision)` -- Ensures an Entity node exists in Neo4j with `entityId = decision.decision_id`, type = 'decision', and the decision's title, projectId, createdAt.
2. If `superseded_by` is set, creates `(old)-[:SUPERSEDED_BY]->(new)` edge.
3. `addCausalLink({sourceId: decisionId, targetId: evidenceId, relationship, evidenceType})` -- Creates edges like `(Decision)-[:CAUSED_BY]->(Memory)` or `(Decision)-[:SUPPORTED_BY]->(Learning)`. **Note**: uses existing `addCausalLink()` method name, not `createCausalEdge()`.

**Function signatures** (aligned with existing CausalGraphManager API):

```
async function bridgeDecisionToGraph(decision: DecisionRecord): Promise<void>;

// Uses existing addCausalLink() method — verified at CausalGraphManager.ts line 107
async function addCausalLink(params: {
  sourceId: string,          // SQLite decision_id
  targetId: string,          // memory_id, commit SHA, or learning_id
  relationship: 'CAUSED_BY' | 'LED_TO' | 'SUPPORTED_BY',
  evidenceType: 'memory' | 'commit' | 'decision' | 'learning'
}): Promise<void>;

// Uses existing getCausalChain() method — verified at CausalGraphManager.ts line 216
async function getCausalChain(
  startId: string,
  maxDepth?: number
): Promise<CausalChainNode[]>;
```

**Consistency guarantee**: Neo4j edges are created after SQLite write succeeds. If Neo4j write fails, log the failure and queue for retry (eventual consistency). The SQLite record is the source of truth; Neo4j is the relationship index.

### 18.6 Validation Schemas for All New Endpoints

`src/validation/consolidation-schemas.ts` must define Zod schemas for every new POST/PUT endpoint. Every string field gets `.max()`, every enum gets `z.enum()`, every array gets `.max()`.

**Required schemas** (17 endpoints):

| Schema Name | Endpoint | Key Validations |
|-------------|----------|-----------------|
| `SaveMemorySchema` | POST `/api/v1/memories` | key: max 500, value: max 100K, category: enum, priority: enum |
| `UpdateMemorySchema` | PUT `/api/v1/memories/:key` | value: max 100K |
| `SaveDecisionSchema` | POST `/api/v1/decisions` | title: max 1K, type: enum, rationale: max 50K, tags: array max 30 |
| `SupersedeDecisionSchema` | PUT `/api/v1/decisions/:id/supersede` | newDecisionId: required |
| `SaveLearningSchema` | POST `/api/v1/learnings` | domain: max 100, source: enum, confidence: 0-1 |
| `SaveTaskSchema` | POST `/api/v1/tasks` | title: max 1K, status: enum, priority: enum, deps: array max 50 |
| `UpdateTaskStatusSchema` | PUT `/api/v1/tasks/:id/status` | status: enum |
| `UpsertAgentProfileSchema` | POST `/api/v1/agents/profile` | agentId: required, caps: array max 100 |
| `RecordCorrectionSchema` | POST `/api/v1/agents/corrections` | correctionType: enum, all actions: max 10K |
| `ContextRetrieveSchema` | POST `/api/v1/context/retrieve` | tokenBudget: 100-200K, query: max 5K |

**Enforcement**: Each REST endpoint handler must call `schema.parse(req.body)` before any business logic. Validation errors return HTTP 400 with Zod error details.

### 18.7 Migration Safety Protocol

Every migration script (`scripts/migrate-*.ts`) must follow this safety protocol:

**1. Backup before start**: Copy source file(s) to timestamped backup directory `~/.ping-mem/backups/{timestamp}/`.

**2. File-based locking**: Use `~/.ping-mem/.migration-lock` to prevent concurrent migrations. Lock includes PID and start time. Stale locks (>1 hour) are auto-removed.

**3. Single transaction with ROLLBACK**: All INSERT/UPDATE operations wrapped in `BEGIN IMMEDIATE` ... `COMMIT`. On any error, `ROLLBACK` and re-throw.

**4. Row count verification**: Before COMMIT, query `SELECT COUNT(*) FROM target_table` and compare against expected count. Mismatch triggers ROLLBACK.

**5. Post-migration checksum**: After COMMIT, compute checksum of source data and compare against DB query results. Mismatch triggers error exit (does not auto-fix -- requires manual review).

### 18.8 Query Embedding LRU Cache (Phase 2)

Without caching, every `context_retrieve` or `codebase_search` call re-embeds the query string (~50-200ms per embedding API call). The p50 100ms search latency target is unachievable without this.

**Specification** -- add to `src/search/EmbeddingService.ts`:

- LRU cache: 1000 entries max, ~6MB memory (1000 entries x 768 dims x 4 bytes/float + key overhead)
- Cache key: `text.trim().toLowerCase()` (normalized for hit rate)
- `embedQuery(text)` checks cache first, falls back to provider, caches result
- `getCacheStats()` returns size, maxSize, hitRate
- `clearCache()` for testing and memory pressure

**Dependency**: Add `lru-cache` package (^10.x, ~8KB, zero dependencies) to `package.json`.

**Integration**: `HybridSearchEngine`, `CodeIndexer`, and `ContextRetriever` all call `EmbeddingService.embedQuery()` instead of directly calling the embedding provider.

### 18.9 SQLite busy_timeout Verification and Enforcement

**CORRECTED (Verify iteration 1)**: The original C11 finding claimed `busy_timeout=0`. This was factually wrong. `EventStore.ts` line 216-219 already sets `busy_timeout` to 5000ms with proper validation (clamp to 60000 max, default 5000 if not configured). The code is correct as-is.

**Amended action for Phase 1**: Add a read-back verification test (not a code fix) to confirm the PRAGMA takes effect. This is a defense-in-depth measure, not a bug fix.

**Test**: Add to `src/storage/__tests__/EventStore.test.ts` a test that creates an EventStore, initializes it, queries `PRAGMA busy_timeout`, and asserts the result is 5000. This verifies the existing code works correctly under test conditions.

### 18.10 HIGH Fixes

#### H1: Missing type definitions (Completeness)

Add `src/types/consolidation.ts` to Phase 1 new files. Must define all 13+ types with proper union literal types for enums (not bare `string`):

`MemoryRecord`, `DecisionRecord`, `LearningRecord`, `TaskRecord`, `AgentProfileRecord`, `AgentCorrectionRecord`, `RankedContextItem`, `ContextRetrievalResult`, `ContradictionResult`, `StaleMemoryResult`, `SyncDiffResult`, `DecisionInput`, `LearningInput`, `MemoryInput`, `SystemConfig`.

#### H2: decisions FTS5 virtual table (Completeness)

**Fixed inline in Section 5.1 DDL.** Added `decisions_fts` virtual table with sync triggers for title, rationale, and tags columns.

#### H3: system_config seeding mechanism (Completeness)

`SystemConfigStore.initialize()` must seed default values for all 14 tunable parameters using `INSERT OR IGNORE` (does not overwrite user customizations). Defaults listed in Section 6.5.

#### H4: FileChangeWatcher specification (Completeness)

Add `src/integration/FileChangeWatcher.ts` (~200 lines) to Phase 1 files. Watches file-based stores during 3-month dual-write transition. Key methods: `watch(paths)`, `close()`, `syncFile(filePath)`. All ingested content validated through Zod schemas before DB write.

#### H5: Gate destructive endpoints behind admin auth (Security)

DELETE and supersede/verify PUT endpoints require admin authentication. Reuse existing `requireAdminAuth` middleware from `src/http/admin.ts`.

#### H6: DualWriteMiddleware failure modes (Security)

Explicit contract: SQLite failure = throw (caller error). File failure = log warning, return success. File writes are async fire-and-forget. Retry file locks 3x with 100ms backoff.

#### H7: Sanitize FTS5 queries (Security)

Both `LearningStore.search()` and `DecisionStore.search()` must strip FTS5 operators (`*`, `^`, `~`), boolean keywords (`AND`, `OR`, `NOT`, `NEAR`), and quotes before constructing FTS5 MATCH queries. Return empty array if sanitized query is empty.

#### H8: Track cumulative drift in self-improvement loop (Security)

Add `computeCumulativeDrift()` to `LongitudinalTracker`. Tracks normalized mean parameter distance from original baseline (not just single-step delta). Alert at 50% cumulative drift. Prevents gradual parameter drift.

#### H9: Async file writes in DualWriteMiddleware (Performance)

Covered in H6. File writes use fire-and-forget async pattern. SQLite write returns immediately.

#### H10: token_count column in memories table (Performance)

**Fixed inline in Section 5.1 DDL.** `token_count INTEGER` column caches tokenization result on write. Avoids re-tokenizing on every `context_retrieve` call.

#### H11: Probe embedding providers in parallel on startup (Performance)

`EmbeddingService.initialize()` must use `Promise.allSettled()` to probe all providers simultaneously. Reduces startup from ~3s to ~1s.

#### H12: Separate Qdrant collections for code vs memory (Performance)

Use `ping-mem-code` and `ping-mem-memory` collections instead of namespace-as-payload. Type-specific searches query only one collection (~50% search space reduction). Migration script creates second collection and moves vectors.

### 18.11 Summary of All Amendments

| # | Finding | Severity | Source | Fix Location |
|---|---------|----------|--------|-------------|
| C1 | NULL uniqueness in memories | CRITICAL | Completeness | Section 5.1 DDL (inline) |
| C2 | retrieve() must be async | CRITICAL | Completeness | Section 6.4 (inline) |
| C3 | Database connection threading | CRITICAL | Completeness | Section 18.2 |
| C4 | MemoryManager delegation | CRITICAL | Completeness | Section 18.3 |
| C5 | audit-sync.ts unspecified | CRITICAL | Completeness | Section 5.2 + 18.4 |
| C6 | CausalGraph bridge | CRITICAL | Completeness | Section 18.5 |
| C7 | No Zod validation | CRITICAL | Security | Section 5.2 + 18.6 |
| C8 | project_access_rules deferred | CRITICAL | Security | Section 5.1 (inline) |
| C9 | Migration atomicity | CRITICAL | Security | Section 18.7 |
| C10 | Query embedding LRU cache | CRITICAL | Performance | Section 18.8 |
| C11 | busy_timeout enforcement | CRITICAL | Performance | Section 18.9 |
| H1 | Missing type definitions | HIGH | Completeness | Section 18.10 H1 |
| H2 | decisions FTS5 table | HIGH | Completeness | Section 5.1 DDL (inline) |
| H3 | system_config seeding | HIGH | Completeness | Section 18.10 H3 |
| H4 | FileChangeWatcher spec | HIGH | Completeness | Section 18.10 H4 |
| H5 | Gate destructive endpoints | HIGH | Security | Section 18.10 H5 |
| H6 | DualWrite failure modes | HIGH | Security | Section 18.10 H6 |
| H7 | Sanitize FTS5 queries | HIGH | Security | Section 18.10 H7 |
| H8 | Cumulative drift tracking | HIGH | Security | Section 18.10 H8 |
| H9 | FileChangeWatcher validation | HIGH | Security | Section 18.10 H4 (Zod) |
| H10 | Async file writes | HIGH | Performance | Section 18.10 H9 |
| H11 | token_count column | HIGH | Performance | Section 5.1 DDL + 18.10 H10 |
| H12 | Parallel provider probing | HIGH | Performance | Section 18.10 H11 |
| H13 | Separate Qdrant collections | HIGH | Performance | Section 18.10 H12 |
| -- | CHECK constraints on enums | HIGH | Security | All DDL tables (inline) |

---

## 19. REVIEW & VERIFY Amendments (Iteration 1)

This section documents all findings from the strategic REVIEW and factual VERIFY passes, applied as the final amendment to this plan.

### 19.1 Verification Bug Fixes (10 total, 3 critical)

All factual claims checked against source code. 22 of 32 claims verified correct; 10 required fixes.

#### Critical Fixes (applied inline above)

| # | Bug | What Plan Said | What Code Says | Fix Applied |
|---|-----|---------------|----------------|-------------|
| V1 | busy_timeout is NOT 0 | Section 18.9 claimed `busy_timeout=0` and needed fixing from 0 to 5000 | `EventStore.ts` line 216-219: defaults to 5000ms with validation/clamping. Code is correct. | Rewrote Section 18.9 to "verify existing correct behavior" instead of "fix bug". No code change needed. |
| V2 | CausalGraphManager method names wrong | Section 7.3 and 18.5 used `createCausalEdge()` and `traverseCausalChain()` | `CausalGraphManager.ts` line 107: `addCausalLink()`, line 216: `getCausalChain()` | Fixed all method references in Section 7.3 and 18.5 to use actual method names |
| V3 | File line counts wrong | Section 5.3: QdrantClient.ts ~300, CodeIndexer.ts ~250, VectorIndex.ts ~200 | QdrantClient.ts = 723, CodeIndexer.ts = 478, VectorIndex.ts = 593 | Fixed line counts in Section 5.3 table |

#### Non-Critical Fixes (noted for accuracy)

| # | Bug | Correction |
|---|-----|-----------|
| V4 | handlers/index.ts is 18 lines, not ~30 | Fixed in Section 5.3 table |
| V5 | CLI already has 16 command files | `src/cli/commands/` contains 16 files (agent.ts, auth.ts, causal.ts, codebase.ts, config.ts, context.ts, daemon.ts, diagnostics.ts, graph.ts, knowledge.ts, memory.ts, server.ts, session.ts, shell-hook.ts, tools.ts, worklog.ts). Plan must acknowledge existing CLI infrastructure rather than treating it as greenfield. |
| V6 | REST endpoint count is ~83, not 35 | rest-server.ts has 59 endpoint registrations + 24 in src/http/routes/*.ts = ~83 total. Plan used outdated number. |

### 19.2 Scope Cuts (reduces 10-13 weeks to 7-8 weeks)

The REVIEW agent identified scope that has no consumer, is premature, or is speculative. All cuts are "deferred, not deleted" -- they can be added in a future plan when evidence justifies them.

| # | What Was Cut | Original Phase | Rationale |
|---|-------------|---------------|-----------|
| S1 | `agent_profiles` table and `AgentProfileStore` | Phase 3 | No consumer exists. No agent currently reads profiles on startup. Premature abstraction. |
| S2 | `agent_corrections` table and correction recording | Phase 3 | No consumer exists. LLM-based correction extraction is speculative. Manual recording has no adopter. |
| S3 | Phase 6 (Self-Improvement Loop Production Hardening) entirely | Phase 6 | Premature without months of eval data. Existing `src/eval/improvement-loop.ts` suffices. Deferred, not deleted. |
| S4 | Phase 5 CLI config generator (`config-generate.ts`) | Phase 5 | Replace with static documentation in `docs/client-configs/`. 8 static JSON/TOML/YAML files are simpler than a generator. Removes `yaml` and `@iarna/toml` dependencies. |
| S5 | `FileChangeWatcher` (Section 18.10 H4) | Phase 1 | Unreliable (FSEvents race conditions, inotify limits). Dual-write middleware handles the write path. External file mutations during transition are handled by audit-sync.ts, not real-time watching. |
| S6 | `StalenessDetector` (Section 7.1) | Phase 3 | Speculative. No evidence of real staleness propagation problem. Can be added if contradiction detection reveals a need. |
| S7 | `CrossProjectLinker` (Section 9.1) | Phase 5 | No consumer project currently queries cross-project entity links. Existing `crossProject: true` in search handles the actual need. |
| S8 | Separate Qdrant collections (Section 18.10 H12) | Phase 1 | Premature optimization. Namespace-as-payload filter is simpler and sufficient at current scale. Revisit when search latency exceeds p95 target. |

**Items explicitly kept despite review suggestion to cut:**
- `ContradictionDetector` -- already exists at `src/graph/ContradictionDetector.ts` with tests. Integration into write path is low-cost, high-value.
- `project_access_rules` -- correctly moved to Phase 1 by EVAL. Cross-project isolation is a security requirement.

### 19.3 Architectural Fixes

These are structural requirements for implementation, not scope changes.

#### A1: REST endpoints MUST go in route files

`rest-server.ts` is already 3498 lines with 59 endpoint registrations. All new endpoints from this plan MUST be added as route files in `src/http/routes/*.ts`, NOT in rest-server.ts.

**New route files to create:**
- `src/http/routes/memories.ts` -- CRUD for memories table
- `src/http/routes/decisions.ts` -- CRUD for decisions table
- `src/http/routes/learnings.ts` -- CRUD for learnings table
- `src/http/routes/tasks.ts` -- CRUD for tasks table
- `src/http/routes/context-retrieve.ts` -- token-budget retrieval endpoint

Register them in `src/http/routes/index.ts` following the existing pattern.

#### A2: Each Store owns its own schema migration

Do NOT add all DDL into `EventStore.initialize()`. Each new Store class (MemoryStore, DecisionStore, LearningStore, TaskStore, SystemConfigStore) must create its own tables in its own `initialize()` method. EventStore should not know about tables it does not own.

Add a lightweight migration runner that:
1. Calls `store.initialize()` on each store in dependency order
2. Records migration version in a `schema_versions` table
3. Supports idempotent re-runs (CREATE TABLE IF NOT EXISTS)

#### A3: Single-transaction guarantee for MemoryStore + EventStore writes

Both tables live in the same SQLite database (same `Database` handle). MemoryManager.save() must wrap the MemoryStore.save() + EventStore.appendEvent() in a single `BEGIN IMMEDIATE` ... `COMMIT` transaction. This prevents partial writes where the memory is saved but the audit event is lost (or vice versa).

#### A4: Tool count management

With 47+ existing tools and ~14 new ones planned, the tool count reaches 60+. Not all tools are relevant to every session.

**Recommendation**: Implement tool filtering in `PingMemServer.ts` based on session type. When `context_session_start` is called with a `projectDir`, surface codebase/diagnostics tools. When called without, surface only memory/decision/learning/task tools. Use the existing MCP `tools/list` response to filter dynamically.

#### A5: Explicit UUIDv7 strategy

Use the `uuidv7` npm package (^1.x, ~2KB). Do NOT implement a custom UUIDv7 generator. The package produces spec-compliant UUIDv7 with monotonic timestamps. Add to `package.json` dependencies.

#### A6: EventStore rename path

Plan states events.db renames to ping-mem.db. Implementation must check for existing `events.db` on startup and either:
- Rename the file (if `ping-mem.db` does not exist)
- Use `ping-mem.db` (if it already exists)
- Error if both exist with different content

Add this logic to `EventStore` constructor or `runtime.ts` initialization.

#### A7: Understory/u-os historical data NOT migrated

State explicitly: historical data in Understory `memory.sqlite` and u-os `memory.db` files is NOT migrated into ping-mem. Those systems start fresh with ping-mem as their write target going forward. Migration scripts only cover Claude Code file stores (decisions.jsonl, learnings/*.json, tasks/*.json, MEMORY.md).

### 19.4 Revised Phase Structure

The original 6-phase / 10-13 week plan is reduced to 4 phases / 7-8 weeks after scope cuts.

#### Phase 1: Core Consolidation (3 weeks)

**Scope**: 4 new tables (memories, decisions, learnings, tasks) + system_config + project_access_rules + admin DB merge. Migration scripts. Dual-write middleware. ContradictionDetector integration into write path.

**Cut from original Phase 1**: agent_profiles table, agent_corrections table, AgentProfileStore, FileChangeWatcher.

**Added**: Route-file architecture (A1), per-store migrations (A2), single-transaction writes (A3), UUIDv7 package (A5), events.db rename logic (A6).

**New files**: ~18 (down from 22)
**Modified files**: ~9

#### Phase 2: Context Engineering (3 weeks)

**Scope**: Token-budget retrieval (ContextRetriever), temporal decay, compression tiers (Digest->Essence), compression audit log, embedding LRU cache. Start eval dataset creation in parallel (can overlap with implementation).

**Unchanged from original Phase 2.**

**New files**: ~8
**Modified files**: ~5

#### Phase 3: Eval Baseline (1-2 weeks)

**Scope**: 15+ metrics (reduced from 20 -- cut metrics that depend on removed features: Staleness Detection Recall, Learning Propagation Latency). Frozen eval dataset. Baseline recording. Longitudinal tracking with regression detection.

**What moved here from Phase 4**: All eval work. Phase 4 is now documentation.
**What was cut**: Self-improvement loop hardening (was Phase 6), agent correction accuracy metric, staleness detection recall metric.

**New files**: ~8
**Modified files**: ~3

#### Phase 4: Documentation (1 day)

**Scope**: Static client config templates in `docs/client-configs/` for 8 IDEs (Claude Code, Cursor, Codex, VS Code Copilot, Continue, Cline, Windsurf, OpenCode). No CLI generator, no YAML/TOML libraries.

**Replaces**: Original Phase 5 config generator CLI + CrossProjectLinker.

**New files**: 8 static config files + 1 README
**Modified files**: 0

### 19.5 What Was Deferred (Not Deleted)

These items can be added in future plans when evidence justifies them:

| Item | Original Phase | Reintroduction Trigger |
|------|---------------|----------------------|
| Agent profiles + corrections | Phase 3 | When an agent actually needs persistent identity across sessions |
| Self-improvement loop hardening | Phase 6 | After 3+ months of eval data shows the existing loop is insufficient |
| CLI config generator | Phase 5 | When static docs prove insufficient for 3+ IDE configurations |
| FileChangeWatcher | Phase 1 | If audit-sync.ts reveals frequent external file mutations during transition |
| StalenessDetector | Phase 3 | If ContradictionDetector reveals cascading staleness as a real problem |
| CrossProjectLinker | Phase 5 | When a consumer project requests cross-project entity linking |
| Separate Qdrant collections | Phase 1 | When search latency p95 exceeds 500ms target |

### 19.6 Revised Effort Estimate

| Phase | Duration | Original Duration | Delta |
|-------|----------|-------------------|-------|
| Phase 1: Core Consolidation | 3 weeks | 2-3 weeks | Same (scope shifted, not reduced) |
| Phase 2: Context Engineering | 3 weeks | 2-3 weeks | Same |
| Phase 3: Eval Baseline | 1-2 weeks | 2 weeks (was Phase 4) | Reduced by ~1 week (fewer metrics) |
| Phase 4: Documentation | 1 day | 1-2 weeks (was Phase 5) | Reduced by ~1.5 weeks (static docs vs CLI) |
| ~~Phase 5: Multi-Client Rollout~~ | Cut | 1-2 weeks | -1.5 weeks |
| ~~Phase 6: Self-Improvement Hardening~~ | Cut | 1 week | -1 week |
| **Total** | **~7-8 weeks** | **10-13 weeks** | **-3 to -5 weeks** |

### 19.7 Predictability Score

**Checked claims**: 32 of the plan's factual assertions were verified against source code.

| Category | Result |
|----------|--------|
| Initially correct | 22/32 (69%) |
| Fixed in this amendment | 10/32 (31%) |
| Post-amendment accuracy | 32/32 (100% of checked claims) |

**Runtime unknowns** (not verifiable without running code):

| Unknown | Binary Test |
|---------|------------|
| SQLite WAL mode survives multiple MCP stdio processes writing simultaneously | Spawn 3 concurrent MCP servers, write from each, verify no SQLITE_BUSY |
| js-tiktoken cl100k_base token counts match Claude's actual tokenizer within 10% | Compare token counts for 100 sample texts against Anthropic API |
| Qdrant namespace filter does not degrade search latency beyond p95 target | Benchmark search with and without namespace filter on 100K+ vectors |
| FTS5 MATCH query performance on learnings table at 10K+ rows | Insert 10K learnings, benchmark search latency |

**Note**: Only 32 of potentially hundreds of plan claims were checked. The 100% score represents the verified subset, not total plan accuracy. Future verify passes should sample additional claims, particularly around integration points and edge cases.

### 19.8 Revised Summary

**Total new files**: ~35 (down from ~44)
**Total modified files**: ~12 (down from ~15)
**Total new tables**: 7 (memories, decisions, learnings, tasks, system_config, project_access_rules, compression_audit_log + eval_scores = 8 including eval)
**Total new MCP tools**: ~14 (down from ~20 -- cut agent profile/correction tools)
**Total new REST endpoints**: ~18 (added via route files, NOT rest-server.ts)
**Total new CLI commands**: 0 (replaced by static docs)
**Estimated total effort**: 7-8 weeks across 4 phases (down from 10-13 weeks across 6 phases)
**Key dependency**: Phase 1 is the foundation; Phases 2-3 depend on it; Phase 4 is independent
**New dependencies added**: `uuidv7` (^1.x), `lru-cache` (^10.x)
**Dependencies removed**: `yaml` (^2.x), `@iarna/toml` (^3.x)
