# Synthesis: Auto-Capture, Progressive Disclosure, and Memory Decay

**Date**: 2026-03-22
**Research base**: 4 documents, 726 lines, 12+ external sources

---

## Founding Principles

1. **Memory builds itself** — Agent should never need to explicitly call `context_save` for routine observations. Hooks capture tool usage automatically.
2. **Token efficiency first** — Search must support progressive disclosure (compact → detail) to avoid context window bloat.
3. **Decay reflects reality** — Old, unaccessed memories should naturally lose prominence. FSRS power-law outperforms simple exponential.
4. **Leverage existing infrastructure** — No new databases, no new services. Build on worklog_record, RelevanceEngine, HybridSearchEngine, existing hooks pattern.
5. **Non-blocking capture** — Hooks must never slow down Claude Code. Use async/fire-and-forget patterns.
6. **Dedup at capture** — Content-hash dedup within a time window prevents duplicate observations from rapid tool calls.
7. **Graceful degradation** — If ping-mem REST is down, hooks silently exit 0. No error state.

## Measurable Outcomes

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| Auto-captured observations per session | 0 | 15-50 (one per tool use) | `SELECT COUNT(*) FROM events WHERE type='OBSERVATION_CAPTURED'` |
| Token cost per search result (auto-recall) | ~500 tokens (full value) | ~80 tokens (compact mode) | Compare formatted output length |
| Memory decay accuracy vs access pattern | Fixed 0.97^days | FSRS power-law with access boost | RelevanceEngine unit tests |
| Hook latency impact on Claude | N/A | <50ms (async, fire-and-forget) | Measure hook execution time |
| Dedup hit rate | N/A | >20% (rapid tool sequences) | Content hash collision count |

## Architecture Decision Records

### ADR-1: HTTP hooks vs shell scripts
**Decision**: Use shell scripts (`type: "command"`) with background curl, NOT `type: "http"`.
**Why**: HTTP hooks can't do pre-processing (extracting file paths, computing content hash). Shell scripts give us payload transformation before POST. Match existing hook patterns in `~/.claude/hooks/`.

### ADR-2: New REST endpoint vs reuse worklog_record
**Decision**: Add new `POST /api/v1/observations/capture` endpoint + `ObservationCaptureService`.
**Why**: worklog_record maps to specific EventTypes and has strict schema. Auto-captured observations have different structure (tool_name, tool_input summary, files_touched, content_hash). Cleaner separation of concerns.

### ADR-3: FSRS power-law vs keep exponential decay
**Decision**: Upgrade RelevanceEngine to FSRS `(1 + 0.2346 * t/S)^(-0.5)` with category-based stability.
**Why**: Empirically validated, better long-tail (old decisions retain more relevance). The existing `0.97^days` has a fixed 23-day half-life for ALL categories. FSRS + per-category S gives decisions 180-day stability vs observations 3-day.

### ADR-4: Progressive disclosure mode for context_search
**Decision**: Add `compact: true` parameter to context_search that returns `{id, key, category, snippet(50 chars), score}` instead of full value.
**Why**: 10x token savings. Full details fetched via existing `context_get` by ID. No new MCP tool needed — just a mode flag.

## Gap Analysis

| Gap | Current State | Target State | Severity |
|-----|--------------|--------------|----------|
| No auto-capture hooks | Manual `context_save` only | PostToolUse/SessionStart/Stop hooks capture observations | **Critical** |
| No progressive disclosure | context_search returns full values | compact mode returns snippets, detail via context_get | **High** |
| Fixed decay rate for all categories | 0.97^days (23-day half-life for everything) | Per-category stability (3d–180d), FSRS power-law | **High** |
| No content-hash dedup | N/A | SHA-256 truncated hash, 30s window | **Medium** |
| REST search uses keyword-only | `GET /api/v1/search` uses keyPattern wildcard | Optionally use semanticQuery when HybridSearchEngine available | **Medium** |
