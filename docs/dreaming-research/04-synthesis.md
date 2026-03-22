# Synthesis: Conversation Mining + Dreaming Engine

**Date**: 2026-03-22
**Research base**: 3 documents (transcript format, infrastructure audit, Honcho video analysis)

---

## Founding Principles

1. **Mine history, don't just observe future** — Unlike Honcho which only processes new messages, ping-mem will ingest months of historical conversations for instant deep persona
2. **Leverage existing infrastructure** — SemanticCompressor, ContradictionDetector, MaintenanceRunner, EventStore are all production-ready; build ON them, not beside them
3. **LLM reasoning is the differentiator** — Simple storage is not enough (Honcho's key insight). The value is in reasoning about WHAT to store and DERIVING new facts
4. **Cost-efficient processing** — 3.4GB of transcripts must be processable within reasonable LLM budget (~$10-20 via GPT-4o-mini). Use heuristic pre-filtering before LLM
5. **Self-cleaning memory** — Derived insights have a lifecycle: created → validated → stale → superseded. The dreaming engine must clean up its own outputs
6. **Non-blocking integration** — Mining and dreaming run as background processes, never blocking the user's active session
7. **Progressive value** — Mining pipeline delivers value incrementally (per-session extraction), not all-or-nothing

## Measurable Outcomes

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| Mined sessions | 0 | 251 main sessions | `SELECT COUNT(*) FROM events WHERE type='TRANSCRIPT_MINED'` |
| Extracted user preferences | ~5 (manual) | 50-100 (automated) | Memories with category containing 'preference' or 'correction' |
| Derived insights per dreaming cycle | 0 | 3-10 | `SELECT COUNT(*) FROM events WHERE type='INSIGHT_DERIVED'` |
| Stale insight detection rate | N/A | >50% of outdated facts caught | ContradictionDetector hits on derived insights |
| LLM cost for full corpus mining | N/A | <$20 | Token usage tracking in SemanticCompressor |
| Mining throughput | N/A | 10 sessions/minute | Pipeline timing logs |

## Architecture Decision Records

### ADR-1: Mine main sessions only, skip subagents
**Decision**: Process only the 251 main session .jsonl files, not the 6,217 subagent transcripts.
**Why**: Subagents execute narrow tasks without user interaction. User preferences, corrections, and decisions are in main sessions. This reduces corpus from 3.4GB to ~200-400MB.

### ADR-2: Extract user messages only, skip assistant/progress
**Decision**: Filter to `type == "user"` messages only for LLM processing.
**Why**: Progress messages are 88% of content (hooks, commands). Assistant messages are derivative. User messages contain corrections, preferences, and decisions. Reduces LLM input by ~95%.

### ADR-3: Use SemanticCompressor for fact extraction, not a new LLM pipeline
**Decision**: Feed extracted user messages through existing SemanticCompressor.compress() in batches.
**Why**: Already production-tested, has heuristic fallback, cost tracking, batch support. No new LLM integration needed.

### ADR-4: Insert dreaming into MaintenanceRunner pipeline
**Decision**: Add dreaming as a new step in MaintenanceRunner.run() between consolidate and prune.
**Why**: Maintenance already runs periodically, has access to all memory state, and the pipeline is designed for extensibility. Dreaming after consolidation means it operates on compressed/clean memory.

### ADR-5: New EventTypes for audit trail
**Decision**: Add `TRANSCRIPT_MINED`, `INSIGHT_DERIVED`, `INSIGHT_INVALIDATED` to EventType union.
**Why**: Full audit trail of what was mined and what was derived. Enables debugging and rollback.

### ADR-6: Two-phase dreaming (Deduction then Generalization)
**Decision**: Dreaming runs in two phases per cycle:
1. **Deduction**: Compare memory clusters to derive implicit facts (like Honcho)
2. **Generalization**: Find patterns across memories to form personality traits
**Why**: Matches Honcho's proven architecture. Deduction is cheaper (compare pairs). Generalization requires clustering first.

## Gap Analysis

| Gap | Current State | Target State | Severity |
|-----|--------------|--------------|----------|
| No transcript ingestion | Sessions only in .jsonl files | TranscriptMiner scans, extracts, stores | **Critical** |
| No fact derivation | Only stores what's explicitly said | DreamingEngine derives implicit facts | **Critical** |
| No pattern generalization | No personality trait extraction | DreamingEngine generalizes from patterns | **High** |
| No stale fact detection | ContradictionDetector only runs on save | Dreaming cycle checks existing facts | **High** |
| No mining progress tracking | N/A | Track which sessions are mined | **Medium** |
| UserProfile not auto-updated | Manual only | Dreaming updates profile from patterns | **Medium** |
