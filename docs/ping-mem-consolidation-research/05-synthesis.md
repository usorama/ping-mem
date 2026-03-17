# 05 - Synthesis: Research-to-Implementation Bridge

**Date**: 2026-03-17
**Status**: Complete
**Inputs**: 01-competitive-analysis.md, 02-multi-client-config.md, 03-context-engineering-evals.md, 04-current-data-model-audit.md
**Purpose**: Unify all research findings into founding principles, measurable outcomes, architecture decisions, gap analysis, implementation phases, and deprecation timeline. This document is the bridge between research and the implementation plan.

---

## 1. Founding Principles (Non-Negotiable Constraints)

These principles are derived from the collective findings across all four research documents. Every implementation decision must satisfy all of them.

### P1: ping-mem Is the Single Read Authority for All Memory

All agent memory reads (decisions, learnings, tasks, corrections, context) go through ping-mem. File-based stores (`decisions.jsonl`, `~/.claude/learnings/`, `~/.claude/tasks/`) become write-ahead logs during transition, then are deprecated. No agent should read from files when ping-mem is available.

**Source**: 04-data-model-audit Section 4 (dual-write problems with decisions.jsonl, learnings files, task JSONs).

### P2: Every Memory Has Deterministic Provenance

Every stored memory carries: source agent ID, session ID, project ID, timestamp, and causal chain (`caused_by` event ID). No memory exists without attribution. Content-addressable IDs (SHA-256) for all deterministic content; UUIDv7 for time-ordered entities.

