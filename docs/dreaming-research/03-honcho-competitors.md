# Honcho, Competitors, and Memory System Research

**Date**: 2026-03-22
**Purpose**: Technical research on Honcho's dreaming process, competitor memory systems, and best practices for batch conversation processing.

---

## 1. Honcho Memory System

### 1.1 Architecture Overview

Honcho (by Plastic Labs) is an open-source memory library for building stateful AI agents. Unlike traditional vector-search memory systems ("store facts, retrieve facts, stuff into context"), Honcho treats **memory as reasoning** -- it doesn't retrieve what was said, it reasons about what it means.

Key architectural components:
- **Ingestion Pipeline**: Processes incoming messages, extracting explicit information in real-time
- **Dreaming Agent**: Asynchronous background tasks that consolidate, deduce, and reorganize memory
- **Neuromancer Model**: Custom fine-tuned model for extracting atomic conclusions from conversations
- **Representations**: Structured understanding of each "peer" (user, agent, or entity)
- **Dialectic Endpoint**: Natural language query interface for asking questions about peers

### 1.2 The Dreaming Process

**What it is**: Dreaming refers to agentic background tasks where the system crawls over everything known about a user and fills gaps while reorganizing data for efficient retrieval. The term is borrowed from the hypothesis that human dreams serve a similar consolidation purpose.

**What it produces**:
- Deductive conclusions (necessarily follow from explicit information)
- Inductive conclusions (pattern-based generalizations across interactions)
- Abductive conclusions (best-explanation hypotheses)
- Summaries of conversations and interactions
- Peer cards (structured profiles of users/agents)
- Hypotheses to test against new data

**What triggers it**: Dreams run **intermittently** as asynchronous background tasks, not continuously during ingestion. The documentation suggests these tasks "may very well be concentrated during evening hours, when users are sleeping and compute is less costly." The exact trigger mechanism is not publicly documented in detail, but the shift from Honcho 2 to Honcho 3 moved summarization and peer card generation from the ingestion pipeline into the dreaming system, making them periodic rather than continuous.

**Key design decision**: Honcho 3 separated the pipeline into two distinct phases:
1. **Ingestion** (synchronous, fast): Exhaustive explicit information capture only. Runs faster, cheaper, fully parallel with no bottlenecks.
2. **Dreaming** (asynchronous, deep): Handles all reasoning, deduction, summarization, and consolidation. Runs in background without impacting runtime performance.

This means summaries and peer cards won't be available for sessions/peers that haven't undergone a dreaming cycle yet.

### 1.3 The Neuromancer Model

**Neuromancer XR** is the first in a series of custom reasoning models:

- **Base model**: Qwen3-8B (compact open-source model)
- **Training**: Fine-tuned on ~10,000 manually curated instances of conclusion derivation -- memory-reasoning traces from conversational data
- **Two certainty levels extracted**:
  - **Explicit**: Information directly stated by a participant
  - **Deductive**: Certain conclusions that necessarily follow from explicit information
- **Requirements**: Conclusions must be atomic, self-contained, and include supporting premises and evidence
- **Performance**: 86.9% overall accuracy on LoCoMo benchmark, surpassing Claude 4 Sonnet (80.0%) and base Qwen3-8B (69.6%)
- **Eliminated failure modes**: Multi-fact conclusions, incomplete knowledge, speculative reasoning

**Neuromancer MR** (future): Will handle inductive and abductive reasoning, adding predictive dimensions to peer representations.

### 1.4 Contradiction Resolution

Honcho includes contradiction resolution as a benchmark category in their BEAM evaluations, but the specific technical mechanism is not publicly documented in detail. The dreaming process is described as pruning excess information and consolidating duplicated information, which implies contradiction handling occurs during the dreaming phase rather than at ingestion time.

### 1.5 Benchmarks and Performance

