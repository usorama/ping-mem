# Synthesis: ping-mem Self-Monitoring Ingestion Pipeline

**Date**: 2026-03-15
**Research Sources**: 5 parallel agents (ingestion filtering audit, service/healthmonitor audit, queue patterns research, event/pubsub audit, failure analysis)

---

## Founding Principles

1. **ping-mem must self-monitor** — no human should need to grep docker logs to know if ingestion succeeded or failed
2. **Ingestion is a first-class operation** — with its own lifecycle, events, status tracking, and health awareness
3. **What to ingest is as important as how to ingest** — smart filtering prevents garbage-in, garbage-out
4. **Partial failure must be recoverable** — no state where the system silently thinks it's done but isn't
5. **Serial ingestion is correct at this scale** — Neo4j/Qdrant contention on concurrent writes is the bottleneck, not CPU

## Critical Findings Across All Research

### A. Ingestion Filtering is Incomplete (16 findings)

| ID | Severity | Finding |
|----|----------|---------|
| F-01 | CRITICAL | No file size limit — `readFileSync` on a 500MB SQL dump OOMs the process |
| F-02 | CRITICAL | `.env` files tracked in git bypass the walkDirectory exclusion and get ingested |
| F-03 | CRITICAL | `maxCommitAgeDays=30` hardcoded default, not exposed via REST or MCP |
| F-04 | CRITICAL | Manifest saved BEFORE Neo4j persist — partial failure blocks recovery without `forceReingest` |
| F-05 | IMPORTANT | Git history not scoped to projectDir in mono-repos (all commits indexed, not just subdirectory) |
| F-06 | IMPORTANT | `//` inside string literals misidentified as comments by TypeScript chunker |
| F-07 | IMPORTANT | Circular symlinks cause infinite recursion in walkDirectory (no cycle detection) |
| F-08 | IMPORTANT | `vendor/`, `coverage/`, `tmp/` not in DEFAULT_IGNORE_DIRS |
| F-09 | IMPORTANT | Binary files with non-excluded extensions read as UTF-8 (corrupted chunks indexed) |
| F-10 | IMPORTANT | Auto-ingest via git hook/launchd documented but NOT implemented |
| F-11 | LOW | `ingest-project.sh` fails for worktrees (checks `[[ -d .git ]]`) |
| F-12 | LOW | `direct-ingest.ts` has hardcoded Neo4j password |
| F-13 | LOW | Schema `..` check is pre-normalize (harmless due to `path.resolve`) |
| F-14 | LOW | Only TS/JS/Python get language-aware chunking |
| F-15 | LOW | SymbolExtractor receives raw content, not post-chunk |
| F-16 | LOW | No concurrency protection on ManifestStore writes |

### B. Ingestion is Invisible to the Event System

- `IngestionService` has ZERO references to EventStore or PubSub
- No `CODEBASE_INGESTED` event type exists
- SSE clients cannot subscribe to ingestion progress
- Worklog never records ingestion runs
- The REST handler emits no event after `ingestProject()` returns

### C. HealthMonitor is Blind During Ingestion

- No wiring between HealthMonitor and IngestionService
- Qdrant `point_count_drift_pct` fires false CRITICAL alerts during normal ingestion
- No ingestion-aware alert suppression
- Baseline ratchet freezes during large ingests (>15% growth between ticks)

### D. No Ingestion Queue or Concurrency Control

- Zero mutexes, semaphores, or queues in the ingestion pipeline
- `WriteLockManager` only covers agent SQLite writes, not ingestion
- Concurrent ingests of the same project race on `manifest.json`
- 3 simultaneous ingests compete for Neo4j connections

### E. Specific Failure Modes Observed

1. **Gitlink crash** — fixed (stat.isFile guard), but only defends against mode 160000
2. **node_modules in Qdrant** — ping-learn indexed playwright .d.ts files (8512 lines)
3. **Neo4j OOM on cleanup** — single DETACH DELETE for large projects exceeds 2GB heap
4. **DeterministicVectorizer O(n³) ngrams** — huge files cause exponential memory growth

## Gap Coverage Matrix

| Gap | Resolution | Phase |
|-----|-----------|-------|
| No file size limit | Pre-validation: skip files > 1MB (configurable) | 1 |
| .env ingestion via git | Extension-independent .env check in collectFiles | 1 |
| Binary file detection | Null-byte check in first 8KB | 1 |
| Missing exclude dirs | Add coverage/, tmp/, out/, .turbo/, vendor/ | 1 |
| Missing exclude extensions | Add .map, .min.js, .min.css, .snap, .sql, .d.ts | 1 |
| Gitlink/submodule detection | Already fixed; add nested .git detection | 1 |
| Circular symlink detection | Visited-path set in walkDirectory | 1 |
| Manifest-before-persist race | Move manifest save to AFTER both Neo4j + Qdrant succeed | 2 |
| No ingestion queue | IngestionQueue with p-queue (concurrency=1) | 2 |
| No ManifestStore locking | Mutex guard in IngestionQueue (serial = no lock needed) | 2 |
| No ingestion events | Add CODEBASE_INGESTED EventType + emit from IngestionService | 3 |
| No SSE ingestion streaming | Extend PubSub with ingestion channel or generic system channel | 3 |
| No worklog recording | Record ingestion as worklog event on completion | 3 |
| HealthMonitor false positives | Ingestion-awareness: suppress drift alerts during active ingest | 4 |
| No retry logic | Exponential backoff on Neo4j persist + Qdrant index (3 retries) | 4 |
| No progress callback | onProgress callback through IngestionOrchestrator pipeline | 4 |
| No staleness detection | Periodic verifyProject on registered projects | 5 |
| maxCommitAgeDays not exposed | Add to REST schema and MCP tool params | 5 |
| Auto-ingest not implemented | Out of scope — document as known gap | — |
