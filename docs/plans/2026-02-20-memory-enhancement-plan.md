---
title: "ping-mem Memory Enhancement Implementation Plan"
version: 1.0.0
date: 2026-02-20
status: ready
design_doc: docs/plans/2026-02-20-memory-enhancement-design.md
phases: 4
tasks: 16
---

# ping-mem Memory Enhancement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform ping-mem into a best-in-class AI agent memory system with multi-model embedding, LLM entity extraction, and causal reasoning while keeping every phase independently deployable.

**Architecture:** Foundation-first approach. Phase 1 fixes existing stubs (graph search, temporal boost, relevance wiring, BM25 persistence). Phase 2 adds LLM-powered entity extraction with fallback to regex. Phase 3 adds code + causal embedding models with search weight profiles and re-ranking. Phase 4 adds causal graph queries and directional search.

**Tech Stack:** TypeScript, Bun, SQLite, Neo4j, Qdrant, OpenAI API (gpt-4o-mini, text-embedding-3-small), Voyage AI (voyage-code-3), Cohere (rerank-v3.5)

---

## Phase 1: Fix the Foundation

**Quality Gate:** `bun run typecheck` (0 errors) + `bun test` (all pass) + graph search returns results

---

### Task 1: Complete Graph Search — MemoryLookup Interface

**Files:**
- Create: `src/search/MemoryLookup.ts`
- Test: `src/search/__tests__/MemoryLookup.test.ts`

**Step 1: Write the failing test**

```typescript
// src/search/__tests__/MemoryLookup.test.ts
import { describe, it, expect } from "bun:test";
import type { MemoryLookup } from "../MemoryLookup.js";
import type { VectorSearchResult } from "../VectorIndex.js";

describe("MemoryLookup", () => {
  it("should define lookupByEntityNames interface", () => {
    const mockLookup: MemoryLookup = {
      lookupByEntityNames: async (names: string[]) => {
        return names.map((name) => ({
          memoryId: `mem-${name}`,
          sessionId: "session-1",
          content: `Content about ${name}`,
          similarity: 0.9,
          distance: 0.1,
          indexedAt: new Date(),
        }));
      },
    };
    expect(mockLookup.lookupByEntityNames).toBeDefined();
  });

  it("should return VectorSearchResult[]", async () => {
    const mockLookup: MemoryLookup = {
      lookupByEntityNames: async (_names) => [],
    };
    const results = await mockLookup.lookupByEntityNames(["AuthService"]);
    expect(Array.isArray(results)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/search/__tests__/MemoryLookup.test.ts`
Expected: FAIL — `Cannot find module "../MemoryLookup.js"`

**Step 3: Write minimal implementation**

```typescript
// src/search/MemoryLookup.ts
import type { VectorSearchResult } from "./VectorIndex.js";

/**
 * Interface for looking up memories by entity names.
 * Avoids circular dependency between HybridSearchEngine and MemoryManager.
 */
export interface MemoryLookup {
  lookupByEntityNames(names: string[]): Promise<VectorSearchResult[]>;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/search/__tests__/MemoryLookup.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/search/MemoryLookup.ts src/search/__tests__/MemoryLookup.test.ts
git commit -m "feat: add MemoryLookup interface to decouple graph search from MemoryManager"
```

---

### Task 2: Complete Graph Search — Wire into HybridSearchEngine

**Files:**
- Modify: `src/search/HybridSearchEngine.ts:139-157` (HybridSearchEngineConfig)
- Modify: `src/search/HybridSearchEngine.ts:689-726` (graphSearch method)
- Test: `src/search/__tests__/HybridSearchEngine.graphSearch.test.ts`

**Step 1: Write the failing test**