**Source**: 01-competitive-analysis (ping-mem's SHA-256 provenance is a unique differentiator vs mem0/Zep/Letta, all of which lack content-addressable IDs).

### P3: No LLM Call Required for Memory Read Operations

Search and retrieval must work without LLM inference. Hybrid search (BM25/FTS5 + Qdrant vector + Neo4j graph) operates on pre-computed indexes. LLM is optional for compression, summarization, and extraction -- never for reads. This is a critical advantage over mem0 (requires LLM for every `add()`) and Letta (requires LLM for every memory decision).

**Source**: 01-competitive-analysis Section "Weaknesses" for mem0 (LLM dependency for core operations) and Letta (agent overhead on every memory decision); 03-context-engineering Section 9.2 (ping-mem's LLM dependency is optional).

### P4: Token-Budget-Aware Retrieval Is a First-Class API

Every retrieval call accepts an optional `tokenBudget` parameter. ping-mem returns optimally ranked context that fits within the budget, applying position-aware ordering (high-relevance at context edges per "Lost in the Middle" research). The caller never has to truncate or re-rank.

**Source**: 03-context-engineering Section 1 (context rot, priority ordering, "Lost in the Middle" findings); Anthropic's context engineering guide (priority hierarchy: current task > tools > retrieved docs > memory > history).

### P5: Cross-Project Awareness Is Opt-In with Explicit Isolation Boundaries

Projects are isolated by default. Cross-project queries require explicit `crossProject: true` flags. A future ACL model will gate cross-project access by project pair. No implicit leakage of project-scoped memories into other projects' results.

**Source**: 03-context-engineering Section 4 (four isolation tiers: full isolation, read-only cross-query, explicit linking, tag-based); 04-data-model-audit (current `crossProject` flag is all-or-nothing -- needs refinement).

### P6: Self-Improvement Changes Are Gated by Eval Regression Tests

No memory configuration change (retrieval weights, compression settings, decay parameters) ships to production unless the eval suite confirms no regression. The blue-green improvement loop runs nightly; promotion requires statistically significant improvement on the frozen eval dataset.

**Source**: 03-context-engineering Section 6 (longitudinal eval protocol, canary evaluation, regression detection); 01-competitive-analysis (ping-mem's eval loop is more sophisticated than any competitor -- must protect this advantage).

### P7: File-Based Fallbacks Stay for 3 Months; Removal Gated on Dashboard Metrics

During consolidation, file-based stores (`decisions.jsonl`, `~/.claude/learnings/`, `~/.claude/tasks/`, `~/.claude/memory/`) continue to receive writes (dual-write mode). After 3 months, removal requires: (a) zero file reads logged for 30 consecutive days, (b) ping-mem retrieval precision >= file-based retrieval precision, (c) user explicit approval.

**Source**: User requirement (explicit 3-month timeline for file fallback retention).

### P8: Every Client Gets Identical Intelligence via the Same API

Claude Code, Codex CLI, Cursor, VS Code Copilot, Continue, Cline, Windsurf, and OpenCode all connect to the same ping-mem MCP server and receive identical tool sets, search quality, and memory intelligence. No client gets a degraded or enhanced experience. stdio transport is the universal baseline.

**Source**: 02-multi-client-config (all 8 clients support stdio; config format varies but tool surface is identical via `tools/list`).

### P9: Temporal Relevance Decay Is Applied to All Retrieval

Memories decay in relevance over time using an attention-based model: `relevance(t) = base_score * e^(-lambda * age) * (1 + alpha * access_count) * source_quality_weight`. Landmark decisions (architecture, breaking changes, contracts) have a decay floor of 0.5. This prevents stale memory poisoning without losing important context.

**Source**: 03-context-engineering Section 3 (three decay models analyzed; attention-based recommended); cognitive science parallels (spacing effect, consolidation during idle periods).

### P10: Consolidation Targets 2 Databases, Not 1

The main store (`~/.ping-mem/ping-mem.db`) holds all tables except diagnostics. Diagnostics stays in `~/.ping-mem/diagnostics.db` due to raw SARIF blob sizes and WAL contention risks. Admin tables merge into the main store (3 tiny tables do not justify a separate DB).

**Source**: 04-data-model-audit Section 6 (rationale for 2-database target, SARIF size concerns, admin tables too small for separate DB).

### P11: Codebase Intelligence Is the Defensible Moat

No competitor (mem0, Zep, Letta, A-MEM) offers code ingestion, git DAG extraction, AST-level chunking, temporal code graphs, or SARIF diagnostics. Every consolidation decision must preserve and strengthen this advantage. General-purpose memory features are table-stakes; codebase intelligence is the differentiator.

**Source**: 01-competitive-analysis comparison matrix (18 dimensions; codebase intelligence, diagnostics, and cross-project awareness are unique to ping-mem across all competitors).

### P12: Compression Preserves Provenance and Supports Rollback

Every compression pass records what facts were preserved and what was discarded. The raw tier is never deleted -- only moved to cold storage. Any compressed memory can be traced back to its source events via the immutable EventStore. Summarization drift is mitigated by anchor facts that survive all compression passes.

**Source**: 03-context-engineering Section 2 (summarization drift problem, anchor facts, lossy vs lossless tiers, compression audit trail); 04-data-model-audit (`compression_tier` field in proposed `memories` table).

---

## 2. Measurable Outcomes

| # | Metric | Baseline (Current) | Target | How Measured |
|---|--------|-------------------|--------|--------------|
| 1 | **Retrieval Precision@10** | Not measured | >= 0.75 | Eval suite: frozen query set, LLM-as-Judge binary relevance scoring per result |
| 2 | **Retrieval Recall@10** | Implemented in `src/eval/metrics.ts` but no baseline recorded | >= 0.80 | Eval suite: `recallAtK` against ground-truth relevant set |
| 3 | **MRR@10** | Implemented, no baseline | >= 0.70 | Eval suite: `mrrAtK` -- rank of first relevant result |
| 4 | **NDCG@10** | Implemented, no baseline | >= 0.75 | Eval suite: `ndcgAtK` with graded relevance from LLM-as-Judge |
| 5 | **Tokens per Useful Fact** | Not measured (no token budget API) | <= 150 tokens/fact | New metric: total tokens returned / count of LLM-judged-relevant facts |
| 6 | **Search Latency p50** | Not measured | <= 100ms | Instrumented in HybridSearchEngine; percentile tracking over eval queries |
| 7 | **Search Latency p95** | Not measured | <= 500ms | Same as above, 95th percentile |
| 8 | **Session Resume Score (SRS)** | Not measured | >= 0.70 | New eval: end session mid-task, resume with only memory-retrieved context, measure completion + redundancy + contradiction rates |
| 9 | **Contradiction Detection Accuracy** | 0% (not implemented) | >= 0.80 | New eval: inject contradictory fact pairs, measure detection rate |
| 10 | **Compression Fidelity (Raw->Digest)** | Not measured | >= 0.75 | New eval: extract facts pre/post compression, compute weighted preservation ratio |
| 11 | **Self-Improvement Delta** | No longitudinal tracking | Positive trend over 4 consecutive weekly evals | Nightly eval scores plotted over time; regression = any metric dropping >2 std dev from trailing mean |
| 12 | **Client Coverage** | 1 (Claude Code only) | >= 6 of 8 IDEs configured | Count of clients with verified working ping-mem MCP config |
| 13 | **Database Count** | 3 (events.db, diagnostics.db, admin.db) | 2 (ping-mem.db, diagnostics.db) | Admin merged into main; verified by connection count in runtime.ts |
| 14 | **Memory Completeness (dual-write parity)** | Unknown | 100% of file-written data also in ping-mem | Audit script: diff file-based stores against ping-mem tables weekly |
| 15 | **Cross-Project Retrieval Precision** | Not measured (crossProject flag exists but untested) | >= 0.65 | New eval: query project A for facts stored in project B, measure relevance |
| 16 | **Temporal Accuracy (point-in-time)** | Not measured (TemporalCodeGraph has structure but no query API) | >= 0.80 | New eval: query "state at time T", compare against git-verified ground truth |
| 17 | **Learning Propagation Latency** | Not measured | <= 60 seconds | New eval: record learning in project A, measure time until retrievable in project B |
| 18 | **Causal Chain Completeness** | Not measured (commit "why" extraction exists but no chain traversal) | >= 0.60 | New eval: query "why did X happen?", measure fraction of ground-truth causal steps recovered |
| 19 | **Staleness Detection Recall** | 0% (not implemented) | >= 0.70 | New eval: change a fact, measure fraction of dependent memories flagged as stale |
| 20 | **Isolation Violation Rate** | Not measured | 0% (zero privacy leaks) | New eval: query with crossProject=false, verify zero results from other projects |

---

## 3. Architecture Decision Records (ADRs)

### ADR-1: Embedding Chain -- Ollama (local) -> Gemini -> OpenAI

**Decision**: Use a tiered embedding provider chain. Local Ollama for development (free, fast, private). Gemini for production (cost-effective, good quality). OpenAI as premium fallback (highest quality, highest cost).

**Rationale**: ping-mem currently uses DeterministicVectorizer (hash-based, no ML) for code chunks and optional OpenAI for memory vectors (01-competitive-analysis, Section on DeterministicVectorizer). The hash-based approach gives deterministic provenance (Principle P2) but cannot compete with ML embeddings on semantic similarity (03-context-engineering, Section 5.1 -- MTEB benchmark is inapplicable to hash vectors). The tiered chain preserves local-first development (no API key needed) while enabling production-quality search.

**Alternatives Considered**:
- Hash-only (current): Deterministic but poor semantic quality. Fails P4 (token-budget-aware retrieval needs quality ranking).
- OpenAI-only: Best quality but expensive ($0.13/1M tokens), creates hard dependency. Violates P3 (LLM-free reads) if embedding API is down.
- Single local model: Quality ceiling too low for production.

**Risk**: Embedding chain adds complexity. Different models produce different vector spaces -- vectors from Ollama and OpenAI are not interchangeable. Mitigation: re-embed on provider change (batch job), store provider ID as metadata.

---

### ADR-2: File-Based Fallbacks Retained for 3 Months

**Decision**: Maintain dual-write to both ping-mem and file-based stores for 3 months. File reads continue as fallback. Removal gated on dashboard metrics (see Principle P7).

**Rationale**: 04-data-model-audit identifies 4 file-based stores that must be migrated: `decisions.jsonl` (~770 entries), `~/.claude/learnings/` (~50-100 learnings), `~/.claude/tasks/` (~182 task files), and `~/.claude/memory/` (hierarchical markdown). Abrupt cutover risks data loss. The 3-month window provides time to validate ping-mem's retrieval quality matches or exceeds file-based access.

**Alternatives Considered**:
- Immediate cutover: Faster but risky. If ping-mem retrieval has gaps, agents lose context.
- 6-month transition: Too conservative. Dual-write maintenance burden grows.
- No migration (keep files forever): Violates Principle P1 (single read authority). Dual-read paths cause inconsistency.

**Risk**: Dual-write bugs where data reaches one store but not the other. Mitigation: write-through middleware with sync-check audit (weekly diff script).

---

### ADR-3: Add 6 New Tables to Existing Main DB (Not a New DB)

**Decision**: Add `memories`, `tasks`, `decisions`, `learnings` (with FTS5), `agent_profiles`, and `agent_corrections` tables to the main ping-mem.db. Merge admin.db tables into main. Keep diagnostics.db separate.

**Rationale**: 04-data-model-audit Section 6 establishes that the current 3-database architecture (events.db, diagnostics.db, admin.db) should consolidate to 2. The admin tables are tiny (3 tables, singleton-or-few rows). Diagnostics stays separate due to raw SARIF blob sizes causing WAL contention. The 6 new tables add structured access to data currently buried in event payloads (memories), files (decisions, learnings, tasks), or missing entirely (agent profiles, corrections).

**Alternatives Considered**:
- New separate DB per domain: Even more fragmentation. Already have 3 DBs -- adding more is the wrong direction.
- Single DB including diagnostics: SARIF blobs (multi-MB each) in a frequently-written DB causes VACUUM contention and WAL bloat.
- Keep events as only storage, add views: Event replay is too slow for direct key lookup. The `memories` table is a materialized view of event state.

**Risk**: Schema migration on a production database. Mitigation: SQLite `ALTER TABLE ADD COLUMN` is safe; new tables are additive (no existing schema changes). Migration script with rollback (keep events.db untouched as audit trail).

---

### ADR-4: Token-Budget-Aware Retrieval as New MCP Tool

**Decision**: Add a `context_retrieve` MCP tool that accepts `tokenBudget` (integer), `query` (string), and optional scoping parameters. Returns ranked results that fit within the budget, with position-aware ordering.

**Rationale**: 03-context-engineering Section 1 demonstrates that context rot (from "Lost in the Middle" research) degrades agent performance when irrelevant or poorly-ordered context fills the window. Anthropic's context engineering guide establishes the priority: current task > tools > retrieved docs > memory > history. No competitor offers token-budget-aware retrieval as a first-class API (01-competitive-analysis). This is a concrete innovation target (03-context-engineering Section 9.4, Innovation 1).

**Budget allocation strategy**:
- 60% direct semantic matches from query
- 25% related context (graph-adjacent facts, same-file code)
- 15% cross-project context (when enabled)

**Alternatives Considered**:
- Let caller manage budget: Current approach. Agents waste tokens on irrelevant context or miss important facts.
- Fixed-limit retrieval (top-K only): Does not account for varying result sizes. A top-10 of short facts uses fewer tokens than a top-10 of code blocks.
- LLM-based context assembly: Violates P3 (no LLM for reads). Also adds latency.

**Risk**: Token counting is approximate (depends on tokenizer). Mitigation: use tiktoken-compatible counter, round down by 10% safety margin.

---

### ADR-5: Attention-Based Temporal Relevance Decay

**Decision**: Implement attention-based decay: `relevance(t) = base_score * e^(-lambda * age_hours) * (1 + alpha * access_count) * source_quality_weight`. Landmark decisions (architecture, breaking_change, contract categories) have a decay floor of 0.5.

**Rationale**: 03-context-engineering Section 3 analyzes three decay models. Exponential is too simple (treats all memories identically). Step-function has sharp boundary artifacts. Attention-based incorporates access frequency (cognitive science's spacing effect) and source quality (explicit decisions are more durable than incidental observations). ping-mem currently has zero temporal decay -- pure similarity ranking (03-context-engineering Section 3.4).

**Parameters** (initial, tunable via self-improvement loop):
- `lambda`: 0.005 (slow decay; ~139 hours half-life)
- `alpha`: 0.1 (moderate access boost)
- Source quality weights: `decision=1.5`, `architecture=2.0`, `fact=1.0`, `observation=0.7`, `debugging=0.5`

**Alternatives Considered**:
- No decay (current): Stale memories poison context. A 6-month-old debugging note ranks equally with a recent architecture decision.
- Exponential only: Ignores access patterns. Frequently-referenced decisions decay as fast as one-off notes.
- LRU eviction: Binary (keep/evict) with no gradual relevance reduction.

**Risk**: Aggressive decay could drop important but rarely-accessed memories. Mitigation: decay floor for critical categories; access-count tracking promotes frequently-used memories; eval suite monitors for regression.

---

### ADR-6: Agent Identity in ping-mem (Profiles, Rules, Corrections)

**Decision**: Add `agent_profiles` and `agent_corrections` tables to store structured agent identity: capabilities, behavioral rules, preferences, soul values, and correction history. Agent identity persists across sessions and is loaded into context on session start.

**Rationale**: 04-data-model-audit Section 4.1 identifies that current `agent_quotas` stores only quota/TTL data with an unstructured `metadata` blob. 03-context-engineering Section 7.3 (Identity Persistence) and CSNM research show that agents need persistent narrative/ethical invariants. Letta's self-editing memory blocks (01-competitive-analysis, Letta section) demonstrate the value of agent self-concept, but ping-mem can offer this without LLM overhead by storing structured profiles.

**What goes in agent identity**:
- `agent_profiles.capabilities`: What tools/skills the agent has
- `agent_profiles.behavioral_rules`: Rules extracted from user corrections (e.g., "always use bun test, never vitest")
- `agent_profiles.preferences`: Communication style, output format preferences
- `agent_profiles.soul_values`: Core agent personality (persistent across all sessions)
- `agent_corrections`: History of user corrections with extracted learned rules

**Alternatives Considered**:
- Keep in metadata blob: Unstructured, unsearchable, no schema validation.
- External file (like CLAUDE.md): Already exists but is not agent-specific. CLAUDE.md is project-wide, not per-agent.
- Letta-style self-editing blocks: Requires LLM for every memory decision. Violates P3.

**Risk**: Over-engineering agent identity before there are multiple distinct agents. Mitigation: start with minimal schema, extend via JSON fields. The `agent_corrections` table provides immediate value for learning from user feedback.

---

### ADR-7: Eval Framework -- 5-Layer Metric Stack

**Decision**: Implement a 5-layer eval metric stack, extending beyond mem0's LoCoMo-based evaluation.

**Rationale**: 03-context-engineering Section 8.1 identifies 10 dimensions that mem0 does not measure (causal memory, temporal point-in-time, impact prediction, learning propagation, compression fidelity, cross-session continuity, contradiction detection, selective forgetting, cost efficiency, codebase-aware retrieval). 01-competitive-analysis confirms no competitor has a comprehensive eval framework. ping-mem's existing eval suite (`src/eval/`) provides Layer 1; Layers 2-5 are new.

**Layer Stack**:
| Layer | Metrics | Status |
|-------|---------|--------|
| 1. Retrieval Quality | Recall@10, NDCG@10, MRR@10, Precision@10, MAP@10 | Partially implemented |
| 2. Memory Quality | Contradiction detection rate, compression fidelity, staleness detection, temporal accuracy | New |
| 3. Agent Continuity | Session Resume Score, decision consistency, identity persistence, causal chain completeness | New |
| 4. Efficiency | Tokens/useful fact, latency p50/p95, storage growth rate, compression ratio | New |
| 5. Cross-Project | Learning propagation latency, cross-project precision, isolation violation rate | New |

**Alternatives Considered**:
- mem0's approach (LoCoMo + LLM-as-Judge + F1 + BLEU-1): Too narrow. Misses 10 critical dimensions.
- Zep's DMR benchmark only: Tests single-session accuracy, not cross-session continuity (MemoryArena shows 40-60% drop on multi-session tasks -- 03-context-engineering Section 7.1).
- No eval (ship and see): Violates P6. Unquantified quality is indistinguishable from no quality.

**Risk**: 5 layers with 20+ metrics is expensive to maintain. Mitigation: automate all evals in the nightly improvement loop; freeze the eval dataset (never changes); alert only on regressions.

---

### ADR-8: Self-Improvement Loop Architecture

**Decision**: Nightly automated cycle: baseline eval -> parameter mutation -> candidate eval -> statistical comparison -> promote or discard. Longitudinal score tracking with regression detection.

**Rationale**: 03-context-engineering Section 6 establishes the blue-green pattern, canary evaluation, and longitudinal protocol. ping-mem already has `src/eval/improvement-loop.ts`, `docker-compose.improvement.yml`, and `scripts/nightly-improvement.sh` (03-context-engineering Section 6.4). The gap is: no longitudinal tracking, no canary evaluation, no automated regression detection.

**Architecture**:
```
[Nightly Cron] -> [Baseline Eval (Blue)] -> [Mutate Parameters] -> [Candidate Eval (Green)]
                                                                          |
                                                                          v
                                                              [Statistical Test (p < 0.05)]
                                                                    |           |
                                                                  Pass        Fail
                                                                    |           |
                                                              [Promote]   [Discard]
                                                                    |
                                                              [Record Scores in longitudinal DB]
                                                              [Alert if regression detected]
```

**What can mutate**: Retrieval weights (BM25 vs vector vs graph ratio), temporal decay parameters (lambda, alpha), compression thresholds, re-ranking strategies.

**Alternatives Considered**:
- Manual tuning only: Does not scale. Human cannot evaluate 20 metrics nightly.
- RL-driven (MemPO style): Promising but premature. Requires substantial training data and reward signal design (01-competitive-analysis, academic research section on MemPO).
- No improvement loop: Stagnation. Competitors will eventually catch up on features where ping-mem leads.

**Risk**: Automated mutation could introduce subtle quality regressions that pass statistical tests but degrade specific use cases. Mitigation: canary evaluation (5% of eval set first), mandatory human review for parameter changes >20% from baseline.

---

### ADR-9: Cross-Project Isolation Model -- Read-Only Cross-Query (Tier 2)

**Decision**: Adopt Tier 2 isolation ("Read-only cross-query") from the 4-tier model in 03-context-engineering Section 4.4. Projects can query across boundaries when `crossProject: true` is set, but never write cross-project memories. Future: add ACL per project pair.

**Rationale**: The current implementation is Tier 2 in function (crossProject flag exists) but without access control (04-data-model-audit, missing ACL model). Full isolation (Tier 1) blocks the multi-project use case entirely. Explicit linking (Tier 3) is high-maintenance. Tag-based (Tier 4) risks accidental leakage.

**Future ACL model** (Phase 5):
```
NEW TABLE: project_access_rules
  rule_id TEXT PRIMARY KEY
  source_project_id TEXT NOT NULL
  target_project_id TEXT NOT NULL
  access_level TEXT NOT NULL  -- 'read', 'none'
  created_at TEXT NOT NULL
  UNIQUE(source_project_id, target_project_id)
```

**Alternatives Considered**:
- Full isolation (Tier 1): Blocks cross-project value entirely. ping-mem's multi-project awareness is a differentiator (01-competitive-analysis).
- Explicit linking (Tier 3): Too much maintenance overhead for the current user base.
- Tag-based (Tier 4): Relies on correct tagging; errors cause privacy leaks.

**Risk**: Cross-project queries may surface sensitive data from unrelated projects. Mitigation: explicit opt-in flag, future ACL, isolation violation rate metric (target: 0%).

---

### ADR-10: MCP stdio as Universal Transport, Streamable HTTP as Secondary

**Decision**: stdio is the primary transport for all local clients. Streamable HTTP at `/mcp` endpoint is the secondary transport for remote/shared servers. Deprecated HTTP+SSE is kept only for backward compatibility with existing deployments.

**Rationale**: 02-multi-client-config Section 9 transport matrix shows stdio is supported by all 8 documented clients (100% coverage). Streamable HTTP is supported by 6/8 clients. SSE is deprecated in the MCP spec but still used by some clients. The key insight: stdio requires zero network configuration, zero authentication for local use, and zero port conflicts.

**Windsurf caveat**: Uses `serverUrl` instead of `url` for HTTP -- document this in client-specific config templates.

**Alternatives Considered**:
- HTTP-only: Requires server process management, port allocation, authentication. More complex for local dev.
- SSE-only: Deprecated in spec. Will lose client support over time.
- Both equally: Confuses documentation. Need a clear primary recommendation.

**Risk**: stdio subprocess model means each client spawns its own ping-mem process. Multiple editors open = multiple processes. Mitigation: shared SQLite DB with WAL mode handles concurrent access; document single-server mode for resource-constrained environments.

---

## 4. Gap Analysis

### P0: Must Have for Consolidation to Work

| # | Gap | Current State | Target State | Resolution Phase |
|---|-----|--------------|-------------|-----------------|
| G1 | No structured `memories` table | Memories buried in event payloads; requires event replay for any lookup | Materialized `memories` table with direct key lookup, namespace scoping, TTL, access tracking | Phase 1 |
| G2 | 3 separate SQLite databases | events.db + diagnostics.db + admin.db with separate connections | 2 databases: ping-mem.db (main) + diagnostics.db | Phase 1 |
| G3 | No dual-write middleware | File-based stores and ping-mem are independent systems | Write-through layer: every write hits ping-mem first, then file fallback | Phase 1 |
| G4 | Event replay too slow for reads | Memory reads scan all MEMORY_SAVED/UPDATED/DELETED events | Materialized `memories` table is the read path; events are the audit trail | Phase 1 |
| G5 | No migration scripts | File data (decisions.jsonl, learnings/, tasks/) isolated from ping-mem | One-time migration scripts for each file store -> corresponding ping-mem table | Phase 1 |
| G6 | Shared Qdrant collection without namespace | Memory vectors and code chunk vectors in same collection, different dimensions | Namespace payload field (`memory` vs `code`) on all Qdrant points; filter in all queries | Phase 1 |

### P1: Needed for Competitive Parity with mem0

| # | Gap | Current State | Target State | Resolution Phase |
|---|-----|--------------|-------------|-----------------|
| G7 | No token-budget-aware retrieval | Caller assembles context manually; no budget allocation | `context_retrieve` MCP tool with `tokenBudget` parameter, priority ordering, position-aware placement | Phase 2 |
| G8 | No temporal relevance decay | Pure similarity ranking; stale memories rank equally with recent ones | Attention-based decay in HybridSearchEngine with category-aware decay floors | Phase 2 |
| G9 | No `decisions` table | Dual-write to decisions.jsonl and event store; no structured query | Dedicated `decisions` table with type, rationale, status, alternatives, supersession chain | Phase 1 |
| G10 | No `learnings` table with FTS5 | Learnings scattered across 11 domain JSON files and KnowledgeStore | Dedicated `learnings` table with domain, confidence, verification status, application context, FTS5 | Phase 1 |
| G11 | No `tasks` table | Tasks in ~182 Claude Code JSON files; no ping-mem awareness | Dedicated `tasks` table with status, ownership, dependencies, parent-child hierarchy | Phase 1 |
| G12 | No contradiction detection | No mechanism to detect or flag conflicting memories | Contradiction detector in memory write path; temporal ordering for resolution | Phase 3 |
| G13 | Digest->Essence compression tier missing | SemanticCompressor handles Raw->Digest only | Second compression tier: Digest->Essence with anchor facts and compression audit trail | Phase 2 |
| G14 | No eval baseline recorded | Eval metrics implemented but never run against a baseline dataset | Frozen eval dataset, baseline scores recorded, longitudinal tracking enabled | Phase 4 |
| G15 | Only 1 IDE configured | Claude Code only has working ping-mem MCP config | 6+ IDEs with verified configs (Claude Code, Cursor, VS Code Copilot, Codex, Windsurf, Continue) | Phase 5 |

### P2: Innovation Beyond Competitors

| # | Gap | Current State | Target State | Resolution Phase |
|---|-----|--------------|-------------|-----------------|
| G16 | No causal memory chains | Commit "why" extraction exists but no chain traversal API | Neo4j causal graph: `(Decision)-[:CAUSED_BY]->(Evidence)` with traversal query | Phase 3 |
| G17 | No agent identity persistence | agent_quotas has minimal registration; no profiles, rules, or corrections | `agent_profiles` + `agent_corrections` tables; identity loaded on session start | Phase 3 |
| G18 | No Session Resume Score eval | No cross-session continuity testing | MemoryArena-style eval: end mid-task, resume, measure completion/redundancy/contradiction | Phase 4 |
| G19 | No access-frequency tracking | No record of which memories are accessed and when | `access_count` + `last_accessed_at` on `memories` table; updated on every read | Phase 2 |
| G20 | No impact/staleness prediction | No mechanism to flag dependent memories when a source fact changes | Graph-based dependency traversal in Neo4j to identify stale downstream memories | Phase 3 |
| G21 | No longitudinal eval tracking | Nightly eval runs but scores not stored over time | Eval scores stored in SQLite with timestamp; regression detection on trailing mean | Phase 4 |
| G22 | No cross-project entity linking | Projects share Neo4j instance but no explicit entity links | Cross-project entity resolution: shared entities (API endpoints, data models) linked in Neo4j with provenance | Phase 5 |
| G23 | Two parallel Neo4j graph systems | TemporalCodeGraph and GraphManager use different schemas on same instance; no cross-referencing | Unified node identity: cross-reference `Entity{type:CODE_FILE}` with `File` nodes | Phase 5 |
| G24 | No `ping-mem config generate <client>` CLI | Users must manually adapt config for each IDE | CLI command that outputs correct config JSON/TOML/YAML for any supported client | Phase 5 |
| G25 | No compression audit trail | SemanticCompressor discards info silently; no record of what was lost | Compression log table recording preserved/discarded facts per pass with rollback support | Phase 2 |

---

## 5. Implementation Strategy

### Phase 1: Core Consolidation (Estimated: 2-3 weeks)

**Goal**: Establish ping-mem as the single structured store for all memory types. Create the foundation tables and migration infrastructure.

**Deliverables**:
- New tables: `memories`, `tasks`, `decisions`, `learnings` (with FTS5), in main ping-mem.db
- Merge admin.db tables into ping-mem.db
- Migration scripts: decisions.jsonl -> `decisions`, learnings/ -> `learnings`, tasks/ -> `tasks`, event replay -> `memories`
- Dual-write middleware: writes go to ping-mem first, then file fallback
- Qdrant namespace separation (add `namespace` payload field)
- New MCP tools: `memory_get` (direct key lookup), `decision_list`, `learning_search`

**Dependencies**: None (foundational)

**Key Risk**: Migration script correctness. The decisions.jsonl has ~770 entries with varied structure. Mitigation: dry-run mode that reports what would be migrated without writing; manual validation of 10% sample.

---

### Phase 2: Context Engineering (Estimated: 2-3 weeks)

**Goal**: Make ping-mem's retrieval token-budget-aware with temporal decay and position-aware ordering.

**Deliverables**:
- `context_retrieve` MCP tool with `tokenBudget` parameter
- Attention-based temporal decay in HybridSearchEngine
- Access-frequency tracking on `memories` table (increment on read)
- Digest->Essence compression tier in SemanticCompressor
- Compression audit trail table
- Position-aware result ordering (high-relevance at context edges)

**Dependencies**: Phase 1 (needs `memories` table with `access_count`, `last_accessed_at`, `compression_tier`)

**Key Risk**: Temporal decay parameters may be poorly tuned initially. Mitigation: self-improvement loop (Phase 4) will auto-tune; start with conservative lambda (slow decay).

---

### Phase 3: Agent Identity and Causal Memory (Estimated: 2 weeks)

**Goal**: Give agents persistent identity and enable causal reasoning over memory chains.

**Deliverables**:
- New tables: `agent_profiles`, `agent_corrections`
- MCP tools: `agent_profile_get`, `agent_profile_update`, `agent_correction_record`
- Contradiction detection in memory write path (compare new memory against existing with same key/topic)
- Causal memory chains in Neo4j: `(Decision)-[:CAUSED_BY]->(Evidence)` relationships
- MCP tool: `memory_explain_why` (traverse causal graph)
- Impact/staleness detection: when a memory changes, query Neo4j for dependent memories and flag

**Dependencies**: Phase 1 (needs `memories` table and structured decisions/learnings), Phase 2 (needs temporal decay for contradiction resolution)

**Key Risk**: Causal chain extraction requires well-structured commit messages and decision records. If source data is unstructured, chains will be sparse. Mitigation: enrich existing data during migration (Phase 1); provide guidance for structured commit messages.

---

### Phase 4: Eval Suite and Self-Improvement (Estimated: 2 weeks)

**Goal**: Establish baseline measurements across all 5 eval layers; enable automated regression detection.

**Deliverables**:
- Frozen eval dataset (50+ query-answer pairs with ground-truth relevant memories)
- Baseline scores recorded for all 20 metrics in Section 2
- Missing eval metrics implemented: Precision@10, MAP@10, F1@10, Session Resume Score, contradiction detection rate, compression fidelity, tokens/useful fact, latency percentiles
- Longitudinal eval score storage (SQLite table with timestamps)
- Regression detection: alert when any metric drops >2 std dev from trailing 4-week mean
- Canary evaluation: test 5% of eval set before full run
- Nightly improvement loop enhanced with longitudinal tracking and canary gates

**Dependencies**: Phase 2 (needs token-budget retrieval and temporal decay to measure), Phase 3 (needs contradiction detection and causal chains to evaluate)

**Key Risk**: Creating a representative frozen eval dataset is labor-intensive. Mitigation: semi-automated generation -- use existing memory data + LLM to generate query-answer pairs, then human-validate.

---

### Phase 5: Multi-Client Rollout and Cross-Project (Estimated: 1-2 weeks)

**Goal**: Configure ping-mem for all major AI IDEs; enhance cross-project intelligence.

**Deliverables**:
- Verified MCP configs for: Claude Code, Cursor, VS Code Copilot (native), Continue, Cline, Codex CLI, Windsurf (7 clients; Antigravity skipped until docs available)
- `ping-mem config generate <client>` CLI command
- Cross-project entity linking in Neo4j (shared entities identified and linked)
- Unified Neo4j node identity (cross-reference GraphManager Entity nodes with TemporalCodeGraph File nodes)
- Project access rules table (ACL for cross-project queries)
- Updated installation guide with per-client setup instructions

**Dependencies**: Phase 1 (needs consolidated DB), Phase 4 (needs eval to validate cross-project retrieval quality)

**Key Risk**: Client config formats change with IDE updates. Mitigation: version-pin config examples; integration test that validates each config template against client schema.

---

### Phase 6: Self-Improvement Loop Production Hardening (Estimated: 1 week)

**Goal**: Automate the full improvement cycle with production safeguards.

**Deliverables**:
- Automated nightly cron: baseline eval -> parameter mutation -> candidate eval -> statistical test -> promote/discard
- Mutation strategies: retrieval weight ratios, decay parameters, compression thresholds
- Statistical significance test (p < 0.05 on paired t-test across eval queries)
- Human review gate for parameter changes >20% from baseline
- Dashboard visualization of longitudinal eval trends (extend `/ui/eval`)
- Documentation of improvement loop for contributors

**Dependencies**: Phase 4 (needs eval suite and longitudinal tracking)

**Key Risk**: Automated mutation without sufficient guardrails could degrade production. Mitigation: canary evaluation (Phase 4), human review gate, automatic rollback on regression.

---

## 6. Deprecation Timeline

### Month 1-3: Dual-Write Mode

| Week | Action |
|------|--------|
| Week 1 | Deploy Phase 1 tables and migration scripts. Run migrations. Enable dual-write middleware. |
| Week 2 | Verify 100% write parity (audit script: diff file stores vs ping-mem tables). Fix any sync gaps. |
| Week 3-4 | Switch read path to ping-mem-first with file fallback. Log all file-fallback reads as telemetry events. |
| Week 5-8 | Monitor file-fallback read count. Target: declining trend toward zero. |
| Week 9-12 | If file-fallback reads reach zero for 14+ consecutive days, mark files as deprecated. If not, investigate which reads still hit files and fix the ping-mem retrieval gap. |

### Month 3+: File Fallback Removal

**Removal gating criteria** (ALL must be met):
1. Zero file-fallback reads logged for 30 consecutive days
2. ping-mem retrieval Precision@10 >= 0.75 (eval suite verified)
3. Memory Completeness metric = 100% (all file data exists in ping-mem)
4. User explicit approval (not automated)

**Removal sequence**:
1. `decisions.jsonl` -- replace with `decisions` table reads. Keep JSONL as read-only archive.
2. `~/.claude/learnings/` -- replace with `learnings` table reads. Keep files as read-only archive.
3. `~/.claude/tasks/` -- replace with `tasks` table reads. These are Claude Code internal; lowest risk.
4. `~/.claude/memory/` -- replace with `memories` table reads. Highest risk (most frequently accessed). Remove last.

### GitHub Issues to Create Now

| Issue Title | Milestone | Labels |
|-------------|-----------|--------|
| `feat: Add memories table with materialized state from events` | Phase 1 | `consolidation`, `P0` |
| `feat: Add decisions table and migrate decisions.jsonl` | Phase 1 | `consolidation`, `P1` |
| `feat: Add learnings table with FTS5 and migrate file-based learnings` | Phase 1 | `consolidation`, `P1` |
| `feat: Add tasks table and migrate Claude Code task files` | Phase 1 | `consolidation`, `P1` |
| `feat: Merge admin.db into main ping-mem.db` | Phase 1 | `consolidation`, `P2` |
| `feat: Qdrant namespace separation for memory vs code vectors` | Phase 1 | `consolidation`, `P2` |
| `feat: Dual-write middleware for file-based fallbacks` | Phase 1 | `consolidation`, `P0` |
| `feat: Token-budget-aware context_retrieve MCP tool` | Phase 2 | `context-engineering`, `P0` |
| `feat: Attention-based temporal relevance decay in HybridSearchEngine` | Phase 2 | `context-engineering`, `P0` |
| `feat: Digest-to-Essence compression tier with audit trail` | Phase 2 | `context-engineering`, `P1` |
| `feat: Agent profiles and corrections tables` | Phase 3 | `agent-identity`, `P2` |
| `feat: Contradiction detection in memory write path` | Phase 3 | `agent-identity`, `P1` |
| `feat: Causal memory chains in Neo4j` | Phase 3 | `agent-identity`, `P2` |
| `feat: Frozen eval dataset and baseline metric recording` | Phase 4 | `eval`, `P1` |
| `feat: Longitudinal eval score tracking with regression detection` | Phase 4 | `eval`, `P1` |
| `feat: Multi-client MCP config templates and generate CLI` | Phase 5 | `multi-client`, `P1` |
| `feat: Cross-project entity linking and ACL model` | Phase 5 | `cross-project`, `P2` |
| `chore: Deprecate decisions.jsonl file reads (month 3+ gate)` | Deprecation | `deprecation` |
| `chore: Deprecate ~/.claude/learnings/ file reads (month 3+ gate)` | Deprecation | `deprecation` |
| `chore: Deprecate ~/.claude/tasks/ file reads (month 3+ gate)` | Deprecation | `deprecation` |
| `chore: Deprecate ~/.claude/memory/ file reads (month 3+ gate)` | Deprecation | `deprecation` |

---

## References

- **01-competitive-analysis.md**: mem0 AUDN cycle, Zep bi-temporal model, Letta agent-as-OS, 18-dimension comparison matrix, unique differentiators, competitive weaknesses
- **02-multi-client-config.md**: 8 client configurations, transport support matrix, config format convergence, stdio universality, Windsurf serverUrl anomaly, per-client templates
- **03-context-engineering-evals.md**: Context rot ("Lost in the Middle"), token-budget retrieval, hierarchical summarization (3-tier), temporal decay models, cross-project isolation tiers, 5-layer eval stack, self-improvement protocol, Session Resume Score, contradiction detection, causal memory, 10 dimensions mem0 does not measure
- **04-current-data-model-audit.md**: 3 SQLite databases (events.db, diagnostics.db, admin.db), 2 Neo4j graph systems, shared Qdrant collection, 6 missing tables (memories, tasks, decisions, learnings, agent_profiles, agent_corrections), migration paths, consolidation to 2 databases
