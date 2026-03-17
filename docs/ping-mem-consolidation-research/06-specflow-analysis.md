# 06 - SpecFlow Analysis: User/Agent Flows, Edge Cases, and Gaps

**Date**: 2026-03-17
**Status**: Complete
**Inputs**: 01-competitive-analysis.md, 02-multi-client-config.md, 03-context-engineering-evals.md, 04-current-data-model-audit.md, 05-synthesis.md
**Purpose**: Enumerate every user/agent flow that touches ping-mem, identify edge cases, surface missing flows, and list questions that must be answered before implementation.

---

## 1. User/Agent Flows

### F1: Save Memory (Core Write Path)

```
Agent -> context_save(key, value, category, priority)
  -> MemoryManager.save() -> EventStore.append(MEMORY_SAVED)
  -> [NEW] Dual-write middleware -> memories table INSERT/UPSERT
  -> [NEW] Qdrant vector INSERT (namespace: "memory")
  -> [NEW] File fallback write (decisions.jsonl / learnings/*.json / MEMORY.md)
  -> [NEW] MemoryPubSub.emit("memory:saved")
  -> [NEW] Contradiction check against existing memories with same key/topic
```

**Actors**: Any MCP client (Claude Code, Cursor, Codex, etc.), REST API caller, SDK user
**Frequency**: High (10-100+ per session)
**Latency target**: < 50ms for SQLite write, < 200ms including Qdrant

### F2: Search Memory (Core Read Path)

```
Agent -> context_search(query, limit, filters)
  -> [NEW] Token budget allocation (if tokenBudget provided)
  -> HybridSearchEngine.search() -> BM25 + Qdrant vector + Neo4j graph
  -> [NEW] Temporal decay re-ranking
  -> [NEW] Access-count increment on returned results
  -> [NEW] Position-aware ordering (high relevance at edges)
  -> Return ranked results within token budget
```

**Actors**: Any MCP/REST client
**Frequency**: Very high (most common operation)
**Latency target**: p50 < 100ms, p95 < 500ms

### F3: Get Memory by Key (Direct Lookup)

```
Agent -> context_get(key) OR memory_get(key, namespace)
  -> [NEW] memories table direct SELECT by key + namespace
  -> [CURRENT] Fallback: EventStore replay if not in memories table
  -> [NEW] Access-count increment
  -> Return memory with provenance
```

**Actors**: Any client needing specific key lookup
**Frequency**: Medium
**Latency target**: < 10ms (direct SQLite index lookup)

### F4: Token-Budget-Aware Retrieval (New)

```
Agent -> context_retrieve(query, tokenBudget, scopes)
  -> Allocate budget: 60% direct matches, 25% related, 15% cross-project
  -> HybridSearchEngine.search() with each allocation
  -> Token-count each result (tiktoken-compatible)
  -> Fill budget greedily by score * decay
  -> Position-aware ordering
  -> Return {results, budgetUsed, budgetRemaining}
```

**Actors**: LLM-integrated agents that need context within a window
**Frequency**: High (every LLM call that needs context)
**Latency target**: < 300ms

### F5: Save Decision

```
Agent -> decision_save(title, type, rationale, alternatives, linkedIssues)
  -> [NEW] decisions table INSERT
  -> [NEW] Check for supersession (does this contradict an active decision?)
  -> EventStore.append(MEMORY_SAVED, category='decision')
  -> File fallback: append to decisions.jsonl
  -> [NEW] Neo4j: create (Decision)-[:CAUSED_BY]->(Evidence) if evidence provided
```

**Actors**: Agents recording architectural/implementation decisions
**Frequency**: Low (1-5 per session)

### F6: Save Learning

```
Agent -> learning_save(domain, title, content, source, whenToApply)
  -> [NEW] learnings table INSERT
  -> [NEW] learnings_fts trigger fires
  -> File fallback: update ~/.claude/learnings/domains/<domain>.json
  -> [NEW] Cross-project propagation event emitted
```

**Actors**: Agents that learn from user corrections or observations
**Frequency**: Low-medium (1-10 per session)

### F7: Save Task

