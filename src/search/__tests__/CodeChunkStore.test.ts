/**
 * Tests for CodeChunkStore (SQLite FTS5 BM25 code search)
 *
 * @module search/__tests__/CodeChunkStore.test
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { CodeChunkStore } from "../CodeChunkStore.js";
import type { CodeChunk } from "../CodeChunkStore.js";
import { Database } from "bun:sqlite";

describe("CodeChunkStore", () => {
  let db: Database;
  let store: CodeChunkStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new CodeChunkStore(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeChunk(overrides?: Partial<CodeChunk>): CodeChunk {
    return {
      chunkId: "chunk-001",
      projectId: "proj-1",
      filePath: "src/search/HybridSearchEngine.ts",
      content: "export class HybridSearchEngine implements SearchInterface",
      startLine: 1,
      endLine: 50,
      chunkType: "class",
      language: "typescript",
      ...overrides,
    };
  }

  describe("addChunk", () => {
    it("should add a chunk and retrieve count", () => {
      store.addChunk(makeChunk());
      expect(store.getChunkCount()).toBe(1);
    });

    it("should upsert on duplicate chunkId", () => {
      store.addChunk(makeChunk({ content: "original content" }));
      store.addChunk(makeChunk({ content: "updated content" }));
      expect(store.getChunkCount()).toBe(1);
    });

    it("should handle chunks without language", () => {
      const chunk = makeChunk();
      delete (chunk as Record<string, unknown>).language;
      store.addChunk(chunk);
      expect(store.getChunkCount()).toBe(1);
    });
  });

  describe("removeChunk", () => {
    it("should remove an existing chunk", () => {
      store.addChunk(makeChunk());
      expect(store.getChunkCount()).toBe(1);
      store.removeChunk("chunk-001");
      expect(store.getChunkCount()).toBe(0);
    });

    it("should not fail when removing nonexistent chunk", () => {
      expect(() => store.removeChunk("nonexistent")).not.toThrow();
    });
  });

  describe("removeProject", () => {
    it("should remove all chunks for a project", () => {
      store.addChunk(makeChunk({ chunkId: "c1", projectId: "proj-1" }));
      store.addChunk(makeChunk({ chunkId: "c2", projectId: "proj-1" }));
      store.addChunk(makeChunk({ chunkId: "c3", projectId: "proj-2" }));

      store.removeProject("proj-1");
      expect(store.getChunkCount()).toBe(1);
    });

    it("should not affect other projects", () => {
      store.addChunk(makeChunk({ chunkId: "c1", projectId: "proj-1" }));
      store.addChunk(makeChunk({ chunkId: "c2", projectId: "proj-2" }));

      store.removeProject("proj-1");

      const results = store.search("HybridSearchEngine");
      expect(results).toHaveLength(1);
      expect(results[0]?.projectId).toBe("proj-2");
    });
  });

  describe("search", () => {
    it("should find chunks by content match", () => {
      store.addChunk(makeChunk({
        chunkId: "c1",
        content: "export function computeScore for ranking documents with terms",
      }));
      store.addChunk(makeChunk({
        chunkId: "c2",
        content: "export class VectorIndex implements SearchIndex",
      }));

      const results = store.search("ranking documents");
      expect(results).toHaveLength(1);
      expect(results[0]?.chunkId).toBe("c1");
    });

    it("should rank results by relevance score", () => {
      store.addChunk(makeChunk({
        chunkId: "c1",
        content: "scoring algorithm scoring scoring term frequency scoring",
      }));
      store.addChunk(makeChunk({
        chunkId: "c2",
        content: "this module uses scoring for ranking",
      }));

      const results = store.search("scoring");
      expect(results).toHaveLength(2);
      // c1 has higher TF for "scoring"
      expect(results[0]?.chunkId).toBe("c1");
      expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    });

    it("should filter by projectId", () => {
      store.addChunk(makeChunk({ chunkId: "c1", projectId: "proj-1", content: "search engine" }));
      store.addChunk(makeChunk({ chunkId: "c2", projectId: "proj-2", content: "search engine" }));

      const results = store.search("search", "proj-1");
      expect(results).toHaveLength(1);
      expect(results[0]?.projectId).toBe("proj-1");
    });

    it("should respect limit parameter", () => {
      for (let i = 0; i < 20; i++) {
        store.addChunk(makeChunk({
          chunkId: `c${i}`,
          content: `search function variant ${i}`,
        }));
      }

      const results = store.search("search", undefined, 5);
      expect(results).toHaveLength(5);
    });

    it("should return empty array for empty query", () => {
      store.addChunk(makeChunk());
      expect(store.search("")).toHaveLength(0);
      expect(store.search("   ")).toHaveLength(0);
    });

    it("should return empty array for no matches", () => {
      store.addChunk(makeChunk({ content: "vector database operations" }));
      expect(store.search("quantum")).toHaveLength(0);
    });

    it("should match on file path", () => {
      store.addChunk(makeChunk({
        chunkId: "c1",
        filePath: "src/search/KeywordStore.ts",
        content: "export class KeywordStore handles ranking",
      }));

      const results = store.search("KeywordStore");
      expect(results).toHaveLength(1);
    });

    it("should return correct metadata fields", () => {
      store.addChunk(makeChunk({
        chunkId: "c1",
        projectId: "proj-1",
        filePath: "src/foo.ts",
        content: "test content for metadata check",
        startLine: 10,
        endLine: 25,
        chunkType: "function",
        language: "typescript",
      }));

      const results = store.search("metadata");
      expect(results).toHaveLength(1);
      const r = results[0]!;
      expect(r.chunkId).toBe("c1");
      expect(r.projectId).toBe("proj-1");
      expect(r.filePath).toBe("src/foo.ts");
      expect(r.startLine).toBe(10);
      expect(r.endLine).toBe(25);
      expect(r.chunkType).toBe("function");
      expect(r.language).toBe("typescript");
      expect(r.score).toBeGreaterThan(0);
    });

    it("should handle FTS5 special characters in query safely", () => {
      store.addChunk(makeChunk({ content: "test content" }));

      // These should not throw — special chars are sanitized
      expect(() => store.search('test AND "injection"')).not.toThrow();
      expect(() => store.search("test OR NOT")).not.toThrow();
      expect(() => store.search("test * NEAR()")).not.toThrow();
      expect(() => store.search("^test {near}")).not.toThrow();
    });

    it("should use porter stemming for matching", () => {
      store.addChunk(makeChunk({
        chunkId: "c1",
        content: "searching through documents and indexing files",
      }));

      // "search" should match "searching" via porter stemmer
      const results = store.search("search");
      expect(results).toHaveLength(1);
    });

    it("should return positive BM25 scores", () => {
      store.addChunk(makeChunk({ content: "test content for scoring" }));
      const results = store.search("test");
      expect(results).toHaveLength(1);
      expect(results[0]?.score).toBeGreaterThan(0);
    });
  });

  describe("getChunkCount", () => {
    it("should return 0 for empty store", () => {
      expect(store.getChunkCount()).toBe(0);
    });

    it("should reflect correct count after adds and removes", () => {
      store.addChunk(makeChunk({ chunkId: "c1" }));
      store.addChunk(makeChunk({ chunkId: "c2" }));
      expect(store.getChunkCount()).toBe(2);

      store.removeChunk("c1");
      expect(store.getChunkCount()).toBe(1);
    });
  });

  describe("table creation idempotency", () => {
    it("should not fail when constructed twice on same db", () => {
      const store2 = new CodeChunkStore(db);
      store.addChunk(makeChunk({ chunkId: "c1" }));
      expect(store2.getChunkCount()).toBe(1);
    });
  });
});