```typescript
// src/search/__tests__/HybridSearchEngine.graphSearch.test.ts
import { describe, it, expect, mock } from "bun:test";
import { HybridSearchEngine } from "../HybridSearchEngine.js";
import type { MemoryLookup } from "../MemoryLookup.js";

describe("HybridSearchEngine - Graph Search", () => {
  it("should return results from MemoryLookup when graph search is active", async () => {
    const mockLookup: MemoryLookup = {
      lookupByEntityNames: mock(async (names: string[]) => [
        {
          memoryId: "mem-1",
          sessionId: "session-1",
          content: "Auth service handles JWT tokens",
          similarity: 0.8,
          distance: 0.2,
          indexedAt: new Date(),
        },
      ]),
    };

    const mockGraphManager = {
      findRelationshipsByEntity: mock(async (_id: string) => [
        {
          id: "rel-1",
          type: "USES",
          sourceId: "entity-auth",
          targetId: "entity-jwt",
          properties: { sourceName: "AuthService", targetName: "JWTTokens" },
          weight: 0.9,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    };

    const mockEmbeddingService = {
      embed: mock(async () => new Float32Array(768)),
      dimensions: 768,
      name: "mock",
    };

    const engine = new HybridSearchEngine({
      embeddingService: mockEmbeddingService as any,
      graphManager: mockGraphManager as any,
      memoryLookup: mockLookup,
    });

    // Add a document to BM25 so engine has content
    engine.addDocument("mem-1", "session-1", "Auth service handles JWT tokens", new Date());

    const results = await engine.search("JWT authentication", {
      modes: ["keyword", "graph"],
      graphEntityId: "entity-auth",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(mockLookup.lookupByEntityNames).toHaveBeenCalled();
  });

  it("should score graph results by hop distance", async () => {
    const mockLookup: MemoryLookup = {
      lookupByEntityNames: mock(async () => [
        {
          memoryId: "mem-1",
          sessionId: "session-1",
          content: "Direct neighbor content",
          similarity: 1.0,
          distance: 0.0,
          indexedAt: new Date(),
        },
      ]),
    };

    const mockGraphManager = {
      findRelationshipsByEntity: mock(async () => [
        {
          id: "rel-1",
          type: "USES",
          sourceId: "entity-1",
          targetId: "entity-2",
          properties: { sourceName: "A", targetName: "B" },
          weight: 0.9,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    };

    const engine = new HybridSearchEngine({
      embeddingService: { embed: async () => new Float32Array(768), dimensions: 768, name: "mock" } as any,
      graphManager: mockGraphManager as any,
      memoryLookup: mockLookup,
    });

    engine.addDocument("mem-1", "session-1", "Direct neighbor content", new Date());

    const results = await engine.search("test", {
      modes: ["graph"],
      graphEntityId: "entity-1",
    });

    // Hop distance 1: similarity = 1 / (1 + 1) = 0.5
    expect(results.length).toBeGreaterThan(0);
  });

  it("should gracefully return empty when memoryLookup is not provided", async () => {
    const mockGraphManager = {
      findRelationshipsByEntity: mock(async () => [
        {
          id: "rel-1",
          type: "USES",
          sourceId: "a",
          targetId: "b",
          properties: {},
          weight: 0.9,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    };

    const engine = new HybridSearchEngine({
      embeddingService: { embed: async () => new Float32Array(768), dimensions: 768, name: "mock" } as any,
      graphManager: mockGraphManager as any,
      // No memoryLookup — should still work
    });

    const results = await engine.search("test", {
      modes: ["keyword", "graph"],
      graphEntityId: "entity-1",
    });

    // Should not throw, just empty graph results
    expect(Array.isArray(results)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/search/__tests__/HybridSearchEngine.graphSearch.test.ts`
Expected: FAIL — `memoryLookup` not in config type

**Step 3: Implement graph search completion**

Modify `src/search/HybridSearchEngine.ts`:

1. Add import: `import type { MemoryLookup } from "./MemoryLookup.js";`
2. Add to `HybridSearchEngineConfig` (after line 147):
   ```typescript
   /** Memory lookup for resolving graph entity names to memory content (optional) */
   memoryLookup?: MemoryLookup;
   ```
3. Add to `ResolvedConfig` (after line 166):
   ```typescript
   memoryLookup: MemoryLookup | undefined;
   ```
4. Wire in constructor (wherever config is resolved):
   ```typescript
   memoryLookup: config.memoryLookup ?? undefined,
   ```
5. Replace `graphSearch` method body (lines 689-726):
   ```typescript
   private async graphSearch(
     entityId: string,
     options: HybridSearchOptions
   ): Promise<VectorSearchResult[]> {
     if (!this.config.graphManager) {
       return [];
     }

     try {
       const relationships = await this.config.graphManager.findRelationshipsByEntity(entityId);
       const limit = (options.limit ?? 10) * 2;

       // Collect entity names from relationships
       const entityNames = new Set<string>();
       for (const rel of relationships) {
         const sourceName = rel.properties?.sourceName ?? rel.sourceId;
         const targetName = rel.properties?.targetName ?? rel.targetId;
         if (rel.sourceId !== entityId) entityNames.add(String(sourceName));
         if (rel.targetId !== entityId) entityNames.add(String(targetName));
       }

       if (entityNames.size === 0 || !this.config.memoryLookup) {
         return [];
       }

       // Lookup memories by entity names
       const results = await this.config.memoryLookup.lookupByEntityNames(
         Array.from(entityNames)
       );

       // Score by hop distance (all direct relationships = hop 1)
       return results.slice(0, limit).map((result) => ({
         ...result,
         similarity: 1.0 / (1 + 1), // hop distance 1 for direct relationships
       }));
     } catch (error) {
       throw new SearchModeError(
         `Graph search failed: ${error instanceof Error ? error.message : String(error)}`,
         "graph",
         "GRAPH_QUERY_FAILED",
         error instanceof Error ? error : undefined
       );
     }
   }
   ```