```
Agent -> task_save(title, description, status, parentTaskId, dependencies)
  -> [NEW] tasks table INSERT/UPDATE
  -> EventStore.append(AGENT_TASK_STARTED/COMPLETED)
  -> [OPTIONAL] File fallback: ~/.claude/tasks/
```

**Actors**: Orchestrator agents managing work breakdown
**Frequency**: Medium

### F8: Register Agent Identity

```
Agent -> agent_register(agentId, role, capabilities, behavioralRules)
  -> agent_quotas UPSERT (existing)
  -> [NEW] agent_profiles UPSERT
  -> Return agent registration confirmation
```

**Actors**: Each agent on first session start
**Frequency**: Once per agent lifecycle

### F9: Record Agent Correction

```
User corrects agent -> agent_correction_record(originalAction, correctedAction, context)
  -> [NEW] agent_corrections INSERT
  -> [NEW] Extract learned_rule from correction
  -> [NEW] Update agent_profiles.behavioral_rules with new rule
  -> [NEW] Propagate learning to learnings table
```

**Actors**: Triggered by user corrections during sessions
**Frequency**: Low (1-5 per session when corrections happen)

### F10: Session Start with Context Loading

```
Agent -> context_session_start(name, projectDir, autoIngest)
  -> SessionManager.start()
  -> [NEW] Load agent_profiles for current agent_id
  -> [NEW] Load recent decisions for project
  -> [NEW] Load high-confidence learnings for project
  -> [EXISTING] Auto-ingest if projectDir changed since last ingest
  -> Return session with pre-loaded context
```

**Actors**: Every agent on every session start
**Frequency**: Once per session

### F11: Codebase Ingest

```
Agent -> codebase_ingest(projectDir, forceReingest)
  -> ProjectScanner.scan() -> Merkle tree + manifest check
  -> CodeChunker.chunk() -> function/class/file-level chunks
  -> GitHistoryReader.read() -> commit DAG + diffs
  -> TemporalCodeGraph.persist() -> Neo4j nodes + edges
  -> CodeIndexer.index() -> Qdrant vectors + BM25/FTS5
  -> [NEW] Qdrant namespace: "code" on all points
```

**Actors**: Auto-ingest pipeline, manual trigger
**Frequency**: Per-commit or periodic (every 10 min)

### F12: Codebase Search

```
Agent -> codebase_search(query, projectId, type, limit)
  -> CodeChunkStore BM25/FTS5 search
  -> Qdrant vector search (namespace: "code", filter: projectId)
  -> Merge and re-rank results
  -> Return code chunks with provenance
```

**Actors**: Any agent needing code context
**Frequency**: High

### F13: Diagnostics Ingest

```
CI pipeline -> diagnostics_ingest(sarif, projectId, treeHash, tool)
  -> DiagnosticsStore.ingestRun()
  -> Parse SARIF -> normalize findings
  -> Store in diagnostics.db (separate DB)
  -> [OPTIONAL] LLM summary generation
```

**Actors**: CI/CD pipelines, manual diagnostics collection
**Frequency**: Per-CI-run

### F14: Cross-Project Query

```
Agent -> context_search(query, crossProject: true)
  -> [NEW] Check project_access_rules ACL (Phase 5)
  -> Search across all registered projects
  -> [NEW] Apply cross-project isolation filter
  -> Return results with project attribution
```

**Actors**: Agents working on multi-project tasks
**Frequency**: Low-medium

### F15: Memory Compression

```
Nightly job OR agent -> memory_compress(scope, strategy)
  -> SemanticCompressor.compress()
  -> [NEW] Raw -> Digest tier compression
  -> [NEW] Digest -> Essence tier compression
  -> [NEW] compression_audit_log INSERT (what was preserved/discarded)
  -> [NEW] Update memories.compression_tier
  -> Archive raw to cold storage (EventStore remains)
```

**Actors**: Nightly cron, manual trigger
**Frequency**: Daily or on-demand

### F16: Multi-Client Config Generation (New)

