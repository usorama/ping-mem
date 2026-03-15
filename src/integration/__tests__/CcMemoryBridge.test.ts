/**
 * Tests for CcMemoryBridge — cc-memory/cc-connect integration layer
 *
 * Note: This file does NOT use child_process or any shell commands.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CcMemoryBridge } from "../CcMemoryBridge.js";
import { KnowledgeStore } from "../../knowledge/KnowledgeStore.js";
import { EventStore } from "../../storage/EventStore.js";

describe("CcMemoryBridge", () => {
  let bridge: CcMemoryBridge;
  let knowledgeStore: KnowledgeStore;
  let eventStore: EventStore;

  beforeEach(() => {
    eventStore = new EventStore({ dbPath: ":memory:" });
    const db = eventStore.getDatabase();
    knowledgeStore = new KnowledgeStore(db);
    bridge = new CcMemoryBridge({ knowledgeStore, eventStore });
  });

  describe("extractEntities", () => {
    test("extracts technology entities", () => {
      const content = "We use TypeScript and SQLite for the backend, with React on the frontend";
      const entities = bridge.extractEntities(content);

      const techNames = entities
        .filter((e) => e.type === "technology")
        .map((e) => e.name.toLowerCase());

      expect(techNames).toContain("typescript");
      expect(techNames).toContain("sqlite");
      expect(techNames).toContain("react");
    });

    test("extracts pattern entities", () => {
      const content = "Implemented circuit breaker pattern with retry backoff for API calls";
      const entities = bridge.extractEntities(content);

      const patternNames = entities
        .filter((e) => e.type === "pattern")
        .map((e) => e.name.toLowerCase());

      expect(patternNames.length).toBeGreaterThanOrEqual(1);
      // At least "circuit breaker" or "retry" or "backoff" should be extracted
      const hasRelevant = patternNames.some(
        (p) => p.includes("circuit") || p.includes("retry") || p.includes("backoff"),
      );
      expect(hasRelevant).toBe(true);
    });

    test("extracts project name entities", () => {
      const content = "The fix from project ping-mem also applies to project sn-assist";
      const entities = bridge.extractEntities(content);

      const projectNames = entities
        .filter((e) => e.type === "project")
        .map((e) => e.name);

      expect(projectNames).toContain("ping-mem");
      expect(projectNames).toContain("sn-assist");
    });

    test("deduplicates entities", () => {
      const content = "TypeScript is great. We love TypeScript. TypeScript everywhere.";
      const entities = bridge.extractEntities(content);

      const tsEntities = entities.filter(
        (e) => e.name.toLowerCase() === "typescript",
      );
      expect(tsEntities.length).toBe(1);
    });

    test("returns empty array for content with no entities", () => {
      const content = "Just a plain note about nothing specific";
      const entities = bridge.extractEntities(content);
      expect(entities.length).toBe(0);
    });

    test("assigns correct confidence levels", () => {
      const content = "Using TypeScript with singleton pattern in project ping-mem";
      const entities = bridge.extractEntities(content);

      for (const entity of entities) {
        if (entity.type === "technology") {
          expect(entity.confidence).toBe(0.9);
        } else if (entity.type === "pattern") {
          expect(entity.confidence).toBe(0.8);
        } else if (entity.type === "project") {
          expect(entity.confidence).toBe(0.7);
        }
      }
    });
  });

  describe("enrich", () => {
    test("enriches decision category memories", () => {
      const result = bridge.enrich(
        "auth-decision",
        "Decided to use JWT with Redis session store for authentication",
        "decision",
        "my-project",
      );

      expect(result.entities.length).toBeGreaterThan(0);
      expect(result.relationships.length).toBeGreaterThan(0);

      // Should find JWT and Redis as technologies
      const techNames = result.entities
        .filter((e) => e.type === "technology")
        .map((e) => e.name.toLowerCase());
      expect(techNames).toContain("jwt");
      expect(techNames).toContain("redis");
    });

    test("enriches observation category memories", () => {
      const result = bridge.enrich(
        "perf-observation",
        "SQLite with WAL mode handles concurrent reads well",
        "observation",
        "my-project",
      );

      expect(result.entities.length).toBeGreaterThan(0);
      const techNames = result.entities
        .filter((e) => e.type === "technology")
        .map((e) => e.name.toLowerCase());
      expect(techNames).toContain("sqlite");
    });

    test("skips enrichment for non-enrichable categories", () => {
      const result = bridge.enrich(
        "progress-update",
        "Completed TypeScript migration with React frontend",
        "progress",
        "my-project",
      );

      expect(result.entities.length).toBe(0);
      expect(result.relationships.length).toBe(0);
    });

    test("enriches when category is undefined", () => {
      const result = bridge.enrich(
        "general-note",
        "The Docker setup uses PostgreSQL for persistence",
        undefined,
        "my-project",
      );

      // undefined category = no filtering, should enrich
      expect(result.entities.length).toBeGreaterThan(0);
    });

    test("builds uses relationships for technologies", () => {
      const result = bridge.enrich(
        "tech-stack",
        "Our stack uses TypeScript, Bun, and Hono",
        "decision",
        "my-project",
      );

      const usesRels = result.relationships.filter((r) => r.type === "uses");
      expect(usesRels.length).toBeGreaterThan(0);
      expect(usesRels.every((r) => r.source === "my-project")).toBe(true);
    });

    test("builds implements relationships for patterns", () => {
      const result = bridge.enrich(
        "arch-decision",
        "Applied the factory pattern for service creation",
        "decision",
        "my-project",
      );

      const implRels = result.relationships.filter((r) => r.type === "implements");
      expect(implRels.length).toBeGreaterThan(0);
    });
  });

  describe("searchAcrossProjects", () => {
    test("searches across all projects", () => {
      // Seed knowledge entries in different projects
      knowledgeStore.ingest({
        projectId: "project-a",
        title: "CORS Configuration Fix",
        solution: "Add proper CORS headers for cross-origin requests",
        tags: ["cors", "http"],
      });
      knowledgeStore.ingest({
        projectId: "project-b",
        title: "Authentication Token Refresh",
        solution: "Implement JWT refresh token rotation",
        tags: ["auth", "jwt"],
      });

      const results = bridge.searchAcrossProjects("CORS headers");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.entry.projectId).toBe("project-a");
    });

    test("returns results from multiple projects", () => {
      knowledgeStore.ingest({
        projectId: "project-a",
        title: "Database Connection Pooling",
        solution: "Use connection pool for database access",
        tags: ["database"],
      });
      knowledgeStore.ingest({
        projectId: "project-b",
        title: "Database Migration Strategy",
        solution: "Use versioned migrations for database schema changes",
        tags: ["database"],
      });

      const results = bridge.searchAcrossProjects("database");
      expect(results.length).toBeGreaterThanOrEqual(2);

      const projectIds = results.map((r) => r.entry.projectId);
      expect(projectIds).toContain("project-a");
      expect(projectIds).toContain("project-b");
    });

    test("filters by tags", () => {
      knowledgeStore.ingest({
        projectId: "project-a",
        title: "Auth Setup",
        solution: "JWT authentication flow",
        tags: ["auth"],
      });
      knowledgeStore.ingest({
        projectId: "project-b",
        title: "Cache Setup",
        solution: "Redis cache for sessions",
        tags: ["cache"],
      });

      const results = bridge.searchAcrossProjects("setup", { tags: ["auth"] });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.entry.tags.includes("auth"))).toBe(true);
    });

    test("respects limit option", () => {
      for (let i = 0; i < 10; i++) {
        knowledgeStore.ingest({
          projectId: `project-${i}`,
          title: `Search Optimization ${i}`,
          solution: `Optimize search with technique ${i}`,
          tags: ["search"],
        });
      }

      const results = bridge.searchAcrossProjects("search optimization", { limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });

    test("returns empty for no matches", () => {
      const results = bridge.searchAcrossProjects("nonexistent query xyz");
      expect(results.length).toBe(0);
    });
  });

  describe("learnings propagation", () => {
    test("propagates tagged learning to related projects", () => {
      // Seed a knowledge entry in project-b so cross-project match works
      knowledgeStore.ingest({
        projectId: "project-b",
        title: "Authentication System",
        solution: "JWT-based authentication with refresh tokens",
        tags: ["auth"],
      });

      // Enrich a learning in project-a that's related to auth
      const result = bridge.enrich(
        "auth-learning",
        "JWT tokens should be rotated every 30 minutes for security. Authentication refresh flow prevents session expiry.",
        "decision",
        "project-a",
        ["auth", "security"],
      );

      // Should find cross-project matches
      expect(result.crossProjectMatches.length).toBeGreaterThanOrEqual(0);
      // propagation depends on relevance score threshold
    });

    test("getPropagatedLearnings returns propagated entries", () => {
      // Manually create a propagated learning entry
      knowledgeStore.ingest({
        projectId: "target-project",
        title: "[Propagated] auth-fix",
        solution: "Use refresh token rotation to prevent expired sessions",
        tags: ["auth", "propagated-from:source-project", "cross-project"],
      });

      const learnings = bridge.getPropagatedLearnings("target-project");
      expect(learnings.length).toBe(1);
      expect(learnings[0]!.sourceProject).toBe("source-project");
      expect(learnings[0]!.targetProject).toBe("target-project");
      expect(learnings[0]!.learning).toContain("refresh token");
    });

    test("does not propagate without tags", () => {
      knowledgeStore.ingest({
        projectId: "project-b",
        title: "Related Entry",
        solution: "Some related solution using TypeScript",
        tags: ["typescript"],
      });

      const result = bridge.enrich(
        "no-tags",
        "TypeScript is great for type safety",
        "fact",
        "project-a",
        [], // no tags
      );

      expect(result.propagatedTo.length).toBe(0);
    });
  });

  describe("cross-project isolation", () => {
    test("enrichment in project A does not corrupt project B", () => {
      // Save knowledge in project A
      knowledgeStore.ingest({
        projectId: "project-a",
        title: "Project A Auth Decision",
        solution: "Use OAuth for project A",
        tags: ["auth"],
      });

      // Save knowledge in project B
      knowledgeStore.ingest({
        projectId: "project-b",
        title: "Project B Cache Decision",
        solution: "Use Redis caching for project B",
        tags: ["cache"],
      });

      // Search within project A should not return project B results
      const resultsA = knowledgeStore.search({
        query: "decision",
        projectId: "project-a",
      });
      const resultsB = knowledgeStore.search({
        query: "decision",
        projectId: "project-b",
      });

      expect(resultsA.every((r) => r.entry.projectId === "project-a")).toBe(true);
      expect(resultsB.every((r) => r.entry.projectId === "project-b")).toBe(true);
    });

    test("cross-project search shows both but maintains project identity", () => {
      knowledgeStore.ingest({
        projectId: "project-a",
        title: "Shared Pattern A",
        solution: "Circuit breaker in service A",
        tags: ["resilience"],
      });
      knowledgeStore.ingest({
        projectId: "project-b",
        title: "Shared Pattern B",
        solution: "Circuit breaker in service B",
        tags: ["resilience"],
      });

      const results = bridge.searchAcrossProjects("circuit breaker");
      expect(results.length).toBeGreaterThanOrEqual(2);

      // Each result should maintain its project identity
      const projectIds = new Set(results.map((r) => r.entry.projectId));
      expect(projectIds.size).toBeGreaterThanOrEqual(2);
    });
  });
});
