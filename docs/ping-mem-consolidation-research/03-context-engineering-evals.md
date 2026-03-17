# Context Engineering & Evaluation Frameworks for AI Agent Memory Systems

**Research Date**: 2026-03-17
**Scope**: Token-budget-aware retrieval, hierarchical summarization, temporal relevance decay, cross-project awareness, eval frameworks, self-improvement evaluation, agent continuity metrics, innovation dimensions for ping-mem

---

## Table of Contents

1. [Token-Budget-Aware Retrieval](#1-token-budget-aware-retrieval)
2. [Hierarchical Summarization for Memory](#2-hierarchical-summarization-for-memory)
3. [Temporal Relevance Decay](#3-temporal-relevance-decay)
4. [Cross-Project Awareness](#4-cross-project-awareness)
5. [Standard Metrics for Memory/Retrieval Systems](#5-standard-metrics-for-memoryretrieval-systems)
6. [Self-Improvement Evaluation](#6-self-improvement-evaluation)
7. [Agent Continuity Metrics](#7-agent-continuity-metrics)
8. [Innovative Eval Dimensions (Beyond mem0)](#8-innovative-eval-dimensions-beyond-mem0)
9. [What Would Make ping-mem 10-20% Better Than mem0](#9-what-would-make-ping-mem-10-20-better-than-mem0)
10. [Sources](#10-sources)

---

## 1. Token-Budget-Aware Retrieval

### 1.1 The Core Problem: Context Rot

Research from "Lost in the Middle" (Liu et al., TACL 2024) demonstrated that LLMs exhibit a **U-shaped performance curve** -- they attend well to information at the beginning and end of the context window but lose accuracy for information placed in the middle. Performance degrades further as context windows grow, even for models explicitly trained on long contexts. This phenomenon, called **context rot**, stems from the transformer architecture's O(n^2) pairwise token attention, creating natural tension between context size and focus.

**Implication for ping-mem**: When surfacing memories into an agent's context, placement order matters. High-relevance memories should occupy the beginning or end positions, not the middle.

### 1.2 Priority Ordering Frameworks

Anthropic's context engineering guide (June 2025) establishes a priority hierarchy for what enters the context window:

```
Current task > Tools > Retrieved docs > Memory > History
```

Key principles:
- **Measure before optimizing**: Use a context budget calculator to quantify how much space each component consumes
- **Prune history** if token count exceeds 50% of context window -- summarize or truncate
- **Use a reranker** after initial retrieval; include only top 3-5 documents to avoid wasting tokens on marginal content
- **Minimum Viable Context**: Cache stable instructions, retrieve only what is needed; this cuts token usage, improves latency, and often improves quality simultaneously

### 1.3 Just-in-Time Context Loading

Rather than pre-loading all potentially relevant data, production systems maintain **lightweight identifiers** (file paths, stored queries, web links) and dynamically load data into context at runtime using tools. This mirrors human cognition -- leveraging external organization systems rather than memorizing everything.

**How Anthropic implements this**: Claude Code loads CLAUDE.md files upfront (high-frequency stable data) but uses tools like `glob` and `grep` for just-in-time discovery, avoiding stale indexing issues. This is a hybrid approach -- some data is "always-on" and some is "on-demand."

### 1.4 Context Editing and Compaction

Two complementary techniques for long-running agents:

**Context Editing**: Automatically clear stale tool calls and results from within the context window when approaching token limits. This preserves conversation flow while extending effective runtime.

**Compaction**: When approaching the context limit, summarize the conversation and reinitiate a fresh context with the summary. This is the "first lever" in context engineering for long-term coherence. Best practice: preserve architectural decisions and critical state while discarding verbose tool outputs.

### 1.5 Sub-Agent Architecture

Specialized sub-agents handle focused tasks with clean, narrow context windows. They explore extensively but return condensed 1,000-2,000 token summaries to the orchestrator. The lead agent synthesizes results without managing all detailed search context. This pattern is directly applicable to ping-mem's multi-agent coordination use case.

### 1.6 Implications for ping-mem

| Technique | Current ping-mem Status | Recommendation |
|-----------|------------------------|----------------|
| Priority ordering | Not implemented | Add token budget allocator to memory retrieval |
| Position-aware placement | Not implemented | Place high-relevance results at context edges |
| Just-in-time loading | Partial (MCP tools) | Add lazy-loading identifiers to memory entries |
| Compaction | SemanticCompressor exists | Extend to conversation-level compaction |
| Context editing | Not implemented | Add stale-result pruning to REST responses |

---

## 2. Hierarchical Summarization for Memory

### 2.1 Three-Tier Memory Architecture

Production memory systems converge on a three-tier model:

| Tier | Content | Retention | Token Cost |
|------|---------|-----------|------------|
| **Raw / Episodic** | Verbatim conversation turns, exact code snippets, timestamps | Short-term (recent sessions) | High |
| **Digest / Semantic** | Compressed summaries, extracted facts, key decisions | Medium-term (weeks/months) | Medium |
| **Essence / Core** | Core truths, invariant patterns, identity facts | Long-term (permanent) | Low |

### 2.2 How mem0 Handles Compression

Mem0 uses a two-phase processing approach:
1. **Extraction phase**: Process messages and historical context to create new memories
2. **Update phase**: Evaluate extracted memories against similar existing ones, applying appropriate operations (add, update, merge, delete) through a Tool Call mechanism

Results: Mem0 claims **80-90% token reduction** while maintaining context fidelity, with 91% lower p95 latency vs. full-context baselines.

### 2.3 MapReduce vs. Incremental Compression

**MapReduce summarization**: Chunk inputs, summarize each chunk independently, recursively merge summaries into higher-level summaries. Used for extremely long documents. Drawback: context fragmentation -- cross-chunk relationships can be lost.

**Incremental compression** (ping-mem's current approach via SemanticCompressor): Process memories in batches, compress into digest facts, maintain provenance. Advantages: lower latency per operation, can run continuously. Drawback: order-dependent -- results may vary based on which memories are batched together.

**KVzip** (2025): A KV-cache compression technique achieving 3-4x compression of conversation memory while maintaining accuracy and doubling response speed. Operates at the attention layer rather than the text layer.

### 2.4 The "Summarization Drift" Problem

**Critical finding**: Each compression pass silently discards low-frequency details. After enough passes, the agent "remembers" a sanitized, generic version of history -- precisely the kind of memory that fails on edge cases. This is called **summarization drift**.

Mitigation strategies:
- **Anchor facts**: Maintain a set of immutable facts that survive all compression passes
- **Lossy vs. lossless tiers**: Keep raw memories in cold storage, only compress the working set
- **Compression audit trail**: Track what information was discarded at each pass (ping-mem's provenance model supports this)
- **Strategic forgetting**: MemGPT treats information loss not as a failure but as a feature -- explicitly choosing what to forget via policy

### 2.5 Information Loss at Each Tier

Estimated information preservation based on research:

| Transition | Compression Ratio | Information Preserved | Primary Loss |
|-----------|-------------------|----------------------|--------------|
| Raw -> Digest | 3-5x | ~70-85% | Verbatim phrasing, minor details, redundancy |
| Digest -> Essence | 5-10x | ~40-60% | Temporal ordering, edge cases, context nuance |
| End-to-end | 15-50x | ~30-50% | Most episodic detail; retains core decisions and patterns |

### 2.6 ping-mem Current State

ping-mem's `SemanticCompressor` implements the Raw -> Digest transition with both LLM-based and heuristic modes. The `memory_compress` MCP tool exposes this. Missing: the Digest -> Essence tier, compression audit trails, and anchor-fact policies.

---

## 3. Temporal Relevance Decay

### 3.1 Decay Models

Three primary approaches in the literature:

**Exponential Decay**:
```
relevance(t) = base_score * e^(-λ * age_hours)
```
- Simple, well-understood. Typical λ values: 0.001-0.01 (slow decay) to 0.1 (aggressive)
- Problem: Treats all memories identically regardless of source quality or access patterns
- Production example: Memory decay scores decrease hourly by factor 0.995

**Step-Function Decay**:
```
relevance(t) = base_score * tier_weight(age_bucket)
```
- Memories in "hot" (< 1 day), "warm" (1-7 days), "cold" (> 7 days) buckets
- More predictable than exponential; easier to reason about
- Problem: Sharp transitions at bucket boundaries

**Attention-Based / Access-Weighted Decay**:
```
relevance(t) = base_score * e^(-λ * age) * (1 + α * access_count) * source_quality
```
- Frequently accessed memories decay more slowly (mimics human memory consolidation through rehearsal)
- High-quality sources (explicit decisions, commit messages) decay slower than incidental observations
- Most sophisticated; requires tracking access patterns

### 3.2 Cognitive Science Parallels

Human memory research identifies two key principles:
- **Spacing effect**: Memories accessed at increasing intervals are retained longer
- **Consolidation**: During idle periods (sleep), the brain reorganizes episodic memories into semantic abstractions

These suggest that AI memory systems should:
- Track access frequency and spacing, not just recency
- Run offline consolidation processes during idle periods (ping-mem's nightly improvement loop is aligned with this)

### 3.3 Weighting Recent Decisions vs. Old Ones

Research consensus: **Recent decisions should be heavily weighted, but "landmark" decisions should resist decay.**

Practical policy:
- Decisions tagged as `architecture`, `breaking_change`, or `contract` get a decay floor (never drop below 0.5 relevance)
- Decisions tagged as `tactical` or `debugging` decay normally
- Cross-project decisions get elevated baseline (they affect more downstream systems)

### 3.4 ping-mem Current State

ping-mem currently uses **no temporal decay** in retrieval. Qdrant vector search and BM25/FTS5 hybrid search rank purely by similarity score. The `codebase_timeline` tool provides temporal ordering but does not weight by recency. This is a clear gap.

**Recommendation**: Implement attention-based decay as a re-ranking factor in `HybridSearchEngine`, combining similarity score with temporal decay and access frequency.

---

## 4. Cross-Project Awareness

### 4.1 The Challenge

When working on project A, relevant context from project B may be critical (shared libraries, API contracts, design decisions that propagate). The challenge: surface this context without leaking private information from isolated projects.

### 4.2 Graph-Based Approaches

**Neo4j entity linking**: Projects share entities (function names, API endpoints, data models) that can be linked across project graphs. When querying project A, the graph can traverse to project B if shared entities exist.

**Zep/Graphiti's approach**: Temporal knowledge graphs with entities as nodes and relationships as edges. Cross-project links are explicit edges with provenance and temporal validity.

**Scope**: Extracts entities, relationships, endpoints, and conventions from codebases. Frontend agents can pull backend entities and API contracts from other projects -- "codebases talking to each other through Scope."

### 4.3 Vector Similarity Across Project Boundaries

Simple approach: Query Qdrant across all project collections simultaneously, then filter/rerank results. This is what ping-mem's `codebase_search` already supports with the `projectId` filter parameter.

Advanced approach: **Project-aware embedding spaces** -- train or fine-tune embeddings that place semantically similar cross-project concepts closer together. However, ping-mem uses deterministic hash-based vectors, making this inapplicable without switching to ML embeddings.

### 4.4 Privacy/Isolation Considerations

| Model | Description | Trade-off |
|-------|-------------|-----------|
| **Full isolation** | Each project is a separate Qdrant collection + Neo4j subgraph | Maximum privacy, zero cross-project awareness |
| **Read-only cross-query** | Query across projects but never write cross-project memories | Good balance; requires ACL on collections |
| **Explicit linking** | Projects opt-in to share specific entities/facts | Fine-grained control but high maintenance |
| **Tag-based isolation** | Tag-based multi-tenancy within shared collections | Flexible but relies on correct tagging |

**FalkorDB model**: Native multi-tenancy with strict graph isolation, supporting 10,000+ isolated graph instances while maintaining tenant boundaries. Apply tags to files, vectors, and knowledge graph entities to create named contexts.

### 4.5 ping-mem Current State

ping-mem already has:
- Path-independent projectId (`SHA-256(remoteUrl + "::" + relativeToGitRoot)`)
- Per-project Qdrant vectors with projectId metadata
- Neo4j temporal code graph with project nodes
- `knowledge_search` with `crossProject` flag
- Registered projects list (`~/.ping-mem/registered-projects.txt`)

**Gap**: No ACL model for cross-project queries. No explicit entity linking between projects. No privacy policy enforcement. The `crossProject: true` flag is all-or-nothing.

---

## 5. Standard Metrics for Memory/Retrieval Systems

### 5.1 MTEB (Massive Text Embedding Benchmark)

MTEB is the standard benchmark for text embedding models, with subtasks relevant to memory systems:

| Task | Main Metric | Relevance to Memory |
|------|------------|-------------------|
| **Retrieval** | NDCG@10 | Core memory recall quality |
| **Reranking** | MAP@K | Memory result ordering after initial retrieval |
| **Clustering** | V-Measure | Grouping related memories |
| **Classification** | Accuracy | Memory type/category prediction |
| **STS (Semantic Textual Similarity)** | Spearman correlation | Quality of similarity judgments |

Note: MTEB tests embedding models, not end-to-end memory systems. For ping-mem's deterministic hash-based vectors, MTEB is not directly applicable. But its metric choices inform what ping-mem should measure.

### 5.2 Core Retrieval Metrics

**Not rank-aware** (count-based):

| Metric | Formula | When to Use |
|--------|---------|------------|
| **Precision@K** | \|relevant ∩ retrieved[:k]\| / k | When accuracy of top results matters |
| **Recall@K** | \|relevant ∩ retrieved[:k]\| / \|relevant\| | When comprehensiveness matters |
| **F1@K** | Harmonic mean of Precision and Recall | Balanced measure |

**Rank-aware** (position-sensitive):

| Metric | Formula | When to Use |
|--------|---------|------------|
| **MRR@K** | 1 / rank_of_first_relevant | When finding *any* relevant result fast matters |
| **MAP@K** | Mean of precision at each relevant position | When all relevant positions matter |
| **NDCG@K** | DCG / IDCG (graded relevance) | When result ordering with graded relevance matters |

**ping-mem already implements**: `recallAtK`, `ndcgAtK`, `mrrAtK` in `src/eval/metrics.ts`. Missing: `precisionAtK`, `mapAtK`, `F1@K`.

### 5.3 LLM-as-Judge for Context Relevance

LLM-as-Judge is the most scalable method for evaluating retrieval quality when ground-truth labels are expensive. Key patterns:

**Binary relevance judging**: Ask an LLM "Is this retrieved memory relevant to the query? (yes/no)" for each result, then compute standard metrics.

**Graded relevance judging**: Ask "Rate relevance from 0-3" to compute NDCG with graded scores.

**QAG (Question-Answer Generation)**: Generate close-ended questions from the expected answer, then check if retrieved context can answer them. More reliable than open-ended judging.

**Specialized judge models**: Lynx and Glider are LLMs explicitly trained for evaluation tasks, outperforming generic LLMs at detecting hallucinations and irrelevance.

**ping-mem already has**: `LLMJudge` in `src/eval/llm-judge.ts` with primary/secondary relevance scoring and disagreement detection. This is well-aligned with best practices.

### 5.4 Measuring Information Preserved After Compression

No established benchmark exists for this. Proposed approach:

1. **Fact extraction**: Extract factual claims from pre-compression memories
2. **Fact verification**: Check which facts survive in post-compression output
3. **Fact importance weighting**: Weight facts by query relevance (some loss is acceptable for low-importance facts)
4. **Compression fidelity score**: Weighted fraction of facts preserved

```
fidelity = Σ(preserved_fact_i * importance_i) / Σ(total_fact_i * importance_i)
```

---

## 6. Self-Improvement Evaluation

### 6.1 Blue-Green Deployment for Memory Systems

ping-mem already has the architecture for this (`docker-compose.improvement.yml`, `scripts/nightly-improvement.sh`). The pattern:

1. **Blue (baseline)**: Current production memory configuration
2. **Green (candidate)**: Modified configuration (new retrieval weights, compression settings, etc.)
3. **Eval suite**: Run identical query sets against both, compare aggregate scores
4. **Promotion criterion**: Green must exceed Blue by a statistically significant margin on key metrics

Key insight: For memory systems specifically, the eval must test **cross-session continuity**, not just single-query retrieval. A system that retrieves individual facts well but loses narrative coherence across sessions is worse in practice.

### 6.2 A/B Testing Memory Quality

**Split-traffic approach**: Route 10% of agent sessions to the candidate memory configuration. Compare:
- Task completion rate (does the agent succeed more often?)
- Turn count to completion (does the agent need fewer interactions?)
- Contradiction rate (does the agent contradict itself less?)
- User satisfaction (if applicable)

**Offline approach** (more practical for ping-mem): Replay recorded sessions against both configurations, compare eval scores. This avoids the risk of degrading production agent performance.

### 6.3 Measuring "Does the System Get Better Over Time?"

**Longitudinal eval protocol**:
1. Maintain a frozen eval dataset (never changes)
2. Run eval weekly against the current system
3. Plot metrics over time
4. Regression = any metric dropping more than 2 standard deviations from the trailing mean

**Canary evaluation**: Before deploying a new memory configuration, run it against 5% of the eval set. If scores drop, abort deployment.

### 6.4 ping-mem Current State

ping-mem has `src/eval/improvement-loop.ts` implementing the blue-green eval loop, `src/eval/suite.ts` for running eval sets, and the nightly improvement script. This is ahead of most open-source memory systems. Gap: no longitudinal tracking of eval scores over time, no canary evaluation, no automated regression detection.

---

## 7. Agent Continuity Metrics

### 7.1 Cross-Session Continuity

**Definition**: Can an agent resume work after restart and maintain coherent state?

**MemoryArena benchmark finding**: Models with near-saturated performance on LoCoMo (single-session recall) drop to 40-60% on interdependent multi-session tasks. This is the most important gap in current memory systems.

**Proposed metric**: **Session Resume Score (SRS)**
1. End a session mid-task
2. Start a new session with only memory-retrieved context
3. Measure: task completion rate, number of redundant actions, contradictions with prior session
4. SRS = (task_completion * 0.5) + (1 - redundancy_rate * 0.25) + (1 - contradiction_rate * 0.25)

### 7.2 Contradiction Detection Accuracy

**Definition**: When the agent has been told conflicting facts, does the memory system detect the contradiction?

**Proposed eval**:
1. Inject memory pair: "We use PostgreSQL for the database" + "We use MongoDB for the database"
2. Query: "What database do we use?"
3. Measure: Does the system flag the contradiction? Does it use temporal ordering to resolve it?

**Current state of the art**: No production memory system reliably detects contradictions. Zep's temporal model with edge invalidation is the closest, using "event time" and "ingestion time" to track when facts were valid.

### 7.3 Identity Persistence

**Definition**: Does the agent remember who it is, what project it's working on, what its role is?

**CSNM (Cross-Session Narrative Memory)** proposes maintaining explicit **narrative and ethical invariants** -- facts about the agent's identity that never expire and are always loaded into context.

**Proposed eval**: After 50+ sessions, query the agent about its role, project context, and prior decisions. Measure accuracy against ground truth.

### 7.4 Decision Consistency

**Definition**: Does the agent make contradictory decisions across sessions?

**Proposed eval**:
1. In session 1: Agent decides "Use REST over GraphQL"
2. In session 5: Present the same decision point
3. Measure: Does the agent recall the prior decision and maintain consistency, or make a contradictory choice?

**MemoryAgentBench finding**: "No current system masters all four competencies" (retrieval, test-time learning, long-range understanding, selective forgetting). Decision consistency requires all four.

### 7.5 Benchmarks Comparison

| Benchmark | Year | Focus | Key Limitation |
|-----------|------|-------|---------------|
| **LoCoMo** | 2024 | Long conversational recall | Contexts fit in modern context windows; doesn't test real pressure |
| **MemBench** | 2025 | Factual + reflective memory | Single-mode evaluation |
| **MemoryAgentBench** | 2025 (ICLR 2026) | Four cognitive competencies | Incremental turns, not interdependent tasks |
| **MemoryArena** | 2026 | Multi-session interdependent tasks | Most realistic; shows 40-60% performance drop |

---

## 8. Innovative Eval Dimensions (Beyond mem0)

### 8.1 What mem0 Does NOT Measure

Based on analysis of mem0's evaluation framework (LoCoMo benchmark, LLM-as-Judge + F1 + BLEU-1):

| Dimension | mem0 Measures? | Why It Matters |
|-----------|---------------|----------------|
| Causal memory | No | Can the system explain *why* a decision was made? |
| Temporal point-in-time queries | No | What did the agent know at time T? |
| Impact prediction | No | If I change X, what memories become stale? |
| Learning propagation speed | No | How fast do insights spread across projects? |
| Compression fidelity | No | What information was lost during compression? |
| Cross-session task continuity | No | Can the agent resume mid-task after restart? |
| Contradiction detection | No | Does the system flag conflicting memories? |
| Selective forgetting quality | No | Can the system discard outdated info without breaking retrieval? |
| Cost efficiency | No | Are accuracy gains worth the latency/storage costs? |
| Codebase-aware retrieval | No | Can the system retrieve code context, not just text? |

### 8.2 Causal Memory Evaluation

**Definition**: Given a decision or outcome, can the memory system trace the causal chain back to the originating facts?

**Proposed eval**:
```
Input: "Why did we switch from Express to Hono?"
Expected: Chain of facts: [performance issue reported] -> [benchmark comparison done] -> [team decision made] -> [migration PR merged]
Metric: Causal chain completeness (fraction of ground-truth steps recovered)
```

ping-mem's explicit "why" extraction from commit messages (`Why:`, `Reason:`, `Fixes #`) is a foundation for this. The temporal code graph in Neo4j can trace commit -> change -> file chains.

### 8.3 Temporal Point-in-Time Queries

**Definition**: What was the state of knowledge at a specific past moment?

**Proposed eval**:
```
Input: "What was the API contract for /auth as of 2026-01-15?"
Expected: The specific version of the contract at that date, NOT the current version
Metric: Temporal accuracy (correct version retrieved vs. ground truth)
```

Zep's bi-temporal model (event time T, ingestion time T') directly supports this. ping-mem's `TemporalCodeGraph` has the structure but lacks a dedicated temporal-point query API.

### 8.4 Impact Prediction (Staleness Detection)

**Definition**: When a fact changes, what other memories become stale?

**Proposed eval**:
```
Input: Change "database port from 5432 to 5433"
Expected: Flag all memories referencing port 5432 as potentially stale
Metric: Staleness recall (fraction of affected memories identified) and precision (false positive rate)
```

This requires dependency tracking between memories -- something graph-based systems (Neo4j) can support but no current system implements well.

### 8.5 Learning Propagation Speed

**Definition**: When an insight is learned in project A, how quickly does it become available in project B?

**Proposed eval**:
```
Action: Record "pagination should use cursor-based approach" in project A
Measure: Time until project B's agent retrieves this when facing a pagination decision
Metric: Propagation latency (seconds from recording to cross-project retrieval)
```

### 8.6 Proposed Eval Metric Stack for ping-mem

**Layer 1: Retrieval Quality** (existing)
- Recall@10, NDCG@10, MRR@10
- LLM-as-Judge relevance scoring

**Layer 2: Memory Quality** (new)
- Contradiction detection rate
- Compression fidelity score
- Staleness detection recall/precision
- Temporal accuracy (point-in-time queries)

**Layer 3: Agent Continuity** (new)
- Session Resume Score (SRS)
- Decision consistency rate
- Identity persistence accuracy
- Causal chain completeness

**Layer 4: Efficiency** (new)
- Token cost per retrieval
- Latency p50/p95/p99
- Storage growth rate
- Compression ratio over time

**Layer 5: Cross-Project** (new)
- Learning propagation latency
- Cross-project retrieval precision
- Isolation violation rate (privacy leakage)

---

## 9. What Would Make ping-mem 10-20% Better Than mem0

### 9.1 Competitive Landscape Summary

| Capability | mem0 | Zep/Graphiti | MemGPT/Letta | A-Mem | ping-mem (current) |
|-----------|------|-------------|-------------|-------|-------------------|
| Code ingestion + search | No | No | No | No | **Yes** (Qdrant + BM25/FTS5) |
| Deterministic provenance | Partial | Yes (bitemporal) | No | No | **Yes** (SHA-256 IDs) |
| Graph memory | Yes (paid) | Yes (Neo4j) | No | Yes (Zettelkasten) | **Yes** (Neo4j temporal) |
| Multi-agent coordination | No | No | No | No | **Yes** (AgentRegistry + quotas) |
| Eval framework | LoCoMo | Deep Memory Retrieval | No | LoCoMo | **Yes** (Eval suite + LLM judge) |
| Self-improvement loop | No | No | No | No | **Yes** (Blue-green nightly) |
| Temporal code graph | No | Partial | No | No | **Yes** (Neo4j bi-temporal) |
| Hierarchical compression | Yes | Yes (episodic->semantic) | Yes (OS-inspired paging) | Yes (Zettelkasten linking) | **Partial** (SemanticCompressor) |
| Cross-project awareness | No | No | No | No | **Partial** (crossProject flag) |
| Diagnostics tracking | No | No | No | No | **Yes** (SARIF + symbol attribution) |

### 9.2 ping-mem's Unique Differentiators (Already Built)

1. **Codebase-aware memory**: No competitor ingests code with AST-level chunking, git history, and commit-message provenance. mem0 and Zep only handle conversational text.

2. **Deterministic provenance**: Every chunk, every vector, every graph node has a SHA-256 content-addressable ID. No other system offers bit-for-bit reproducible memory operations.

3. **Temporal code graph**: What code existed at time T, what changed, and why (from commit messages). Zep has temporal graphs for conversations but not code.

4. **Multi-agent coordination**: AgentRegistry with quotas, TTL, and deregistration. No competitor provides agent identity management.

5. **Integrated eval + self-improvement**: Blue-green nightly improvement loop with LLM-as-Judge. No competitor has this built in.

6. **Diagnostics tracking**: SARIF ingestion, symbol-level attribution, cross-tool comparison. Entirely unique to ping-mem.

### 9.3 Gaps to Close for 10-20% Advantage

| Gap | Impact | Effort | Priority |
|-----|--------|--------|----------|
| **Token-budget-aware retrieval** | High -- directly improves agent performance | Medium | P0 |
| **Temporal relevance decay** | High -- prevents stale memory poisoning | Low | P0 |
| **Contradiction detection** | High -- unique differentiator | Medium | P1 |
| **Cross-project entity linking** | Medium -- enables multi-project agents | High | P1 |
| **Digest -> Essence compression tier** | Medium -- reduces long-term token costs | Medium | P1 |
| **MemoryArena-style eval** | Medium -- validates cross-session continuity | Medium | P2 |
| **Impact/staleness prediction** | Medium -- proactive memory maintenance | High | P2 |
| **Privacy ACL model** | Medium -- required for enterprise multi-project | Medium | P2 |
| **Access-frequency tracking** | Low -- improves decay model accuracy | Low | P3 |

### 9.4 Concrete Innovation Targets

**Innovation 1: Token-Budget-Aware Memory Surface**
- Accept a `tokenBudget` parameter in search/retrieval APIs
- Allocate budget across tiers: 60% direct matches, 25% related context, 15% cross-project
- Apply position-aware ordering (high relevance at edges)
- Return a structured response with budget accounting

**Innovation 2: Causal Memory Chains**
- Link decisions to their evidence in Neo4j: `(Decision)-[:CAUSED_BY]->(Evidence)`
- Support "why" queries: traverse causal graph to explain any decision
- Surface causal context when related topics are queried
- No competitor offers this -- it combines ping-mem's commit-message "why" extraction with graph traversal

**Innovation 3: Temporal Decay + Access Consolidation**
- Implement attention-based decay in `HybridSearchEngine`
- Track memory access patterns in SQLite
- Run nightly consolidation: frequently-accessed decaying memories get promoted to Essence tier
- Mirrors cognitive science's spacing effect and sleep consolidation

**Innovation 4: Cross-Project Entity Resolution**
- Extract shared entities across projects (API endpoints, data models, library versions)
- Create cross-project links in Neo4j with provenance
- Support scoped cross-project queries with privacy controls
- No competitor has this -- it leverages ping-mem's multi-project ingestion pipeline

**Innovation 5: Compression Audit Trail**
- Record what facts were preserved/discarded at each compression pass
- Support "compression diff" queries: what did we lose?
- Enable rollback to pre-compression state for specific memories
- Unique to ping-mem's deterministic, content-addressable storage model

### 9.5 Positioning Statement

**mem0** is a hosted memory platform optimized for conversational agents with graph memory as a paid add-on. **Zep** is a temporal knowledge graph for agent conversations. **ping-mem** is a self-hosted universal memory layer with codebase intelligence, deterministic provenance, temporal code graphs, integrated diagnostics, and a self-improving eval loop -- purpose-built for development-focused AI agents operating across multiple codebases.

The 10-20% advantage comes not from doing one thing better, but from the integration of capabilities that no single competitor combines: code awareness + temporal provenance + multi-project coordination + self-improvement.

---

## 10. Sources

### Academic Papers
- [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172) - Liu et al., TACL 2024
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413) - arXiv 2025
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956) - arXiv 2025
- [A-MEM: Agentic Memory for LLM Agents](https://arxiv.org/abs/2502.12110) - NeurIPS 2025
- [MemoryArena: Benchmarking Agent Memory in Interdependent Multi-Session Agentic Tasks](https://arxiv.org/abs/2602.16313) - arXiv 2026
- [Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers](https://arxiv.org/html/2603.07670) - arXiv 2026
- [Codified Context: Infrastructure for AI Agents in a Complex Codebase](https://arxiv.org/abs/2602.20478) - arXiv 2026
- [Memory in the Age of AI Agents: A Survey](https://arxiv.org/abs/2512.13564) - arXiv 2025
- [Cognitive Memory in Large Language Models](https://arxiv.org/html/2504.02441v1) - arXiv 2025
- [Evaluating Memory in LLM Agents via Incremental Multi-Turn Interactions (MemoryAgentBench)](https://arxiv.org/abs/2507.05257) - ICLR 2026

### Industry & Engineering
- [Effective Context Engineering for AI Agents - Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Managing Context on the Claude Developer Platform - Anthropic](https://www.anthropic.com/news/context-management)
- [Building an Agentic Memory System for GitHub Copilot](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)
- [Context Engineering for AI Agents Guide - mem0](https://mem0.ai/blog/context-engineering-ai-agents-guide)
- [Graph Memory for AI Agents - mem0](https://mem0.ai/blog/graph-memory-solutions-ai-agents)
- [AI Memory Benchmark: Mem0 vs OpenAI vs LangMem vs MemGPT](https://mem0.ai/blog/benchmarked-openai-memory-vs-langmem-vs-memgpt-vs-mem0-for-long-term-memory-here-s-how-they-stacked-up)
- [Is Mem0 Really SOTA in Agent Memory? - Zep](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)
- [Cognee AI Memory Tools Evaluation](https://www.cognee.ai/blog/deep-dives/ai-memory-tools-evaluation)

### Benchmarks & Evaluation
- [MTEB: Massive Text Embedding Benchmark](https://github.com/embeddings-benchmark/mteb)
- [Retrieval Evaluation Metrics - Weaviate](https://weaviate.io/blog/retrieval-evaluation-metrics)
- [LLM-as-a-Judge: A Complete Guide - Evidently AI](https://www.evidentlyai.com/llm-guide/llm-as-a-judge)
- [RAG Evaluation: Metrics, Testing and Best Practices - Evidently AI](https://www.evidentlyai.com/llm-guide/rag-evaluation)
- [LLM-as-a-Judge Metrics - Confident AI](https://www.confident-ai.com/docs/llm-evaluation/core-concepts/llm-as-a-judge)
- [LLM-as-a-Judge Evaluation - Langfuse](https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge)

### Tools & Frameworks
- [Graphiti - Temporal Knowledge Graphs](https://github.com/getzep/graphiti)
- [A-Mem - Agentic Memory Framework](https://github.com/agiresearch/A-mem)
- [CASS Memory System - Procedural Memory for AI Coding Agents](https://github.com/Dicklesworthstone/cass_memory_system)
- [Scope - Context Engineering for AI Coding Agents](https://within-scope.com/)
- [Awesome Memory for Agents - Paper List](https://github.com/TsinghuaC3I/Awesome-Memory-for-Agents)