```
User -> ping-mem config generate <client>
  -> [NEW] CLI reads client template
  -> [NEW] Detect local environment (bun path, DB path, Neo4j, Qdrant)
  -> [NEW] Generate config in client-specific format (JSON/YAML/TOML)
  -> Output to stdout or write to config file path
```

**Actors**: Human users setting up new IDE integrations
**Frequency**: Once per IDE setup

### F17: Causal Chain Query (New)

```
Agent -> memory_explain_why(decisionId OR query)
  -> [NEW] Neo4j traversal: (Decision)-[:CAUSED_BY*]->(Evidence)
  -> Collect causal chain with timestamps
  -> Return ordered chain of facts leading to decision
```

**Actors**: Agents needing to understand decision rationale
**Frequency**: Low

### F18: Eval Suite Run

```
Nightly cron -> eval run
  -> Load frozen eval dataset
  -> Run queries against current system
  -> Compute all 20 metrics
  -> [NEW] Store scores in eval_scores table with timestamp
  -> [NEW] Compare against trailing mean
  -> [NEW] Alert if regression detected
```

**Actors**: Automated nightly job
**Frequency**: Daily

### F19: Self-Improvement Loop

```
Nightly cron -> improvement loop
  -> Baseline eval (Blue)
  -> Mutate parameters (retrieval weights, decay, compression)
  -> Candidate eval (Green)
  -> Statistical test (p < 0.05)
  -> [NEW] Canary evaluation (5% of eval set first)
  -> Promote or discard
  -> [NEW] Record in longitudinal DB
```

**Actors**: Automated nightly job
**Frequency**: Nightly

### F20: Data Migration (One-Time)

```
Admin -> run migration scripts
  -> [NEW] migrate-decisions: decisions.jsonl -> decisions table
  -> [NEW] migrate-learnings: ~/.claude/learnings/ -> learnings table
  -> [NEW] migrate-tasks: ~/.claude/tasks/ -> tasks table
  -> [NEW] migrate-memories: EventStore replay -> memories table
  -> [NEW] merge-admin: admin.db tables -> ping-mem.db
  -> Dry-run mode: report what would change without writing
```

**Actors**: Admin/developer, one-time during Phase 1
**Frequency**: Once

---

## 2. Edge Cases

### EC1: Ollama Down During Embedding

**Scenario**: Agent saves a memory, Ollama (local embedding provider) is unreachable.
**Impact**: Vector search will not include this memory; BM25/FTS5 will.
**Mitigation**: Embedding chain fallback (Ollama -> Gemini -> OpenAI). If all fail, store memory without vector; queue for embedding when provider recovers. Flag memory as `embedding_pending`.

### EC2: ping-mem Container Restarts Mid-Write

**Scenario**: Docker container restarts while a dual-write is in progress (SQLite written, file not yet written).
**Impact**: Data divergence between ping-mem DB and file fallbacks.
**Mitigation**: SQLite WAL mode ensures DB consistency. File write is best-effort. Weekly audit script diffs file stores vs ping-mem tables to detect drift.

### EC3: Two Agents Write Conflicting Decisions

**Scenario**: Agent A saves "Use PostgreSQL" while Agent B saves "Use MongoDB" for the same project.
**Impact**: Contradictory decisions in the decisions table.
**Mitigation**: Contradiction detection on write path (Phase 3). Compare new decision against existing decisions with overlapping topics. Flag as contradiction with temporal ordering for resolution. The more recent decision has higher temporal relevance, but both are preserved with their provenance.

### EC4: Memory Table Out of Sync with EventStore

**Scenario**: A bug causes memories table to diverge from EventStore events.
**Impact**: Memory reads return stale or incorrect data.
**Mitigation**: EventStore is the source of truth. Provide a `memory_rebuild` admin command that replays all events to reconstruct the memories table. Include a consistency check in the weekly audit.

### EC5: Qdrant Collection Has Mixed-Dimension Vectors

**Scenario**: Memory vectors (768d from Ollama) and code vectors (hash-based, different dimensions) coexist in the same Qdrant collection.
**Impact**: Search quality degradation; potential vector comparison errors.
**Mitigation**: Phase 1 adds namespace payload field. All queries filter by namespace. Long-term: separate collections for memory vs code.

