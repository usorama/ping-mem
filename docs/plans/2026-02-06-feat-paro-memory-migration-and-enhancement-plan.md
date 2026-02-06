---
title: "feat: Migrate Paro Memory from memory-keeper to ping-mem + Enhancements"
type: feat
date: 2026-02-06
version: 2.0.0
status: draft
---

# Migrate Paro Memory to ping-mem + Enhancements

## Overview

Replace memory-keeper MCP (SQLite-only, 384-dim vectors) with ping-mem (SQLite + Neo4j + Qdrant, hybrid search, entity graph, temporal queries) as Paro's primary memory layer. Migrate all 535 existing memories without data loss. Add three enhancements that make ping-mem function as true long-term AI memory: User Profile, Relevance Decay, and Proactive Recall.

## Critical Gaps Found (SpecFlow Analysis)

The following blockers were discovered during spec analysis and **must be resolved before migration**:

### BLOCKER 1: MemoryManager is In-Memory Only (CRITICAL)

`MemoryManager` stores memories in `Map<string, Memory>` (line 138 of MemoryManager.ts). After Docker restart, all memories are **gone**. Events persist in EventStore, but MemoryManager does not replay events on startup. **Without fixing this, migration is pointless — all 536 memories vanish on first restart.**

**Fix**: Implement `MemoryManager.hydrate()` — replay `MEMORY_SAVED`/`MEMORY_UPDATED`/`MEMORY_DELETED` events from EventStore on initialization. This is listed as "pending work" in CLAUDE.md roadmap.

### BLOCKER 2: MCP and REST Servers Have Separate MemoryManagers

MCP server (stdio) and REST server (HTTP) each instantiate their own `MemoryManager` with isolated in-memory Maps. A memory saved via REST is **invisible** to MCP server. "Save via Telegram, query via Claude Code" is impossible.

**Fix**: Both servers must share the same EventStore and hydrate from it. Since they run in separate containers, they already share the SQLite file via Docker volume. Hydration (BLOCKER 1 fix) solves this automatically — both servers replay the same event log on start.

### BLOCKER 3: Timestamps Are Overwritten

`MemoryManager.save()` hardcodes `createdAt: now` (line 194-204). The REST API has no field for custom timestamps. Original timestamps from memory-keeper (some weeks/months old) would be lost.

**Fix**: Add optional `createdAt`/`updatedAt` params to `save()` and REST endpoint, used only during migration.

### BLOCKER 4: sqlite-vec Virtual Table Can't ALTER TABLE

The plan proposed `ALTER TABLE vector_memories ADD COLUMN last_accessed`. But `vector_memories` is a `CREATE VIRTUAL TABLE ... USING vec0(...)` — SQLite virtual tables do not support ALTER TABLE.

**Fix**: Create a companion table `memory_relevance(memory_id PK, last_accessed, access_count, relevance_score)` with JOIN on queries.

### BLOCKER 5: Checkpoint Model Mismatch

ping-mem checkpoints have `{checkpointId, sessionId, lastEventId, memoryCount, description}` — no concept of per-item association. Memory-keeper's 3,439 checkpoint→item associations can't be represented.

**Fix**: Add `checkpoint_items` table to ping-mem's EventStore schema, or store item associations in checkpoint metadata JSON. Alternatively, accept that checkpoints become point-in-time markers (simpler, loses granularity).

### BLOCKER 6: No Idempotency Mechanism

`MemoryManager.save()` throws `MemoryKeyExistsError` on duplicate keys. Re-running migration fails immediately.

**Fix**: Add `saveOrUpdate()` method (upsert) to MemoryManager. Migration uses upsert. Alternatively, add a migration ledger table to track completed items and skip them on re-run.

## Problem Statement / Motivation

**Current state**: Paro uses `mcp-memory-keeper` — a basic key-value store with 384-dim hash vectors. No entity extraction, no graph relationships, no temporal queries. 534+ items accumulated with no consolidation, no decay, no cross-project intelligence.

**Target state**: Paro uses ping-mem's full stack (already running on Docker) with Neo4j for relationship graph, Qdrant for semantic search, and three new capabilities that transform storage into actual memory.

**Why now**: ping-mem Docker stack is already healthy and running. The brainstorm (`2026-02-06-paro-intelligence-brainstorm.md`) approved this architecture. Memory-keeper served its purpose as a bootstrap.

## Source Data (memory-keeper)