| Benchmark | Score | Notes |
|-----------|-------|-------|
| LongMem S | 90.4% | (92.6% with Gemini 3 Pro retrieval) |
| LoCoMo | 89.9% | vs 83.9% baseline |
| BEAM 100K | 0.630 | |
| BEAM 10M | 0.409 | vs prior SOTA of 0.266 |

**Token efficiency**: 11% on LongMem (~12,650 of 115,000 tokens), 0.5% on BEAM 10M.
**Cost**: ~$2/M tokens for ingestion, unlimited retrieval.

---

## 2. Competitor Memory Systems

### 2.1 Mem0

**Architecture**: Two-phase pipeline (Extraction + Update).

**Extraction Phase**:
- Ingests message pairs (m_t-1, m_t) with three context sources: latest exchange, rolling summary, and recent messages
- LLM-based function extracts candidate memories as compact natural-language facts
- Asynchronous summary generation module periodically refreshes conversation summary
- Config: m=10 previous messages for context, s=10 similar memories for comparison
- Default inference engine: GPT-4o-mini

**Update Phase**:
- Each extracted fact is compared to top-s similar entries in vector database
- LLM function-calling determines one of four operations:
  - **ADD**: New memory, no similar existing entry
  - **UPDATE**: Augment/modify existing memory
  - **DELETE**: Remove contradicted memory
  - **NOOP**: No change needed

**Mem0g (Graph-Enhanced Variant)**:
- Memories stored as directed labeled graphs G=(V,E,L)
- Two-stage extraction: Entity Extractor (nodes) + Relations Generator (edges/triplets)
- Conflict Detector flags overlapping or contradictory nodes/edges
- LLM-powered Update Resolver decides: add, merge, invalidate, or skip
- Invalid relationships are marked as invalid rather than physically removed (soft delete)

**Performance**:
- 26% higher accuracy vs OpenAI's memory
- 91% lower p95 latency (0.200s search time)
- 90% token savings (7k vs 26k tokens per conversation)
- Overall J score: 66.88% (Mem0), 68.44% (Mem0g)

**Key difference from Honcho**: Mem0 is primarily retrieval-focused (extract facts, store, retrieve). Honcho adds a reasoning layer that draws conclusions beyond what was explicitly stated.

### 2.2 Letta (MemGPT)

**Architecture**: OS-inspired two-tier memory system.

**Tier 1: In-Context (Main Context) -- analogous to RAM**:
- **Core Memory**: Always visible to the agent, embedded in system instructions
- Organized as named "blocks" (e.g., persona, human)
- Agents can read and write to core memory blocks
- Limited by context window size

**Tier 2: External Context (Out-of-Context) -- analogous to Disk**:
- **Archival Memory**: Vector DB table for long-running memories and external data
  - Agent can search and insert via function calls
  - Supports semantic search over stored content
- **Recall Memory**: Table logging all conversational history
  - Complete message history available for search
  - Agent can query past conversations

**How data moves between tiers**:
- Agents use **function calling** to manage their own context window
- Read/write to external data sources via tool calls
- Move data between core memory (RAM) and archival/recall memory (disk)
- Creates an "illusion of unlimited memory" within fixed context limits
- Agent decides autonomously when to store, retrieve, or evict information

**Key difference from Honcho**: Letta gives the agent explicit control over its own memory management through function calls. Honcho manages memory transparently in the background. Letta has no equivalent to "dreaming" -- memory operations happen during conversation turns.

### 2.3 LangMem (LangChain)

**Architecture**: Three memory types with two formation paths.

**Memory Types**:
1. **Semantic Memory** (Facts/Knowledge): Stored as collections or profiles. Requires active reconciliation -- system must decide whether to delete/invalidate or update/consolidate when new information arrives.
2. **Episodic Memory** (Past Experiences): Captures situational context, reasoning, and outcomes as learning examples.
3. **Procedural Memory** (System Behavior): Encodes behavioral rules through prompt optimization based on conversation feedback.