### EC6: Migration Script Fails Mid-Run

**Scenario**: decisions.jsonl migration processes 500 of 770 entries, then crashes.
**Impact**: Partial migration; some decisions in table, others not.
**Mitigation**: Run migrations inside a SQLite transaction. On failure, entire batch rolls back. Provide `--resume` flag that checks which entries already exist.

### EC7: Multiple stdio Processes Competing for SQLite

**Scenario**: Claude Code, Cursor, and Codex each spawn their own ping-mem stdio process, all writing to the same SQLite DB.
**Impact**: WAL contention, potential SQLITE_BUSY errors.
**Mitigation**: SQLite WAL mode + busy_timeout (5000ms) handles concurrent readers well. For writes, the WriteLockManager already serializes. Document single-server mode (HTTP transport) for resource-constrained environments.

### EC8: Token Budget Exceeds Available Context

**Scenario**: Agent requests tokenBudget=50000 but total relevant memories only amount to 5000 tokens.
**Impact**: Under-utilization of budget.
**Mitigation**: Return all relevant results with budget accounting showing `{budgetUsed: 5000, budgetRemaining: 45000}`. Do not pad with irrelevant results.

### EC9: Temporal Decay Drops Important Memory Below Threshold

**Scenario**: An architectural decision from 6 months ago has decayed significantly but is still critical.
**Impact**: Agent fails to retrieve a foundational decision.
**Mitigation**: Decay floor of 0.5 for `architecture`, `breaking_change`, and `contract` categories. Access-count boost for frequently-referenced decisions.

### EC10: Cross-Project Query Leaks Sensitive Data

**Scenario**: Agent queries with crossProject=true and retrieves credentials or proprietary code from another project.
**Impact**: Privacy/security violation.
**Mitigation**: Phase 5 ACL model gates cross-project access per project pair. Until then, crossProject queries only surface non-sensitive metadata (titles, decision summaries -- not raw code or values). Isolation violation rate metric targets 0%.

### EC11: Compression Discards Critical Anchor Fact

**Scenario**: The Digest->Essence compression pass removes a fact that turns out to be critical.
**Impact**: Agent loses context needed for correct decisions.
**Mitigation**: Anchor facts (tagged as `architecture`, `contract`, `breaking_change`) are exempt from compression. Compression audit trail records every discarded fact. Raw tier is never deleted -- only moved to cold storage. Rollback is always possible.

### EC12: Agent Profile Gets Corrupted

**Scenario**: A buggy agent overwrites its own behavioral_rules with empty array.
**Impact**: Agent loses all learned rules, reverts to default behavior.
**Mitigation**: agent_corrections table preserves the history of all corrections. Behavioral rules can be rebuilt from correction history. Version agent_profiles with updated_at timestamp; provide rollback to previous version.

### EC13: FTS5 Index Desyncs from learnings Table

**Scenario**: An UPDATE to learnings table fails to trigger the FTS5 sync trigger.
**Impact**: Text search misses recently updated learnings.
**Mitigation**: Use SQLite triggers (INSERT/UPDATE/DELETE) to keep FTS5 in sync, following the pattern already used for knowledge_fts. Provide `REBUILD` command for learnings_fts.

### EC14: Eval Dataset Becomes Stale

**Scenario**: The frozen eval dataset no longer represents real usage patterns after 6 months.
**Impact**: Self-improvement loop optimizes for outdated queries.
**Mitigation**: Review and update eval dataset quarterly. Keep old versions for longitudinal comparison. Never modify in-place -- version the dataset.

### EC15: Dual-Write File Fallback Diverges

**Scenario**: ping-mem write succeeds but file write fails (disk full, permissions).
**Impact**: File-based readers (other tools reading decisions.jsonl directly) see stale data.
**Mitigation**: Log file-write failures as telemetry events. Weekly audit script catches divergence. After 3-month transition, file reads are deprecated so divergence becomes irrelevant.

### EC16: Nightly Improvement Loop Promotes Bad Parameters