| Table | Rows | Migration Required |
|-------|------|--------------------|
| `sessions` | 30 | Yes - map to ping-mem sessions |
| `context_items` | 535 | Yes - primary data, map to ping-mem memories |
| `context_changes` | 538 | No - CDC log, can be regenerated |
| `vector_embeddings` | 535 | No - re-embed at 768-dim in ping-mem |
| `checkpoints` | 133 | Yes - preserve named snapshots |
| `checkpoint_items` | 3,439 | Yes - preserve checkpoint→item associations |
| `entities/relations/observations` | 0 | Skip - never used |
| `journal/file_cache/agents` | 0 | Skip - never used |

**DB Location**: `/Users/umasankr/mcp-data/memory-keeper/context.db` (5.1MB)

## Target System (ping-mem)

**Already running**:

| Container | Port | Status |
|-----------|------|--------|
| ping-mem (SSE) | 3000 | Healthy |
| ping-mem-rest | 3001 | Healthy |
| ping-mem-neo4j | 7474/7687 | Healthy |
| ping-mem-qdrant | 6333/6334 | Healthy |

**Storage model**: Event-sourced (append-only EventStore) + vector_memories (768-dim sqlite-vec) + Neo4j graph + Qdrant vectors

## Proposed Solution

### Phase 1: Migration Script (Zero Data Loss)

Write `scripts/migrate-from-memory-keeper.ts` that:

1. Opens memory-keeper SQLite DB directly (read-only)
2. Creates corresponding sessions in ping-mem via REST API
3. Migrates all 535 context_items preserving:
   - Key, value, category, priority, channel
   - Created/updated timestamps
   - Session association
4. Migrates 133 checkpoints with item associations
5. Re-embeds all items with ping-mem's 768-dim DeterministicVectorizer
6. Runs entity extraction on all items (auto-populates Neo4j graph)
7. Produces a verification report: item counts, sample comparisons, search result parity

**Category mapping** (memory-keeper → ping-mem):

| memory-keeper | ping-mem | Count |
|---------------|----------|-------|
| `progress` | `progress` | 427 |
| `decision` | `decision` | 62 |
| `task` | `task` | 29 |
| `note` | `note` | 8 |
| `error` | `error` | 5 |
| `failure` | `error` | 3 (merge into error) |

**Privacy mapping**: All memory-keeper items are non-private → map to `global` privacy in ping-mem (accessible from all sessions).

### Phase 2: User Profile Layer

Add a persistent user identity that accumulates across all sessions.

**New table** in ping-mem's SQLite:

```sql
CREATE TABLE user_profiles (
  user_id TEXT PRIMARY KEY,          -- 'umasankar' (simple string)
  display_name TEXT NOT NULL,
  preferences TEXT NOT NULL,          -- JSON: {llm: 'claude', voice: true, ...}
  goals TEXT NOT NULL,                -- JSON: [{goal, status, deadline, priority}]
  behavioral_patterns TEXT NOT NULL,  -- JSON: [{pattern, confidence, last_seen}]
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**New MCP tool**: `user_profile_get` / `user_profile_update`

**How it works**:
- On session start, Paro loads user profile as context
- On session end, Paro updates profile with new preferences/patterns observed
- Profile is session-independent — it's the user, not the session
- Stored in ping-mem's SQLite alongside EventStore

### Phase 3: Relevance Decay + Auto-Consolidation

Add `last_accessed` tracking and relevance scoring to memories.

**Schema addition** to vector_memories:

```sql
ALTER TABLE vector_memories ADD COLUMN last_accessed TEXT;
ALTER TABLE vector_memories ADD COLUMN access_count INTEGER DEFAULT 0;
ALTER TABLE vector_memories ADD COLUMN relevance_score REAL DEFAULT 1.0;
```

**Decay formula**:
```
relevance = base_score * decay_factor^(days_since_access)
where:
  base_score = priority_weight * category_weight * access_frequency_bonus
  decay_factor = 0.97 (halves every ~23 days)
  priority_weight: high=1.5, normal=1.0, low=0.5
  category_weight: decision=1.3, error=1.2, task=1.0, progress=0.8, note=0.7
  access_frequency_bonus: min(1.0 + log2(access_count) * 0.1, 2.0)
