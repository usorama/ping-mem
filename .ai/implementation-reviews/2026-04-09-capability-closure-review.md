---
date: 2026-04-09
plan: docs/plans/2026-04-08-feat-capability-closure-plan.md
pr: usorama/ping-mem#100 (merged 2026-04-09)
reviewer: implementation-review skill
quality_gate: typecheck PASS, 2173 tests PASS
---

# Capability Closure Implementation Review

## Gap Coverage (8 gaps in plan)

| Gap | Severity | Status | Evidence |
|-----|----------|--------|---------|
| GAP-C1 (LLMEntityExtractor) | CRITICAL | VERIFIED | `runtime.ts:218` instantiates LLMEntityExtractor when OPENAI_API_KEY+graphManager; `server.ts:106,126` threads to both servers; `ContextToolModule:443` guard activates |
| GAP-H2 (TranscriptMiner EventStore) | HIGH | VERIFIED | `TranscriptMiner:86-95` has eventStore param; `:362-365` emits TRANSCRIPT_MINED; `rest-server.ts:2979` and `MiningToolModule:113` both pass eventStore |
| GAP-C2 (Shell daemon) | CRITICAL | VERIFIED | LaunchAgent plist at `~/Library/LaunchAgents/com.ping-mem.daemon.plist`; PID 8752 running (`LastExitStatus=0`); `.zshrc:78-80` shell hook present |
| GAP-H1 (Prod env vars) | HIGH | VERIFIED | `docker-compose.prod.yml:72-75` has OLLAMA_URL, OLLAMA_EMBED_MODEL, GEMINI_API_KEY, OPENAI_API_KEY |
| GAP-H3 (RECALL_MISS) | HIGH | VERIFIED | `ContextToolModule:974-979` emits RECALL_MISS fire-and-forget; `types/index.ts:302` has event type |
| GAP-M3 (Port deploy) | MEDIUM | VERIFIED | `scripts/deploy-prod.sh:22-23` has sed step rewriting 3003→3000 on VPS; exclusions for .data-backup, .worktrees, dist, .claude |
| GAP-M1 (DreamingEngine docs) | MEDIUM | PARTIAL | Plan outcome was "docs only". No explicit Claude CLI dependency note added to DreamingEngine module comment. `callClaude()` import visible but constraint is implicit. |
| GAP-M2 (Consumer configs) | MEDIUM | PARTIAL | External consumers (sn-assist, ro-new, understory) are in separate repos — not in scope. CLAUDE.md already documents proxy-cli as recommended. No in-repo consumer config changes needed. |

## Regression Fixes (4 issues #92-#95)

| Issue | Status | Evidence |
|-------|--------|---------|
| #92 Hybrid search zero-score | VERIFIED | `CodeIndexer:186-194` — bRngRaw tracks raw range; bRngRaw===0 → full score 1.0; `.filter(score>0)` removed |
| #93 Event pruning destroys history | VERIFIED | `MaintenanceRunner:107-119` — retentionDays undefined = no pruning (opt-in only); pruneOldEvents wrapped in try-catch |
| #94 getStats() null breaks REST | VERIFIED | `rest-server.ts:1863` — `eventStats.eventCount ?? 0` |
| #95 LIMIT 100 silently truncates | VERIFIED | `TemporalCodeGraph:788,800` — queryImpact accepts limit param (default 500), neo4j.int(limit) applied |

## PR-Zero Summary (3 cycles)

All 10 Cycle 1 findings fixed. All 3 Cycle 2 findings fixed. Cycle 3 returned NO ISSUES from both agents.

## Missing Tests (2 gaps)

| ID | Severity | Description |
|----|----------|-------------|
| MT-1 | P3 | No test for TranscriptMiner eventStore wiring — `TRANSCRIPT_MINED` event emission untested |
| MT-2 | P3 | No test for RECALL_MISS emission on zero-result auto_recall path |

## Remaining Gaps Routed

See `.ai/handoff/gap-fix.json` for MT-1 and MT-2.
GAP-M1 partial: trivial 1-line JSDoc addition → routed to execute.
GAP-M2: no in-repo action possible — external repos. Closed.