**Scenario**: Statistical test passes (p < 0.05) but the improvement is an artifact of eval set composition.
**Impact**: Production retrieval quality degrades on real queries.
**Mitigation**: Canary evaluation (5% of eval set) before full run. Human review gate for parameter changes > 20% from baseline. Automatic rollback if next nightly eval shows regression.

---

## 3. Missing Flows

### MF1: Memory Garbage Collection

**Current gap**: No mechanism to clean up expired memories (TTL), orphaned vectors in Qdrant, or stale code chunks from deleted files.
**Needed**: Periodic GC job that:
- Deletes memories past `expires_at`
- Removes Qdrant vectors for deleted memories
- Cleans code chunks for files no longer in the project
- Reclaims agent quota for expired agents

### MF2: Bulk Data Migration CLI

**Current gap**: No user-facing command to migrate existing file-based data into ping-mem.
**Needed**: `ping-mem migrate --source <type> --dry-run` command that handles:
- decisions.jsonl import
- learnings directory import
- task files import
- EventStore replay to memories table

### MF3: Memory Export/Backup

**Current gap**: No way to export all memories for a project or agent as a portable format.
**Needed**: `ping-mem export --project <id> --format <json|jsonl>` for:
- Backup before major changes
- Migration between ping-mem instances
- Sharing memory snapshots between team members

### MF4: Conflict Resolution UI

**Current gap**: When contradictions are detected, no mechanism for human review and resolution.
**Needed**: Web UI page (`/ui/conflicts`) showing detected contradictions with:
- Side-by-side comparison
- Temporal context (when each was saved)
- One-click resolution (keep A, keep B, merge, or mark both valid)

### MF5: Health Check for Embedding Pipeline

**Current gap**: Health endpoint checks Neo4j and Qdrant connectivity but not embedding provider availability.
**Needed**: Extend `/health` to report embedding provider status (Ollama, Gemini, OpenAI) and queue depth of pending embeddings.

### MF6: Memory Access Audit Trail

**Current gap**: No record of which memories were accessed and by whom.
**Needed**: Lightweight access log (separate from EventStore -- higher volume) tracking:
- Which memory was accessed
- By which agent/session
- Timestamp
- Used for access-count increment and temporal decay model tuning

### MF7: Schema Version Management

**Current gap**: Migrations table exists but there is no versioned schema evolution strategy for the 6 new tables.
**Needed**: Numbered migration system (`migration_003_add_memories_table.ts`, etc.) with:
- Forward migration
- Rollback capability
- Version tracking in migrations table

### MF8: Embedding Re-Index on Provider Change

**Current gap**: If embedding provider changes (e.g., Ollama -> Gemini), existing vectors become incompatible.
**Needed**: `ping-mem reindex --collection memories --provider gemini` command that:
- Re-embeds all memories with the new provider
- Atomically swaps Qdrant collection
- Records provider change in metadata

### MF9: Agent Profile Sync Across Clients

**Current gap**: If an agent is corrected in Claude Code, that correction is stored but not automatically propagated to the same agent running in Cursor.
**Needed**: agent_profiles are stored centrally in ping-mem.db. Session start in any client loads the latest profile. Corrections from any client update the central profile.

### MF10: Rate Limiting for Multi-Client Access

**Current gap**: Multiple clients can overwhelm ping-mem with concurrent requests.
**Needed**: Per-agent rate limiting in the REST API layer, configurable per agent role.

---

## 4. Critical Questions That Must Be Answered in the Plan

### Q1: Memory Table Identity -- UUIDv7 or Content-Addressable?

The synthesis proposes UUIDv7 for time-ordered entities. But content-addressable IDs (SHA-256) are a core ping-mem principle. **Decision needed**: Should `memory_id` be UUIDv7 (time-sortable, no collisions) or SHA-256(namespace + project_id + key) (content-addressable, dedup-friendly)?

**Recommendation**: Use UUIDv7 for `memory_id` (primary key, time-sortable) but add a content hash column `content_hash = SHA-256(namespace + project_id + key)` with a UNIQUE constraint for dedup. This satisfies both P2 (deterministic provenance) and the need for time-ordering.

### Q2: How Does the Dual-Write Middleware Intercept File Writes?

