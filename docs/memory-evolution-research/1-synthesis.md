# Research Synthesis: Agent Memory System Evolution

**Date**: 2026-03-21
**Sources**: 2 external videos, 4 internal systems, 5 parallel codebase research agents

## Founding Principles

1. **Automatic over manual** — Memory recall must happen without agent decision. Pre-prompt injection is the #1 gap.
2. **Quality at write time** — Junk memories degrade retrieval. Filter on write, not just on read.
3. **Wire existing capabilities** — LLMEntityExtractor, ContradictionDetector, CcMemoryBridge exist but aren't fully wired. Build → Wire → Test.
4. **Supersede, never delete** — Facts evolve. Old versions have audit value. The Memory type needs a status field.
5. **Self-maintaining systems** — Scheduled maintenance (dedup, prune, quality score) keeps memory clean over time.
6. **Capability chains must be end-to-end** — A tool that exists but has no caller in a user-facing path is dead code.

## Corrected Gap Analysis (Post-Research)

| Gap | Severity | Status | What's Needed |
|-----|----------|--------|---------------|
| No pre-prompt auto-recall | CRITICAL | Nothing exists | New `context_auto_recall` tool + CLAUDE.md instruction |
| Junk filter on save() | CRITICAL | Nothing exists | Quality check before EventStore write in MemoryManager.save() |
| LLM extraction not wired to save() | HIGH | **LLMEntityExtractor exists (309 LOC)** but ContextToolModule calls it only when extractEntities=true | Wire as default async post-save step |
| ContradictionDetector not wired to save() | HIGH | **ContradictionDetector exists (109 LOC)** but only used in graph entity updates | Wire into MemoryManager.save() for memory-level contradiction checks |
| No maintenance tool/cron | HIGH | RelevanceEngine.consolidate() exists, SemanticCompressor dedup exists | New `memory_maintain` tool orchestrating existing + new maintenance |
| No supersede semantics | MEDIUM | Memory type has no status field, no MEMORY_SUPERSEDED event | Add status field, event type, update save/update paths |
| CcMemoryBridge enhancement | MEDIUM | **389 LOC, fully working** | Enhance with auto-recall results export to ~/.claude/memory/topics/ |
| Understory autoRecall | MEDIUM | Interface has no autoRecall method | Add method + wire in forge-init.ts |
| CLAUDE.md auto-recall instruction | HIGH | ~1,800 tokens, has Memory Strategy section but no recall protocol | Add 5-line recall protocol to Memory Strategy |
| `memory_conflicts` tool | MEDIUM | ContradictionDetector exists but no MCP tool exposes it | New tool in MemoryToolModule |

## Architecture Decision Records

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Auto-recall implementation | MCP tool (not hook) | Claude Code has no pre-prompt hook type; instruction + dedicated fast tool is pragmatic |
| Junk filter | Heuristic first, LLM later | Fast string checks (length, vagueness, duplicate) are O(1); LLM check adds latency on hot path |
| Contradiction detection scope | Memory-level (not just graph entity) | ContradictionDetector currently only runs on graph entity description updates; needs to also check memory values |
| Maintenance orchestration | Single MCP tool calling existing subsystems | RelevanceEngine.consolidate() + SemanticCompressor already exist; orchestrate don't rebuild |
| Supersede implementation | Metadata field + new event type | Adding `status` to Memory interface is breaking; use metadata.status + MEMORY_SUPERSEDED event |

## Measurable Outcomes

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| Auto-recall availability | 0% (no tool) | 100% (tool exists, instruction mandates use) | `bun test` + grep for tool registration |
| Memory quality (junk rate) | Unknown | < 5% junk memories saved | Test with known junk inputs |
| Entity extraction on save | Manual (extractEntities flag) | Automatic async | Test save() triggers extraction |
| Contradiction detection on save | 0% | 100% of saves checked | Test conflicting saves detected |
| Maintenance tool | Does not exist | Exists with dedup/prune/vacuum | `bun test` for memory_maintain |
| Supersede semantics | No status field | Status field + event type | Type check + event replay test |
