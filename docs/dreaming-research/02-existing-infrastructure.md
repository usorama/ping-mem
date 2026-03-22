# Existing Infrastructure Audit for Conversation Mining + Dreaming Engine

**Date**: 2026-03-22 | **Source**: Full code audit of 7 core modules

## Component Summary

| Component | File | Lines | Maturity | Dreaming Readiness |
|-----------|------|-------|----------|-------------------|
| SemanticCompressor | `src/memory/SemanticCompressor.ts` | 260 | Production | Direct — takes Memory[] |
| ContradictionDetector | `src/graph/ContradictionDetector.ts` | 108 | Production | Needs OpenAI SDK injection |
| AgentIntelligence | `src/memory/AgentIntelligence.ts` | 483 | Production | Ready (SQLite backend) |
| UserProfile | `src/profile/UserProfile.ts` | 191 | Production | Ready for profile-scoped dreams |
| MaintenanceRunner | `src/maintenance/MaintenanceRunner.ts` | 328 | Production | **Insert point between prune & vacuum** |
| EventStore | `src/storage/EventStore.ts` | 1068 | Production | Ready (createEvent, getBy*) |
| MemoryManager | `src/memory/MemoryManager.ts` | 1503 | Production | Ready (save, recall, hydrate) |

## Key Signatures

### SemanticCompressor.compress()
- **Line 63**: `compress(memories: Memory[]): Promise<CompressionResult>`
- **Model**: GPT-4o-mini, temperature 0.1
- **Batch size**: ~80 memories per batch (4000 token limit)
- **Returns**: `{ facts: string[], sourceCount, compressionRatio, strategy: "llm"|"heuristic" }`
- **Heuristic fallback**: `Bun.hash()` dedup + normalize + truncate to 200 chars

### ContradictionDetector.detect()
- **Line 59**: `detect(entityName: string, oldContext: string, newContext: string): Promise<ContradictionResult>`
- **Returns**: `{ isContradiction: boolean, conflict: string, confidence: number }`
- **Threshold**: 0.7 — only flags >= threshold
- **Model**: GPT-4o-mini

### MaintenanceRunner.run()
- **Line 73**: `run(options?: MaintenanceOptions): Promise<MaintenanceResult>`
- **Pipeline**: dedup (L80) → consolidate (L83) → prune (L86) → vacuum (L90) → export (L94)
- **Dreaming insertion point**: Between prune and vacuum, or as new Step 5.5 before export
- **Has full context**: dedupCount, consolidateResult available for dream reasoning

### MemoryManager.save()
- **Line 388**: `save(key: string, value: string, options?: SaveMemoryOptions): Promise<Memory>`
- **Dedup**: Exact key match only (no vector similarity)
- **Write lock**: Acquired before existence check (TOCTOU safe)
- **Scope enforcement**: public/shared/role/private via `isVisibleToCurrentAgent()`

### EventStore.createEvent()
- **Line 655**: `createEvent(sessionId, eventType, payload, metadata?, causedBy?): Promise<Event>`
- **New event types needed**: `DREAM_GENERATED`, `TRANSCRIPT_MINED`, `INSIGHT_DERIVED`

### UserProfile
- **Fields**: userId, name, role, activeProjects[], expertise[], currentFocus[], relevanceThreshold, metadata
- **Line 126**: `updateProfile(userId, update): UserProfile`
- **Line 176**: `seedFromMigrationData(userId, analysis)` — pre-populate from legacy data

### AgentIntelligence.compressOldMemories()
- **Line 394**: `compressOldMemories(daysOld: number = 30): CompressionSummary[]`
- Groups by category, creates summary text, marks originals compressed
- Can be reused for dream compression with minimal changes