Currently, decisions.jsonl is written by external tools (Claude Code hooks). ping-mem does not control those write paths. **Question**: Does the dual-write middleware intercept writes TO ping-mem and replicate to files, or intercept writes FROM external tools and replicate to ping-mem?

**Recommendation**: ping-mem is the primary write target. The middleware writes to ping-mem first, then writes to files as fallback. External tools that currently write to files directly must be updated to write to ping-mem instead. For the 3-month transition, a file watcher or hook can detect external file writes and sync them to ping-mem.

### Q3: What Happens to knowledge_entries During Consolidation?

The knowledge_entries table serves a different purpose (troubleshooting knowledge with symptoms/root_cause/solution) than the new learnings table (behavioral learnings with domain/confidence/when_to_apply). **Question**: Do they merge, coexist, or does one replace the other?

**Recommendation**: Coexist. knowledge_entries stays for troubleshooting knowledge (its schema is purpose-built). learnings is for behavioral learnings. A partial migration copies entries that are actually behavioral learnings from knowledge_entries to learnings.

### Q4: How Are Existing Qdrant Vectors Migrated to Include Namespace?

Existing vectors in Qdrant lack the `namespace` payload field. **Question**: Batch update all existing points to add namespace, or create new collection and re-index?

**Recommendation**: Batch update existing points via Qdrant `set_payload` API. Code vectors get `namespace: "code"`, memory vectors get `namespace: "memory"`. This is non-destructive and can be run while the system is live.

### Q5: What Is the Embedding Dimension for Memory Vectors?

Current code vectors use DeterministicVectorizer (hash-based, variable dimensions). Memory vectors use optional OpenAI (1536d) or none. With the Ollama -> Gemini -> OpenAI chain, what dimension is standard?

**Recommendation**: Standardize on 768 dimensions (Ollama nomic-embed-text default). Store dimension in collection metadata. If Gemini or OpenAI produce different dimensions, truncate or pad to 768 (or use adapter layer).

### Q6: How Does the memories Table Handle Cross-Session Memory?

Current memories are session-scoped (stored via EventStore with session_id). The new memories table has `namespace` and optional `session_id`. **Question**: How are global/project-scoped memories (no session) distinguished from session-scoped ones?

**Recommendation**: `namespace` field controls scope: `global` (no project, no session), `project` (project_id set, no session), `session` (both set), `agent` (agent_id set). The UNIQUE constraint is on `(namespace, project_id, key)` -- session-scoped memories use `namespace='session:{session_id}'` to avoid collisions.

### Q7: What Token Counter Is Used for Budget-Aware Retrieval?

Different LLM providers use different tokenizers. **Question**: Which tokenizer does ping-mem use to count tokens?

**Recommendation**: Use `tiktoken` (cl100k_base encoding) as the default tokenizer. This is compatible with OpenAI, Anthropic (close enough), and most models. Accept an optional `tokenizer` parameter for callers with specific needs. Round down by 10% safety margin.

### Q8: How Is the Frozen Eval Dataset Created?

The eval suite needs a representative frozen dataset. **Question**: What queries go in it? How many? How are ground-truth labels assigned?

**Recommendation**: Semi-automated generation: (1) sample 50 real queries from production EventStore logs, (2) for each query, run current retrieval and have LLM-as-Judge label relevance of each result, (3) human-validate 100% of labels, (4) freeze the dataset with a version hash. Review quarterly.

### Q9: How Does Admin DB Merge Work Without Downtime?

Merging admin.db tables into ping-mem.db requires creating tables in the target DB and copying data. **Question**: Can this happen while the server is running?

**Recommendation**: Yes. SQLite supports multiple attached databases. The migration script: (1) opens both DBs, (2) creates tables in ping-mem.db if not exists, (3) `INSERT INTO ping_mem.admin_api_keys SELECT * FROM admin.admin_api_keys`, (4) updates runtime.ts to use single DB connection. This is additive -- no data loss.

### Q10: What Is the Agent Correction Extraction Strategy?

When a user corrects an agent, how is the correction detected and the learned rule extracted? **Question**: Is this automatic (LLM-based) or manual (agent explicitly records)?