```

**Consolidation job** (runs daily or on-demand via MCP tool):
1. Scan items with `relevance_score < 0.3` AND `last_accessed > 30 days ago`
2. Group by channel/category
3. Summarize groups into digest entries (LLM-powered if available, else concatenate)
4. Archive originals (move to `archived_memories` table, keep IDs for lineage)
5. Record consolidation event in EventStore

**New MCP tools**:
- `memory_consolidate` — trigger consolidation manually
- `memory_stats` — show decay distribution, stale count, total size

### Phase 4: Proactive Recall on Save

When saving a new memory, automatically surface related existing memories.

**Implementation**: Modify `MemoryManager.save()` to:

1. After saving the new memory, compute its embedding
2. Run hybrid search (vector + keyword + graph) against existing memories
3. Filter results: `relevance_score > 0.5`, exclude same-session items, limit 5
4. Return related memories in the save response:

```typescript
interface SaveResult {
  id: MemoryId;
  key: string;
  // NEW: proactive recall
  relatedMemories?: Array<{
    key: string;
    value: string;  // truncated to 200 chars
    category: string;
    relevance: number;
    sessionName: string;
    createdAt: string;
  }>;
}
```

**MCP tool change**: `context_save` response includes `related` field when matches found.

**Why this matters**: When Paro saves "decided to use JWT for auth", it automatically gets back "FYI: 3 previous auth decisions exist" — making Paro self-correcting and consistent across sessions.

### Phase 5: Integration

Replace memory-keeper with ping-mem across all Paro channels.

**Claude Code MCP config** (`~/.claude/mcp.json`):
- Remove memory-keeper MCP server entry
- ping-mem MCP already configured (or add if missing)

**Paro Telegram bot** (`/Users/umasankr/Projects/paro/`):
- Add ping-mem REST client calls for memory operations
- Use ping-mem REST API (localhost:3001) instead of memory-keeper MCP
- Store conversation entities → ping-mem → Neo4j graph

**Paro `/paro` skill** (`~/.claude/skills/paro/SKILL.md`):
- Update boot sequence to use ping-mem tools instead of memory-keeper tools
- Load user profile on boot
- Use hybrid search for context loading

## Technical Considerations

### Architecture Impact
- ping-mem becomes the single source of truth for all Paro memory
- memory-keeper MCP can be disabled after migration verification
- Neo4j graph now contains cross-project entity relationships
- Qdrant gains non-code vectors (conversation memories alongside code chunks)

### Performance
- Migration: ~535 items at ~100ms each = ~1 minute total
- Proactive recall adds ~50-100ms to save operations (hybrid search latency)
- Decay recalculation: batch job, runs in background, not on critical path
- Consolidation: runs daily, processes only stale items

### Security
- memory-keeper DB accessed read-only during migration
- No API keys needed (local Docker, no auth configured currently)
- User profile contains preferences only, no secrets

### Backward Compatibility
- memory-keeper DB preserved as backup (never modified)
- If ping-mem fails, can re-enable memory-keeper MCP
- Migration script is idempotent (can re-run safely)

## Acceptance Criteria

### Functional Requirements
- [ ] All 535 context_items migrated with matching key, value, category, priority, channel
- [ ] All 30 sessions created with preserved names and metadata
- [ ] All 133 checkpoints migrated with item associations
- [ ] Search query "authentication" returns same top-5 results in ping-mem as memory-keeper
- [ ] Entity extraction populated Neo4j graph from migrated items
- [ ] User profile CRUD operations work via MCP tool
- [ ] Relevance decay scores computed correctly (spot check 10 items)
- [ ] Consolidation job reduces stale items by >50%
- [ ] Proactive recall returns related memories on save
- [ ] Paro `/paro` skill boots successfully with ping-mem backend

### Non-Functional Requirements
- [ ] Migration completes in < 5 minutes
- [ ] Zero data loss (verified by count comparison + sample checksums)
- [ ] Save + proactive recall < 200ms p95
- [ ] memory-keeper DB untouched (read-only access)

### Quality Gates
- [ ] `bun run typecheck` — 0 errors
- [ ] `bun test` — all existing tests pass
- [ ] New tests for migration script, user profile, decay, proactive recall
- [ ] Manual verification: query 5 random memories in both systems, compare

## Implementation Phases

### Phase 0: Fix Blockers (MUST complete before migration) [~3-4 hours] ✅ COMPLETE

**Critical path** — without these, migration is ephemeral and cross-server memory is broken.

**Files modified:**
- ✅ `src/memory/MemoryManager.ts` — added `hydrate()`, verified `saveOrUpdate()` exists, optional timestamps
- ✅ `src/storage/EventStore.ts` — added `checkpoint_items` table, `getCheckpointItems()`
- ✅ `src/search/VectorIndex.ts` — added companion `memory_relevance` table
- ✅ `src/mcp/PingMemServer.ts` — added `hydrate()` call on MemoryManager initialization
- ✅ `src/http/rest-server.ts` — added `createdAt`/`updatedAt` to save endpoint
- ✅ `src/http/types.ts` — added timestamp fields to ContextSaveRequest
- ✅ `src/types/index.ts` — extended MemoryEventData to include full memory for hydration

**Completed tasks:**
1. ✅ **MemoryManager.hydrate()** — Replays MEMORY_SAVED/UPDATED/DELETED events from EventStore. Rebuilds in-memory Maps on startup.
2. ✅ **MemoryManager.saveOrUpdate()** — Already exists at line 264-270, no changes needed.
3. ✅ **Optional timestamps in save()** — Accepts `createdAt`/`updatedAt` in SaveMemoryOptions. Defaults to `now` if not provided.
4. ✅ **memory_relevance companion table** — CREATE TABLE with `memory_id`, `last_accessed`, `access_count`, `relevance_score`. Initialized in VectorIndex.initializeSchema().
5. ✅ **checkpoint_items table** — Added to EventStore schema. Updated `createCheckpoint()` to accept item keys. Added `getCheckpointItems()` method.
6. ✅ **REST endpoint timestamp params** — Accepts optional createdAt/updatedAt in POST body, passes to MemoryManager.
7. ✅ **hydrate() on startup** — Called in PingMemServer and REST server after MemoryManager creation.
8. ✅ **Type safety** — All TypeScript errors fixed (0 errors from `bun run typecheck`).
9. ✅ **Tests** — All 928 existing tests pass.

**Verification:** Ready for Phase 1. Docker restart will now preserve all memories. Save via REST, restart containers, query via MCP — same data will be visible.

**Commit:** `1f017ac - feat(core): Fix Phase 0 blockers for memory migration`

### Phase 1: Migration Script [~2 hours]

**Files to create:**
- `scripts/migrate-from-memory-keeper.ts` — main migration script
- `src/migration/MemoryKeeperReader.ts` — read memory-keeper SQLite schema
- `src/migration/MigrationVerifier.ts` — post-migration verification
- `src/migration/MigrationLedger.ts` — track migrated items for idempotency

**Tasks:**
1. Read all sessions from memory-keeper DB (30 sessions)
2. Create sessions in ping-mem via REST API (POST /session/start)
3. Iterate context_items using `saveOrUpdate()` with preserved timestamps
4. Use `X-Session-ID` header per request to target correct session
5. Migrate checkpoints with item key associations
6. Disable proactive recall during bulk migration (flag in save options)
7. Run entity extraction on migrated items (batch, with Neo4j error handling)
8. Record migration in ledger for idempotency
9. Verify: count comparison + 5 random sample searches
10. Map NULL category → `note`, `failure` → `error`
11. Run migration with exclusive REST access (no concurrent Paro sessions)

### Phase 2: User Profile [~1.5 hours]

**Files to create/modify:**
- `src/profile/UserProfile.ts` — UserProfile type + store
- `src/mcp/PingMemServer.ts` — add `user_profile_get`, `user_profile_update` tools

**Tasks:**
1. Create user_profiles table in SQLite
2. Implement UserProfileStore with get/update
3. Add MCP tool schemas and handlers
4. Seed initial profile from migrated data analysis

### Phase 3: Relevance Decay [~2 hours]

**Files to create/modify:**
- `src/memory/RelevanceEngine.ts` — decay calculation + consolidation logic
- `src/memory/MemoryManager.ts` — update get/recall to track access in `memory_relevance` table
- `src/storage/EventStore.ts` — add `archived_memories` table for consolidation
- `src/mcp/PingMemServer.ts` — add `memory_consolidate`, `memory_stats` tools

**Tasks:**
1. Use `memory_relevance` companion table (created in Phase 0) — do NOT alter vec0 virtual table
2. On every `get()`/`recall()`, UPDATE `memory_relevance` SET `last_accessed = now, access_count += 1`
3. Implement decay formula (recalculate `relevance_score` on access or via batch job)
4. For migrated items: set initial `last_accessed` to original `updated_at` (not migration time)
5. For items never accessed: treat NULL `last_accessed` as `created_at` (no NaN)
6. Implement consolidation: scan stale items, group by channel, summarize (LLM with 2000-char cap on concatenation fallback)
7. Create `archived_memories` table for archival (preserve IDs for lineage)
8. Add `memory_consolidate` and `memory_stats` MCP tools

### Phase 4: Proactive Recall [~1.5 hours]

**Depends on**: Phase 3 (for `relevance_score` filter). If Phase 3 not done yet, skip relevance filter and use recency instead.

**Files to modify:**
- `src/memory/MemoryManager.ts` — modify save() to return related memories
- `src/mcp/PingMemServer.ts` — update context_save response schema

**Tasks:**
1. After save, compute embedding for new item
2. Run hybrid search (top 5, exclude same session)
3. Filter by relevance_score > 0.5 if Phase 3 complete, else filter by recency (last 90 days)
4. Return related memories in save response
5. Add `skipProactiveRecall` flag in save options (for bulk migration, disabled by default)
6. Add 200ms timeout on hybrid search — if search takes longer, return save result without related memories (don't block)
7. Update MCP tool response schema

### Phase 5: Integration [~1 hour]

**Files to modify:**
- `~/.claude/mcp.json` — swap MCP servers
- `~/.claude/skills/paro/SKILL.md` — update boot sequence
- `/Users/umasankr/Projects/paro/src/memory/` — add ping-mem REST client

**Tasks:**
1. Update Claude Code MCP config
2. Update Paro skill to use ping-mem tools
3. Add ping-mem REST client to Paro Telegram bot
4. Verify end-to-end: save via Telegram → query via Claude Code

## Phase Dependency Graph

```
Phase 0 (Fix Blockers) ──► Phase 1 (Migration) ──► Phase 5 (Integration)
                      │                                    ▲
                      ├──► Phase 2 (User Profile) ────────┘
                      │                                    ▲
                      └──► Phase 3 (Relevance Decay) ──► Phase 4 (Proactive Recall)