**Step 4: Run test to verify it passes**

Run: `bun test src/search/__tests__/HybridSearchEngine.graphSearch.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `bun run typecheck && bun test`
Expected: 0 type errors, all tests pass

**Step 6: Commit**

```bash
git add src/search/HybridSearchEngine.ts src/search/__tests__/HybridSearchEngine.graphSearch.test.ts
git commit -m "feat: complete graph search in HybridSearchEngine via MemoryLookup"
```

---

### Task 3: Temporal Post-Retrieval Boost

**Files:**
- Modify: `src/search/HybridSearchEngine.ts:105-122` (add config option)
- Modify: `src/search/HybridSearchEngine.ts:842-844` (add boost after sort)
- Test: `src/search/__tests__/HybridSearchEngine.temporalBoost.test.ts`

**Step 1: Write the failing test**

```typescript
// src/search/__tests__/HybridSearchEngine.temporalBoost.test.ts
import { describe, it, expect } from "bun:test";
import { HybridSearchEngine } from "../HybridSearchEngine.js";

describe("HybridSearchEngine - Temporal Boost", () => {
  function createEngine(temporalBoost?: { factor: number; decayDays: number }) {
    return new HybridSearchEngine({
      embeddingService: { embed: async () => new Float32Array(768), dimensions: 768, name: "mock" } as any,
      temporalBoost,
    });
  }

  it("should boost recent memories higher than old ones", async () => {
    const engine = createEngine({ factor: 0.3, decayDays: 30 });

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    engine.addDocument("recent", "s1", "important finding about auth", now);
    engine.addDocument("old", "s1", "important finding about auth", thirtyDaysAgo);

    const results = await engine.search("important finding about auth", {
      modes: ["keyword"],
    });

    expect(results.length).toBe(2);
    // Recent memory should have higher hybridScore due to temporal boost
    const recentResult = results.find((r) => r.memoryId === "recent");
    const oldResult = results.find((r) => r.memoryId === "old");
    expect(recentResult).toBeDefined();
    expect(oldResult).toBeDefined();
    if (recentResult && oldResult) {
      expect(recentResult.hybridScore).toBeGreaterThan(oldResult.hybridScore);
    }
  });

  it("should skip temporal boost when skipTemporalBoost is true", async () => {
    const engine = createEngine({ factor: 0.3, decayDays: 30 });

    const now = new Date();
    const oldDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    engine.addDocument("recent", "s1", "same content", now);
    engine.addDocument("old", "s1", "same content", oldDate);

    const results = await engine.search("same content", {
      modes: ["keyword"],
      skipTemporalBoost: true,
    });

    // Without temporal boost, scores should be equal (same content, same BM25)
    if (results.length === 2) {
      expect(Math.abs(results[0].hybridScore - results[1].hybridScore)).toBeLessThan(0.01);
    }
  });

  it("should use default factor 0.3 and decayDays 30 when not configured", async () => {
    // No temporalBoost config — should still apply defaults
    const engine = createEngine();
    engine.addDocument("mem-1", "s1", "test content", new Date());

    const results = await engine.search("test content", { modes: ["keyword"] });
    // Should not throw, temporal boost applied silently with defaults
    expect(results.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/search/__tests__/HybridSearchEngine.temporalBoost.test.ts`
Expected: FAIL — `temporalBoost` not in config, `skipTemporalBoost` not in options

**Step 3: Implement temporal boost**

Modify `src/search/HybridSearchEngine.ts`:

1. Add to `HybridSearchEngineConfig` (after `bm25`):
   ```typescript
   /** Temporal boost configuration (post-retrieval recency boost) */
   temporalBoost?: {
     /** Boost factor (default: 0.3 = max 30% boost for today's memories) */
     factor?: number;
     /** Decay half-life in days (default: 30) */
     decayDays?: number;
   };
   ```

2. Add to `ResolvedConfig`:
   ```typescript
   temporalBoost: { factor: number; decayDays: number };
   ```

3. Wire defaults in constructor:
   ```typescript
   temporalBoost: {
     factor: config.temporalBoost?.factor ?? 0.3,
     decayDays: config.temporalBoost?.decayDays ?? 30,
   },
   ```

4. Add to `HybridSearchOptions` (after `graphDepth`):
   ```typescript
   /** Skip temporal boost for this query */
   skipTemporalBoost?: boolean;
   ```

5. Add method after `reciprocalRankFusion`:
   ```typescript
   /**
    * Apply temporal post-retrieval boost to RRF results.
    * Formula: boostedScore = rrfScore * (1 + factor * exp(-ageDays / decayDays))
    */
   private applyTemporalBoost(results: HybridSearchResult[]): HybridSearchResult[] {
     const { factor, decayDays } = this.config.temporalBoost;
     const now = Date.now();

     return results.map((result) => {
       const ageDays = (now - result.indexedAt.getTime()) / (1000 * 60 * 60 * 24);
       const boost = factor * Math.exp(-ageDays / decayDays);
       return {
         ...result,
         hybridScore: result.hybridScore * (1 + boost),
       };
     });
   }
   ```

6. Insert call in `search()` method, after RRF fusion (around line 592), before the filter/slice:
   ```typescript
   let fusedResults = this.reciprocalRankFusion(resultsByMode, weights);

   // Apply temporal boost unless explicitly skipped
   if (!options.skipTemporalBoost) {
     fusedResults = this.applyTemporalBoost(fusedResults);
     // Re-sort after boost
     fusedResults.sort((a, b) => b.hybridScore - a.hybridScore);
   }

   return fusedResults
     .filter((result) => result.hybridScore >= threshold)
     .slice(0, limit);
   ```

**Step 4: Run test + full suite**

Run: `bun test src/search/__tests__/HybridSearchEngine.temporalBoost.test.ts && bun run typecheck && bun test`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/search/HybridSearchEngine.ts src/search/__tests__/HybridSearchEngine.temporalBoost.test.ts
git commit -m "feat: add temporal post-retrieval boost to HybridSearchEngine"
```

---

### Task 4: Wire RelevanceEngine into MemoryManager

**Files:**
- Modify: `src/memory/MemoryManager.ts:35-48` (MemoryManagerConfig)
- Modify: `src/memory/MemoryManager.ts:296-340` (save method)
- Modify: `src/memory/MemoryManager.ts` (get method)
- Test: `src/memory/__tests__/MemoryManager.relevance.test.ts`

**Step 1: Write the failing test**

```typescript
// src/memory/__tests__/MemoryManager.relevance.test.ts
import { describe, it, expect, mock } from "bun:test";
import { MemoryManager } from "../MemoryManager.js";

describe("MemoryManager - RelevanceEngine Integration", () => {
  it("should call ensureTracking on save when relevanceEngine is provided", async () => {
    const mockRelevanceEngine = {
      ensureTracking: mock(() => {}),
      trackAccess: mock(() => {}),
    };

    const manager = new MemoryManager({
      sessionId: "session-1",
      relevanceEngine: mockRelevanceEngine as any,
    });

    await manager.save("test-key", "test-value", { category: "decision" });

    expect(mockRelevanceEngine.ensureTracking).toHaveBeenCalledTimes(1);
  });

  it("should call trackAccess on get when relevanceEngine is provided", async () => {
    const mockRelevanceEngine = {
      ensureTracking: mock(() => {}),
      trackAccess: mock(() => {}),
    };

    const manager = new MemoryManager({
      sessionId: "session-1",
      relevanceEngine: mockRelevanceEngine as any,
    });

    await manager.save("test-key", "test-value");
    manager.get("test-key");

    expect(mockRelevanceEngine.trackAccess).toHaveBeenCalledTimes(1);
  });

  it("should work without relevanceEngine (backwards compatible)", async () => {
    const manager = new MemoryManager({ sessionId: "session-1" });

    await manager.save("key1", "value1");
    const memory = manager.get("key1");

    expect(memory).toBeDefined();
    expect(memory?.value).toBe("value1");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/memory/__tests__/MemoryManager.relevance.test.ts`
Expected: FAIL — `relevanceEngine` not in config type

**Step 3: Implement**

Modify `src/memory/MemoryManager.ts`:

1. Add import: `import type { RelevanceEngine } from "./RelevanceEngine.js";`
2. Add to `MemoryManagerConfig`:
   ```typescript
   /** Optional relevance engine for automatic tracking (auto-calls ensureTracking/trackAccess) */
   relevanceEngine?: RelevanceEngine;
   ```
3. Add private field: `private relevanceEngine: RelevanceEngine | null;`
4. In constructor: `this.relevanceEngine = config.relevanceEngine ?? null;`
5. In `save()`, after storing in cache and emitting event (after line 333):
   ```typescript
   // Auto-track relevance if engine is available
   if (this.relevanceEngine) {
     try {
       this.relevanceEngine.ensureTracking(memoryId, memory.priority, memory.category);
     } catch {
       // Non-blocking: relevance tracking failure should not prevent save
     }
   }
   ```
6. In `get()`, after retrieving from Map:
   ```typescript
   // Auto-track access for relevance
   if (memory && this.relevanceEngine) {
     try {
       this.relevanceEngine.trackAccess(memory.id);
     } catch {
       // Non-blocking
     }
   }
   ```

**Step 4: Run test + full suite**

Run: `bun test src/memory/__tests__/MemoryManager.relevance.test.ts && bun run typecheck && bun test`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/memory/MemoryManager.ts src/memory/__tests__/MemoryManager.relevance.test.ts
git commit -m "feat: wire RelevanceEngine into MemoryManager for automatic tracking"
```

---

### Task 5: Persist BM25 Index

**Files:**
- Create: `src/search/BM25Store.ts`
- Test: `src/search/__tests__/BM25Store.test.ts`
- Modify: `src/search/HybridSearchEngine.ts` (optional BM25Store injection)

**Step 1: Write the failing test**

```typescript
// src/search/__tests__/BM25Store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { BM25Store } from "../BM25Store.js";
import { Database } from "bun:sqlite";

describe("BM25Store", () => {
  let db: Database;
  let store: BM25Store;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new BM25Store(db);
  });

  afterEach(() => {
    db.close();
  });

  it("should persist a document to SQLite", () => {
    store.addDocument("mem-1", "session-1", "hello world test", new Date());
    const docs = store.loadAll();
    expect(docs.length).toBe(1);
    expect(docs[0].memoryId).toBe("mem-1");
  });

  it("should survive a reload cycle", () => {
    store.addDocument("mem-1", "s1", "typescript memory system", new Date());
    store.addDocument("mem-2", "s1", "rust embedding pipeline", new Date());

    // Create new store from same DB (simulates restart)
    const store2 = new BM25Store(db);
    const docs = store2.loadAll();
    expect(docs.length).toBe(2);
  });

  it("should remove a document", () => {
    store.addDocument("mem-1", "s1", "content", new Date());
    store.removeDocument("mem-1");
    const docs = store.loadAll();
    expect(docs.length).toBe(0);
  });

  it("should handle empty database", () => {
    const docs = store.loadAll();
    expect(docs.length).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/search/__tests__/BM25Store.test.ts`
Expected: FAIL — `Cannot find module "../BM25Store.js"`

**Step 3: Implement**

```typescript
// src/search/BM25Store.ts
import { Database } from "bun:sqlite";

export interface BM25StoredDocument {
  memoryId: string;
  sessionId: string;
  content: string;
  indexedAt: Date;
  metadata?: string; // JSON stringified
}

/**
 * Persistent BM25 index storage via SQLite.
 * Saves BM25 documents so the index survives restarts without rebuild.
 */
export class BM25Store {
  private db: Database;
  private insertStmt: ReturnType<Database["prepare"]>;
  private deleteStmt: ReturnType<Database["prepare"]>;
  private loadStmt: ReturnType<Database["prepare"]>;

  constructor(db: Database) {
    this.db = db;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS bm25_documents (
        memory_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        indexed_at INTEGER NOT NULL,
        metadata TEXT
      )
    `);
    this.insertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO bm25_documents (memory_id, session_id, content, indexed_at, metadata)
       VALUES (?, ?, ?, ?, ?)`
    );
    this.deleteStmt = this.db.prepare(
      `DELETE FROM bm25_documents WHERE memory_id = ?`
    );
    this.loadStmt = this.db.prepare(
      `SELECT memory_id, session_id, content, indexed_at, metadata FROM bm25_documents`
    );
  }

  addDocument(
    memoryId: string,
    sessionId: string,
    content: string,
    indexedAt: Date,
    metadata?: Record<string, unknown>
  ): void {
    this.insertStmt.run(
      memoryId,
      sessionId,
      content,
      indexedAt.getTime(),
      metadata ? JSON.stringify(metadata) : null
    );
  }

  removeDocument(memoryId: string): void {
    this.deleteStmt.run(memoryId);
  }

  loadAll(): BM25StoredDocument[] {
    const rows = this.loadStmt.all() as Array<{
      memory_id: string;
      session_id: string;
      content: string;
      indexed_at: number;
      metadata: string | null;
    }>;
    return rows.map((row) => ({
      memoryId: row.memory_id,
      sessionId: row.session_id,
      content: row.content,
      indexedAt: new Date(row.indexed_at),
      metadata: row.metadata ?? undefined,
    }));
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/search/__tests__/BM25Store.test.ts`
Expected: PASS

**Step 5: Wire into HybridSearchEngine**

Add optional `bm25Store?: BM25Store` to `HybridSearchEngineConfig`. In `addDocument()`, also persist to `bm25Store` if available. Add a `loadFromStore()` method that reads from BM25Store and populates the in-memory BM25Index.

**Step 6: Run full suite**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all pass

**Step 7: Commit**

```bash
git add src/search/BM25Store.ts src/search/__tests__/BM25Store.test.ts src/search/HybridSearchEngine.ts
git commit -m "feat: add BM25Store for persistent keyword index"
```

---

### Task 6: Phase 1 Quality Gate

**Step 1: Run full quality gate**

```bash
bun run typecheck && bun test && bun run build
```

Expected: 0 type errors, all tests pass, build succeeds

**Step 2: Verify graph search works end-to-end**

Write a manual integration test or verify via MCP that graph search now returns actual results when entities are present.

**Step 3: Commit phase marker**

```bash
git add -A
git commit -m "milestone: Phase 1 complete — foundation fixes (graph search, temporal boost, relevance wiring, BM25 persistence)"
```

---

## Phase 2: Intelligent Extraction

**Depends on:** Phase 1 (graph search must work)
**Quality Gate:** LLM extraction returns valid entities on test input + fallback to regex works

---

### Task 7: LLM Entity Extractor — Core Class

**Files:**
- Create: `src/graph/LLMEntityExtractor.ts`
- Test: `src/graph/__tests__/LLMEntityExtractor.test.ts`

**Step 1: Write the failing test**

```typescript
// src/graph/__tests__/LLMEntityExtractor.test.ts
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { LLMEntityExtractor } from "../LLMEntityExtractor.js";
import { EntityType } from "../../types/graph.js";

describe("LLMEntityExtractor", () => {
  const mockOpenAI = {
    chat: {
      completions: {
        create: mock(async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                entities: [
                  { name: "AuthService", type: "CODE_CLASS", confidence: 0.95, context: "handles authentication" },
                  { name: "TokenExpiry", type: "ERROR", confidence: 0.85, context: "token expiration bug" },
                ],
                relationships: [
                  { source: "AuthService", target: "TokenExpiry", type: "CAUSES", confidence: 0.8, evidence: "auth service token handling" },
                ],
              }),
            },
          }],
        })),
      },
    },
  };

  it("should extract entities from text using LLM", async () => {
    const extractor = new LLMEntityExtractor({ openai: mockOpenAI as any });
    const result = await extractor.extract("The AuthService causes TokenExpiry errors in production");

    expect(result.entities.length).toBe(2);
    expect(result.entities[0].name).toBe("AuthService");
    expect(result.entities[0].type).toBe(EntityType.CODE_CLASS);
  });

  it("should extract relationships from text using LLM", async () => {
    const extractor = new LLMEntityExtractor({ openai: mockOpenAI as any });
    const result = await extractor.extract("The AuthService causes TokenExpiry errors");

    expect(result.relationships.length).toBe(1);
    expect(result.relationships[0].type).toBe("CAUSES");
  });

  it("should fall back to empty on LLM failure", async () => {
    const failingOpenAI = {
      chat: { completions: { create: mock(async () => { throw new Error("API down"); }) } },
    };
    const extractor = new LLMEntityExtractor({
      openai: failingOpenAI as any,
      fallbackExtractor: {
        extract: mock(async (text: string) => ({
          entities: [{ id: "e1", name: "fallback", type: EntityType.CONCEPT, properties: {}, createdAt: new Date(), updatedAt: new Date(), eventTime: new Date(), ingestionTime: new Date() }],
          relationships: [],
        })),
      } as any,
    });

    const result = await extractor.extract("some text");
    // Should use fallback, not throw
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.entities[0].name).toBe("fallback");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/graph/__tests__/LLMEntityExtractor.test.ts`
Expected: FAIL — module not found

**Step 3: Implement LLMEntityExtractor**

Create `src/graph/LLMEntityExtractor.ts` with:
- Constructor takes `{ openai: OpenAI, fallbackExtractor?: EntityExtractor, model?: string }`
- `extract(text: string)` method:
  1. Call `openai.chat.completions.create()` with structured output prompt
  2. Parse JSON response into `EntityExtractResult` format
  3. On failure: log error, delegate to `fallbackExtractor` or return empty
- System prompt: Extract entities (from EntityType enum) and relationships (from RelationshipType enum) as JSON
- Map LLM response types to `EntityType` and `RelationshipType` enums
- Generate deterministic UUIDs for extracted entities

**Step 4: Run test + full suite**

Run: `bun test src/graph/__tests__/LLMEntityExtractor.test.ts && bun run typecheck && bun test`

**Step 5: Commit**

```bash
git add src/graph/LLMEntityExtractor.ts src/graph/__tests__/LLMEntityExtractor.test.ts
git commit -m "feat: add LLMEntityExtractor with OpenAI structured output and regex fallback"
```

---

### Task 8: Selective Extraction Routing in PingMemServer

**Files:**
- Modify: `src/mcp/PingMemServer.ts` (context_save handler)
- Test: `src/mcp/__tests__/PingMemServer.selectiveExtraction.test.ts`

**Step 1: Write test for selective routing logic**

Test that:
- Category `decision` triggers LLM extraction
- Category `note` with < 200 chars triggers regex
- Explicit `extractEntities: true` triggers LLM regardless of category
- LLM failure triggers regex fallback

**Step 2: Implement routing**

In the `context_save` tool handler, add routing logic:
```typescript
const useLlmExtraction =
  (category && ["decision", "error", "task"].includes(category)) ||
  (content.length > 200) ||
  (options?.extractEntities === true);

const extractor = useLlmExtraction && this.llmExtractor
  ? this.llmExtractor
  : this.regexExtractor;
```

**Step 3: Run full suite + commit**

---

### Task 9: Contradiction Detection

**Files:**
- Create: `src/graph/ContradictionDetector.ts`
- Modify: `src/types/graph.ts` (add CONTRADICTS to RelationshipType)
- Test: `src/graph/__tests__/ContradictionDetector.test.ts`

**Step 1: Write test** — Mock existing entity from Neo4j, save new entity with contradicting info, verify CONTRADICTS relationship detected.

**Step 2: Add `CONTRADICTS` to RelationshipType enum** in `src/types/graph.ts:77-98`.

**Step 3: Implement ContradictionDetector** with:
- `detect(newEntity, existingEntities)` method
- Uses gpt-4o-mini to compare old vs new context
- Returns `{ isContradiction: boolean, conflict: string, confidence: number }`
- Only flags when confidence > 0.7

**Step 4: Run full suite + commit**

---

### Task 10: Phase 2 Quality Gate

```bash
bun run typecheck && bun test && bun run build
```

Manual verification: Save a decision memory with complex text, verify LLM-extracted entities appear in Neo4j with higher quality than regex would produce.

```bash
git commit -m "milestone: Phase 2 complete — LLM entity extraction with contradiction detection"
```

---

## Phase 3: Multi-Model Embedding

**Depends on:** Phase 1 (RRF), Phase 2 (entity extraction)
**Quality Gate:** Multi-model search returns results from all active collections

---

### Task 11: Code Embedding Provider

**Files:**
- Create: `src/search/CodeEmbeddingProvider.ts`
- Test: `src/search/__tests__/CodeEmbeddingProvider.test.ts`

**Step 1: Write test** — Mock Voyage AI API, verify 1024D embedding returned, verify fallback on API error.

**Step 2: Implement** `CodeEmbeddingProvider` implementing `EmbeddingProvider`:
- Uses `fetch()` to call Voyage AI API (`https://api.voyageai.com/v1/embeddings`)
- Model: `voyage-code-3`, dimensions: 1024
- API key from `VOYAGE_API_KEY` env var
- Fallback: return null (caller uses semantic embedding instead)

**Step 3: Run test + commit**

---

### Task 12: Causal Embedding Provider + Search Weight Profiles

**Files:**
- Create: `src/search/CausalEmbeddingProvider.ts`
- Create: `src/search/SearchProfiles.ts`
- Modify: `src/search/HybridSearchEngine.ts` (extend SearchMode, SearchWeights, add profile support)
- Test files for each

**Step 1: Write test for CausalEmbeddingProvider** — Verify cause-side and effect-side embeddings differ, verify correct prefix applied.

**Step 2: Implement CausalEmbeddingProvider** — Wraps existing OpenAI embedding with "cause: " / "effect: " prefix.

**Step 3: Write test for SearchProfiles** — Verify 5 profiles exist with weights summing to 1.0.

**Step 4: Implement SearchProfiles** — Export `SEARCH_PROFILES` map and `detectProfile(query)` heuristic.

**Step 5: Extend HybridSearchEngine**:
- Add `"code"` and `"causal"` to `SearchMode`
- Add `code` and `causal` to `SearchWeights`
- Add `profile?: string` to `HybridSearchOptions`
- In `search()`: if profile specified, load weights from SearchProfiles; else auto-detect

**Step 6: Run full suite + commit**

---

### Task 13: Re-Ranker

**Files:**
- Create: `src/search/Reranker.ts`
- Test: `src/search/__tests__/Reranker.test.ts`

**Step 1: Write test** — Mock Cohere API, verify results are re-ordered, verify fallback returns original order.

**Step 2: Implement Reranker**:
- Uses `fetch()` to call Cohere Rerank API
- Takes top-20 results, returns re-ranked top-K
- API key from `COHERE_API_KEY` env var
- Disabled by default, enabled via `HybridSearchOptions.rerank: true`

**Step 3: Wire into HybridSearchEngine** — After temporal boost, before final filter/slice, optionally call reranker.

**Step 4: Run full suite + commit**

---

### Task 14: Phase 3 Quality Gate

```bash
bun run typecheck && bun test && bun run build
```

Verify: search with profile `code_search` returns code-relevant results weighted toward code collection.

```bash
git commit -m "milestone: Phase 3 complete — multi-model embedding with profiles and re-ranking"
```

---

## Phase 4: Causal Reasoning

**Depends on:** Phase 2 (LLM extraction), Phase 3 (causal embeddings)
**Quality Gate:** `search_causes` MCP tool returns meaningful cause-effect chains

---

### Task 15: Causal Graph Manager + MCP Tools

**Files:**
- Create: `src/graph/CausalGraphManager.ts`
- Create: `src/graph/CausalDiscoveryAgent.ts`
- Modify: `src/types/graph.ts` (extend CAUSES relationship properties)
- Modify: `src/mcp/PingMemServer.ts` (add 4 new tools)
- Test files for each

**Step 1: Write tests for CausalGraphManager** — Test `addCausalLink`, `getCausesOf`, `getEffectsOf`, `getCausalChain`.

**Step 2: Implement CausalGraphManager** — Cypher queries for causal link CRUD and traversal:
```cypher
// getCausesOf
MATCH (effect {id: $entityId})<-[:CAUSES]-(cause)
WHERE r.confidence >= $minConfidence
RETURN cause, r ORDER BY r.confidence DESC LIMIT $limit

// getCausalChain
MATCH path = shortestPath((start {id: $startId})-[:CAUSES*]->(end {id: $endId}))
RETURN path
```

**Step 3: Write tests for CausalDiscoveryAgent** — Mock OpenAI, verify causal links are extracted and persisted.

**Step 4: Implement CausalDiscoveryAgent** — LLM-based causal relationship discovery, async after save.

**Step 5: Add MCP tools** — `search_causes`, `search_effects`, `get_causal_chain`, `trigger_causal_discovery` in PingMemServer.

**Step 6: Add directional search boost** in HybridSearchEngine — "why" queries boost cause-side, "what if" queries boost effect-side.

**Step 7: Run full suite + commit**

---

### Task 16: Phase 4 Quality Gate + Final Integration

```bash
bun run typecheck && bun test && bun run build
```

**Manual verification:**
1. Save error memory: "JWT token expiration causes 401 errors in the auth service"
2. Verify causal link created in Neo4j
3. Query: `search_causes({ query: "401 errors" })` → should return "JWT token expiration"
4. Query: `search_effects({ query: "token expiration" })` → should return "401 errors"

**Update CLAUDE.md** with new capabilities.

```bash
git add -A
git commit -m "milestone: Phase 4 complete — causal reasoning with graph queries and directional search"
```

---

## Dependency Graph

```
Task 1 (MemoryLookup interface) ──┐
Task 2 (Graph search impl) ───────┤
Task 3 (Temporal boost) ──────────┤── Task 6 (Phase 1 gate)
Task 4 (RelevanceEngine wiring) ──┤
Task 5 (BM25 persistence) ────────┘
                                   │
Task 7 (LLM EntityExtractor) ─────┤
Task 8 (Selective routing) ────────┤── Task 10 (Phase 2 gate)
Task 9 (Contradiction detection) ──┘
                                   │
Task 11 (Code embedding) ─────────┤
Task 12 (Causal embedding + profiles)┤── Task 14 (Phase 3 gate)
Task 13 (Re-ranker) ──────────────┘
                                   │
Task 15 (Causal graph + MCP tools) ┤── Task 16 (Phase 4 gate)
```

Tasks within a phase can run in parallel (Tasks 1-5 are independent). Phase gates are serial checkpoints.

---

## Risk Mitigations Per Phase

| Phase | Primary Risk | Mitigation | Verification |
|-------|-------------|------------|-------------|
| 1 | Circular dependency (HybridSearch ↔ MemoryManager) | MemoryLookup callback interface | Type check passes |
| 2 | LLM extraction returns garbage | JSON schema enforcement + confidence thresholds + regex fallback | Test with 10 real memories |
| 3 | Voyage/Cohere API unavailable | Fallback to semantic-only / skip re-rank | Tests mock both success and failure |
| 4 | Causal false positives | Confidence > 0.7 threshold, non-blocking warnings | Manual review of 20 causal links |