**Recommendation**: Initially manual -- agents call `agent_correction_record` when they detect a correction pattern (user says "no, do X instead of Y"). Future: LLM-based extraction from conversation patterns. The key is that the `learned_rule` field captures the reusable behavioral rule.

### Q11: How Are File-Based Store Readers Updated During Transition?

Claude Code's session-start hook reads `~/.claude/memory/MEMORY.md`. The cc-memory skill reads `~/.claude/learnings/`. **Question**: How are these tools updated to read from ping-mem instead?

**Recommendation**: Phase 1 updates CLAUDE.md instructions to tell agents to use ping-mem MCP tools for reads. Phase 2 updates cc-memory and cc-connect skills to call ping-mem first, file as fallback. The 3-month transition period allows both read paths.

### Q12: What Happens When the Self-Improvement Loop Mutates Decay Parameters?

The improvement loop can modify temporal decay parameters (lambda, alpha). **Question**: Where are these parameters stored? How are they loaded at runtime?

**Recommendation**: Store tunable parameters in a `system_config` table in ping-mem.db (`config_key TEXT PRIMARY KEY, config_value TEXT, updated_at TEXT`). The improvement loop updates this table. HybridSearchEngine reads from this table on initialization (cached, refreshed on config change event).

---

## 5. Flow Dependencies

```
Phase 1 (Core Consolidation)
  F1 (Save Memory) -- requires memories table
  F3 (Get Memory) -- requires memories table
  F5 (Save Decision) -- requires decisions table
  F6 (Save Learning) -- requires learnings table
  F7 (Save Task) -- requires tasks table
  F20 (Migration) -- requires all new tables

Phase 2 (Context Engineering)
  F2 (Search Memory) -- requires temporal decay in HybridSearchEngine
  F4 (Token-Budget Retrieval) -- requires token counter + budget allocator
  F15 (Memory Compression) -- requires Digest->Essence tier

Phase 3 (Agent Identity)
  F8 (Register Agent) -- requires agent_profiles table
  F9 (Record Correction) -- requires agent_corrections table
  F10 (Session Start) -- requires profile loading
  F17 (Causal Query) -- requires Neo4j causal edges

Phase 4 (Eval Suite)
  F18 (Eval Run) -- requires frozen dataset + all metrics
  F19 (Improvement Loop) -- requires longitudinal tracking

Phase 5 (Multi-Client)
  F14 (Cross-Project) -- requires ACL model
  F16 (Config Generate) -- requires client templates

Phase 6 (Self-Improvement)
  F19 (Improvement Loop) -- requires canary evaluation + human gate
```

---

## 6. Data Volume Estimates

| Data Type | Current Volume | Projected 6-Month Volume | Storage Strategy |
|-----------|---------------|--------------------------|-----------------|
| Memories | ~500-1000 (events) | ~5,000-10,000 | SQLite memories table + Qdrant vectors |
| Decisions | ~770 (JSONL) | ~1,500 | SQLite decisions table |
| Learnings | ~100 (files) | ~500 | SQLite learnings table + FTS5 |
| Tasks | ~182 (files) | ~1,000 | SQLite tasks table |
| Agent Profiles | ~3-5 | ~10-20 | SQLite agent_profiles |
| Agent Corrections | ~0 | ~200-500 | SQLite agent_corrections |
| Code Chunks | ~50,000+ | ~200,000+ | SQLite code_chunks + Qdrant |
| Events | ~5,000+ | ~50,000+ | SQLite events (append-only) |
| Eval Scores | ~0 | ~365 (daily) | SQLite eval_scores |
| Compression Audit | ~0 | ~1,000-5,000 | SQLite compression_audit_log |

---

## 7. Summary

- **20 distinct flows** identified, spanning core CRUD, search, ingestion, diagnostics, agent identity, eval, and CLI operations
- **16 edge cases** analyzed with mitigations
- **10 missing flows** identified (GC, migration CLI, export, conflict UI, health, audit, schema management, re-index, profile sync, rate limiting)
- **12 critical questions** that must be answered in the implementation plan