```

- Phase 0 blocks everything (critical infrastructure fixes)
- Phase 1 blocks Phase 5 (can't integrate without data)
- Phase 2 can run in parallel with Phase 3
- Phase 3 should complete before Phase 4 (for relevance_score filter)
- Phase 5 depends on all others

## Rollback Runbook

If ping-mem fails after cutover:

```bash
# 1. Re-enable memory-keeper MCP in Claude Code
# Edit ~/.claude/mcp.json — re-add memory-keeper server entry

# 2. Revert Paro skill
# Edit ~/.claude/skills/paro/SKILL.md — change ping-mem tools back to memory-keeper tools

# 3. Stop Paro Telegram bot using ping-mem REST
# Kill bot process, restart with memory-keeper config

# 4. Verify memory-keeper DB is intact
sqlite3 /Users/umasankr/mcp-data/memory-keeper/context.db "SELECT COUNT(*) FROM context_items;"
# Should return 535+

# 5. ping-mem data is preserved in Docker volumes for debugging
docker volume ls | grep ping-mem
```

**Memory-keeper DB is NEVER modified** during migration (read-only access). Rollback is always safe.

## Dependencies & Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Migration data corruption | High | Keep memory-keeper DB as backup, verify checksums |
| ping-mem Docker goes down | Medium | Docker restart policy already set, volumes persisted |
| Vector dimension mismatch | Low | Re-embed everything at 768-dim, don't copy 384-dim vectors |
| Entity extraction noise | Low | Run extraction, review graph, prune false positives |
| Consolidation deletes useful memories | Medium | Archive (don't delete), allow restore |

## Success Metrics

| Metric | Target |
|--------|--------|
| Items migrated | 535/535 (100%) |
| Sessions preserved | 30/30 |
| Search parity | Top-5 overlap > 80% |
| Neo4j entities created | > 100 (from 535 items) |
| Proactive recall hit rate | > 30% of saves surface related memories |
| Decay stale reduction | > 50% of items scored for staleness |

## References & Research

### Internal References
- Brainstorm: `docs/brainstorms/2026-02-01-universal-memory-multi-project-brainstorm.md`
- Brainstorm: `~/Projects/Paro/docs/brainstorms/2026-02-06-paro-intelligence-brainstorm.md`
- Architecture: `~/Projects/Paro/docs/plans/2026-02-06-paro-chief-of-staff-architecture-design.md`
- memory-keeper DB: `/Users/umasankr/mcp-data/memory-keeper/context.db`
- ping-mem MCP: `src/mcp/PingMemServer.ts`
- ping-mem MemoryManager: `src/memory/MemoryManager.ts`
- ping-mem EventStore: `src/storage/EventStore.ts`

### memory-keeper Schema Summary
- 535 context_items across 30 sessions
- 133 checkpoints with 3,439 item associations
- 384-dim hash-based vectors (BLOB)
- Categories: progress(80%), decision(12%), task(5%), note(1.5%), error(1%)
- 31 distinct channels
- Entity/relationship tables exist but are all empty (0 rows)

### Docker Stack (verified running)
- ping-mem SSE: `localhost:3000`
- ping-mem REST: `localhost:3001`
- Neo4j: `localhost:7474` (HTTP), `localhost:7687` (Bolt)
- Qdrant: `localhost:6333` (HTTP), `localhost:6334` (gRPC)