**Formation Paths**:
- **Hot Path (Active)**: Immediate extraction during conversations. Enables real-time updates but adds latency.
- **Background Path (Subconscious)**: Post-conversation async processing. Deeper pattern analysis without impacting response time.

**Deduplication**: Memory enrichment process that balances creation vs consolidation to avoid precision loss through redundancy.

### 2.4 Comparison Matrix

| Feature | Honcho | Mem0 | Letta/MemGPT | LangMem |
|---------|--------|------|--------------|---------|
| **Core approach** | Memory as reasoning | Extract + retrieve | OS-style tiers | Three memory types |
| **Extraction model** | Custom (Neuromancer) | GPT-4o-mini | Agent-controlled | LLM-based |
| **Background processing** | Yes (dreaming) | Async summaries | No | Yes (background path) |
| **Reasoning beyond facts** | Yes (deductive, inductive, abductive) | No | No | Procedural only |
| **Contradiction handling** | During dreaming | Update/Delete ops | Agent-managed | Reconciliation |
| **Graph support** | No (representations) | Yes (Mem0g) | No | No |
| **Token efficiency** | Very high (0.5-11%) | High (73% savings) | Variable | Variable |
| **Custom models** | Yes (fine-tuned) | No (uses GPT-4o-mini) | No | No |
| **Open source** | Yes | Yes | Yes | Yes |

---

## 3. Academic Research

### 3.1 Sleep-Time Compute (April 2025)

**Paper**: "Sleep-time Compute: Beyond Inference Scaling at Test-time" (arXiv:2504.13171)

Key findings:
- Models can "think" offline about contexts before queries arrive by anticipating what users might ask and pre-computing useful quantities
- Reduces test-time compute by ~5x on Stateful GSM-Symbolic and AIME
- Accuracy increases up to 13% by scaling sleep-time compute
- Amortizing across related queries decreases average cost per query by 2.5x
- Predictability of user query correlates with efficacy of sleep-time compute
- Fundamentally requires **stateful AI agents** with persistent memory

**Relevance to ping-mem**: This validates the "dreaming" paradigm. Processing conversations during idle time and pre-computing useful representations is provably more efficient than doing all reasoning at query time.

### 3.2 Memory Consolidation Surveys

**"Memory in the Age of AI Agents"** (arXiv:2512.13564, Dec 2025): Comprehensive survey proposing taxonomy of factual, experiential, and working memory. Analyzes how memory is formed, evolved, and retrieved over time. Describes consolidation from episodic to semantic memory.

**"Memory for Autonomous LLM Agents"** (arXiv:2603.07670, March 2026): Covers mechanisms, evaluation, and emerging frontiers for agent memory.

**MEM1** (arXiv:2506.15841): End-to-end RL framework enabling agents to operate with constant memory across long multi-turn tasks. Updates compact shared internal state for memory consolidation and reasoning while discarding irrelevant information.

**SimpleMem** (arXiv:2601.02553): Three-stage pipeline:
1. Semantic Structured Compression: Entropy-aware filtering to distill interactions into compact memory units
2. Recursive Memory Consolidation: Async integration of related units into abstract representations
3. Adaptive Query-Aware Retrieval

**ICLR 2026 Workshop**: "MemAgents: Memory for LLM-Based Agentic Systems" -- dedicated workshop on the topic.

### 3.3 Neuroscience-Inspired Approaches

Multiple papers cite complementary learning systems theory and hippocampal-cortical consolidation as design inspiration. Key insight: human memory uses a two-stage process where the hippocampus rapidly encodes episodes, and cortical consolidation (during sleep) extracts general knowledge -- directly analogous to Honcho's ingestion + dreaming architecture.

---

## 4. Best Practices for Batch Processing

### 4.1 Processing Large JSONL Conversation Logs

**Why JSONL**: Each line is its own JSON object. Can read and process line-by-line, keeping memory usage low. Streaming-friendly format that allows parallel processing with traceability through custom IDs.

