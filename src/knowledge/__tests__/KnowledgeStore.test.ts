/**
 * Tests for KnowledgeStore
 *
 * @module knowledge/__tests__/KnowledgeStore.test
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { Database } from "bun:sqlite";
import { KnowledgeStore } from "../KnowledgeStore.js";
import type { KnowledgeEntry } from "../KnowledgeStore.js";

describe("KnowledgeStore", () => {
  let db: Database;
  let store: KnowledgeStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new KnowledgeStore(db);
  });

  describe("ingest", () => {
    it("should create a knowledge entry with SHA-256 id", () => {
      const entry = store.ingest({
        projectId: "proj-1",
        title: "Fix CORS issue",
        solution: "Set Access-Control-Allow-Origin header",
        tags: ["cors", "http"],
      });

      expect(entry.id).toBeDefined();
      expect(entry.id).toHaveLength(64); // SHA-256 hex is 64 chars
      expect(entry.projectId).toBe("proj-1");
      expect(entry.title).toBe("Fix CORS issue");
      expect(entry.solution).toBe("Set Access-Control-Allow-Origin header");
      expect(entry.tags).toEqual(["cors", "http"]);
      expect(entry.createdAt).toBeDefined();
      expect(entry.updatedAt).toBeDefined();
    });

    it("should produce deterministic id from projectId + title", () => {
      const entry1 = store.ingest({
        projectId: "proj-1",
        title: "Fix CORS issue",
        solution: "Solution A",
        tags: [],
      });

      // Re-ingest with same projectId + title but different solution
      const entry2 = store.ingest({
        projectId: "proj-1",
        title: "Fix CORS issue",
        solution: "Solution B",
        tags: [],
      });

      expect(entry1.id).toBe(entry2.id);
    });

    it("should store optional fields (symptoms, rootCause, agentId)", () => {
      const entry = store.ingest({
        projectId: "proj-1",
        title: "Memory leak",
        solution: "Close database connections in finally block",
        symptoms: "OOM after 24 hours",
        rootCause: "Unclosed DB connections in error path",
        tags: ["memory", "database"],
        agentId: "agent-coder-1",
      });

      expect(entry.symptoms).toBe("OOM after 24 hours");
      expect(entry.rootCause).toBe("Unclosed DB connections in error path");
      expect(entry.agentId).toBe("agent-coder-1");
    });
  });

  describe("search", () => {
    beforeEach(() => {
      store.ingest({
        projectId: "proj-1",
        title: "Fix CORS issue",
        solution: "Set Access-Control-Allow-Origin header",
        tags: ["cors", "http"],
      });
      store.ingest({
        projectId: "proj-1",
        title: "Fix SQL injection",
        solution: "Use parameterized queries instead of string concatenation",
        tags: ["security", "sql"],
      });
      store.ingest({
        projectId: "proj-2",
        title: "Fix CORS preflight",
        solution: "Handle OPTIONS method and return proper headers",
        tags: ["cors", "http"],
      });
    });

    it("should find entries by FTS5 full-text match", () => {
      const results = store.search({ query: "CORS" });

      expect(results.length).toBeGreaterThanOrEqual(2);
      for (const r of results) {
        const text = `${r.entry.title} ${r.entry.solution}`.toLowerCase();
        expect(text).toContain("cors");
      }
    });

    it("should filter by projectId", () => {
      const results = store.search({ query: "CORS", projectId: "proj-1" });

      expect(results.length).toBe(1);
      expect(results[0].entry.projectId).toBe("proj-1");
    });

    it("should search all projects with crossProject: true", () => {
      const results = store.search({
        query: "CORS",
        projectId: "proj-1",
        crossProject: true,
      });

      expect(results.length).toBeGreaterThanOrEqual(2);
      const projectIds = results.map((r) => r.entry.projectId);
      expect(projectIds).toContain("proj-1");
      expect(projectIds).toContain("proj-2");
    });

    it("should filter by tags", () => {
      const results = store.search({
        query: "Fix",
        tags: ["security"],
      });

      expect(results.length).toBe(1);
      expect(results[0].entry.title).toBe("Fix SQL injection");
    });

    it("should respect limit", () => {
      const results = store.search({ query: "Fix", limit: 1 });

      expect(results.length).toBe(1);
    });

    it("should return rank in results", () => {
      const results = store.search({ query: "CORS" });

      for (const r of results) {
        expect(typeof r.rank).toBe("number");
      }
    });
  });

  describe("upsert (same projectId + title)", () => {
    it("should update existing entry on re-ingest", () => {
      const first = store.ingest({
        projectId: "proj-1",
        title: "Known Issue",
        solution: "Original solution",
        tags: ["v1"],
      });

      const second = store.ingest({
        projectId: "proj-1",
        title: "Known Issue",
        solution: "Updated solution",
        tags: ["v2"],
      });

      expect(second.id).toBe(first.id);
      expect(second.solution).toBe("Updated solution");
      expect(second.tags).toEqual(["v2"]);

      // Verify only one entry in the store
      const stats = store.stats();
      expect(stats.totalEntries).toBe(1);
    });
  });

  describe("get", () => {
    it("should return entry by id", () => {
      const created = store.ingest({
        projectId: "proj-1",
        title: "Test Entry",
        solution: "Test solution",
        tags: [],
      });

      const found = store.get(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      expect(found!.title).toBe("Test Entry");
    });

    it("should return undefined for non-existent id", () => {
      const found = store.get("nonexistent-id");
      expect(found).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("should remove entry and return true", () => {
      const entry = store.ingest({
        projectId: "proj-1",
        title: "To Delete",
        solution: "Delete me",
        tags: [],
      });

      const deleted = store.delete(entry.id);
      expect(deleted).toBe(true);

      const found = store.get(entry.id);
      expect(found).toBeUndefined();
    });

    it("should return false for non-existent id", () => {
      const deleted = store.delete("nonexistent-id");
      expect(deleted).toBe(false);
    });
  });

  describe("stats", () => {
    it("should return correct counts", () => {
      store.ingest({
        projectId: "proj-1",
        title: "Entry A",
        solution: "Sol A",
        tags: [],
      });
      store.ingest({
        projectId: "proj-1",
        title: "Entry B",
        solution: "Sol B",
        tags: [],
      });
      store.ingest({
        projectId: "proj-2",
        title: "Entry C",
        solution: "Sol C",
        tags: [],
      });

      const stats = store.stats();
      expect(stats.totalEntries).toBe(3);
      expect(stats.byProject["proj-1"]).toBe(2);
      expect(stats.byProject["proj-2"]).toBe(1);
    });

    it("should return zero for empty store", () => {
      const stats = store.stats();
      expect(stats.totalEntries).toBe(0);
      expect(Object.keys(stats.byProject)).toHaveLength(0);
    });
  });
});