**Chunking strategies**:
- **Conversation-based**: Split by session/conversation boundaries (natural break points)
- **Turn-based**: Fixed number of turns per chunk (e.g., 10-20 turns)
- **Token-based**: Chunk to stay within model context limits (leave room for system prompt + output)
- **Document-based**: Use intrinsic structure of conversation format (session markers, timestamps)

**Parallel processing**:
- Submit multiple requests together via Batch API for async processing
- Use custom IDs per chunk for traceability
- Process batches without loading entire dataset into memory

### 4.2 LLM-Based Fact Extraction

**Best practices** (synthesized from Mem0, LangMem, SimpleMem, and Honcho approaches):

1. **Context window**: Include recent messages (5-10) plus rolling summary for extraction context
2. **Atomic facts**: Extract self-contained facts, not compound statements
3. **Certainty levels**: Distinguish explicit statements from inferences (Honcho's approach)
4. **Structured output**: Use function calling or structured JSON for extraction (not free-form text)
5. **Two-pass approach**: First extract, then reconcile against existing memory
6. **Entropy-aware filtering**: Filter low-information-density content before extraction (SimpleMem)

### 4.3 Memory Deduplication Strategies

**Embedding-based similarity**:
- Compute cosine similarity between dense vector embeddings
- Threshold configuration is critical:
  - Lower thresholds (e.g., 0.001): More strict, less dedup, higher confidence
  - Higher thresholds (e.g., 0.1): More aggressive dedup, risk removing distinct items
- Typical approach: cluster similar memories, keep one representative per cluster

**LLM-based reconciliation** (Mem0 approach):
- For each new fact, retrieve top-k similar existing memories
- LLM decides: ADD, UPDATE, DELETE, or NOOP
- More accurate but more expensive than pure embedding similarity

**Hybrid approach**:
- First pass: Embedding similarity for candidate identification (fast, cheap)
- Second pass: LLM-based decision for borderline cases (accurate, expensive)
- MinHash LSH for approximate matching at scale

**Multi-level retrieval**:
- Mix-of-Experts gate functions with learnable weights (semantic similarity, recency, importance)
- Adaptive stopping criteria to minimize redundancy in retrieved sets

### 4.4 Cost Estimation for 3.4GB Conversation Processing

**Assumptions**:
- 3.4GB JSONL file
- ~1 token per 4 bytes (English text) = ~850M tokens of raw input
- Each conversation turn processed with context window of ~2K tokens avg
- Extraction output ~200 tokens per turn
- Rough estimate: ~1B input tokens, ~100M output tokens for full extraction pass

**Model pricing (March 2026)**:

| Model | Input $/M | Output $/M | Est. Input Cost | Est. Output Cost | Total |
|-------|-----------|------------|-----------------|------------------|-------|
| Gemini 2.0 Flash | $0.10 | $0.40 | $100 | $40 | **$140** |
| GPT-5 Nano | $0.05 | $0.40 | $50 | $40 | **$90** |
| GPT-5 Mini | $0.25 | $2.00 | $250 | $200 | **$450** |
| Claude Haiku 4.5 | $1.00 | $5.00 | $1,000 | $500 | **$1,500** |
| Claude Sonnet 4.6 | $3.00 | $15.00 | $3,000 | $1,500 | **$4,500** |

**Cost optimization strategies**:
- **Batch API**: 50% discount (OpenAI), processed within 24 hours
- **Prompt caching**: 90% savings on input tokens for repeated system prompts
- **Combined batch + caching**: Up to 95% total savings
- **Pre-filtering**: Skip low-value turns (greetings, confirmations) before LLM processing
- **Tiered approach**: Use cheap model (Gemini Flash / GPT-5 Nano) for extraction, expensive model only for reconciliation/deduction

**Recommended approach for 3.4GB**:
1. Pre-filter to remove trivial turns (could reduce by 20-40%)
2. Use Gemini 2.0 Flash or GPT-5 Nano for initial extraction (~$90-140)
3. Use Batch API for 50% discount (~$45-70)
4. Add prompt caching for system prompt savings
5. Run deduction/consolidation as separate pass on extracted facts only (much smaller dataset)
6. **Realistic total estimate: $50-200** with optimizations applied

---

## 5. Key Takeaways for ping-mem

1. **Honcho validates the "dreaming" paradigm**: Separating fast ingestion from deep async reasoning is the SOTA approach. This is backed by both Honcho's benchmarks and the sleep-time compute paper.

2. **Two-phase pipeline is the standard**: Mem0, Honcho, and LangMem all separate extraction from consolidation/reasoning. This is the proven architecture.

3. **Custom extraction models outperform general LLMs**: Honcho's Neuromancer XR (fine-tuned Qwen3-8B at 86.9%) beats Claude 4 Sonnet (80.0%) on memory extraction tasks. Consider fine-tuning for extraction if volume justifies it.

4. **Certainty levels matter**: Distinguishing explicit facts from deductions (Honcho) and from inductions/hypotheses provides better retrieval precision and enables contradiction resolution.

5. **Batch processing 3.4GB is economically feasible**: With Gemini Flash or GPT-5 Nano plus batch API discounts, full extraction costs $50-200. The expensive part is deduction/reasoning, not extraction.

6. **Memory deduplication needs hybrid approach**: Pure embedding similarity misses semantic nuance. Pure LLM comparison is too expensive at scale. Use embedding similarity for candidate selection, LLM for final decision.

7. **Contradiction handling is a differentiator**: Mem0 uses soft-delete (mark invalid, don't remove). Honcho handles it during dreaming. Both preserve history rather than overwriting.

---

## Sources

- [Honcho 3 Announcement](https://blog.plasticlabs.ai/blog/Honcho-3)
- [Introducing Neuromancer XR](https://blog.plasticlabs.ai/research/Introducing-Neuromancer-XR)
- [Benchmarking Honcho](https://blog.plasticlabs.ai/research/Benchmarking-Honcho)
- [Honcho HN Discussion](https://news.ycombinator.com/item?id=46781717)
- [Honcho GitHub](https://github.com/plastic-labs/honcho)
- [Mem0 Paper (arXiv:2504.19413)](https://arxiv.org/abs/2504.19413)
- [Mem0 Graph Memory](https://mem0.ai/blog/graph-memory-solutions-ai-agents)
- [Mem0 GitHub](https://github.com/mem0ai/mem0)
- [Letta/MemGPT Docs](https://docs.letta.com/concepts/memgpt/)
- [MemGPT Paper (arXiv:2310.08560)](https://arxiv.org/abs/2310.08560)
- [LangMem Conceptual Guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- [Sleep-time Compute Paper (arXiv:2504.13171)](https://arxiv.org/abs/2504.13171)
- [Memory in the Age of AI Agents (arXiv:2512.13564)](https://arxiv.org/abs/2512.13564)
- [SimpleMem (arXiv:2601.02553)](https://arxiv.org/abs/2601.02553)
- [MEM1 (arXiv:2506.15841)](https://arxiv.org/abs/2506.15841)
- [Memory for Autonomous LLM Agents (arXiv:2603.07670)](https://arxiv.org/abs/2603.07670)
- [ICLR 2026 MemAgents Workshop](https://openreview.net/pdf?id=U51WxL382H)
- [LLM API Pricing March 2026](https://www.tldl.io/resources/llm-api-pricing-2026)
- [AI Agent Memory Systems Comparison 2026](https://yogeshyadav.medium.com/ai-agent-memory-systems-in-2026-mem0-zep-hindsight-memvid-and-everything-in-between-compared-96e35b818da8)
- [Mem0 vs Letta Comparison](https://vectorize.io/articles/mem0-vs-letta)
