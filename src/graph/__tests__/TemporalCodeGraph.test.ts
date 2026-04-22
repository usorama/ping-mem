/**
 * Tests for TemporalCodeGraph.listProjects()
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TemporalCodeGraph } from "../TemporalCodeGraph.js";
import { Neo4jClient } from "../Neo4jClient.js";

describe("TemporalCodeGraph", () => {
  let graph: TemporalCodeGraph;
  let mockNeo4jClient: Neo4jClient;
  let mockSession: any;

  beforeEach(() => {
    // Create mock session
    mockSession = {
      run: vi.fn(),
      close: vi.fn(),
    };

    // Create mock Neo4j client
    mockNeo4jClient = {
      getSession: vi.fn(() => mockSession),
      close: vi.fn(),
    } as any;

    graph = new TemporalCodeGraph({ neo4jClient: mockNeo4jClient });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("listProjects", () => {
    it("should list all projects with metadata", async () => {
      const mockRecords = [
        {
          get: (key: string) => {
            const data: Record<string, any> = {
              projectId: "proj-1",
              rootPath: "/path/to/proj1",
              treeHash: "hash1",
              lastIngestedAt: "2026-01-01T00:00:00Z",
              filesCount: { toNumber: () => 10 },
              chunksCount: { toNumber: () => 50 },
              commitsCount: { toNumber: () => 5 },
            };
            return data[key];
          },
        },
        {
          get: (key: string) => {
            const data: Record<string, any> = {
              projectId: "proj-2",
              rootPath: "/path/to/proj2",
              treeHash: "hash2",
              lastIngestedAt: "2026-01-02T00:00:00Z",
              filesCount: { toNumber: () => 20 },
              chunksCount: { toNumber: () => 100 },
              commitsCount: { toNumber: () => 15 },
            };
            return data[key];
          },
        },
      ];

      mockSession.run.mockResolvedValue({ records: mockRecords });

      const projects = await graph.listProjects();

      expect(projects).toHaveLength(2);
      expect(projects[0]).toEqual({
        projectId: "proj-1",
        rootPath: "/path/to/proj1",
        treeHash: "hash1",
        filesCount: 10,
        chunksCount: 50,
        commitsCount: 5,
        lastIngestedAt: "2026-01-01T00:00:00Z",
      });

      // Verify session was closed (P1 fix - prevent session leaks)
      expect(mockSession.close).toHaveBeenCalled();
    });

    it("should filter by projectId when provided", async () => {
      const mockRecords = [
        {
          get: (key: string) => {
            const data: Record<string, any> = {
              projectId: "proj-1",
              rootPath: "/path/to/proj1",
              treeHash: "hash1",
              lastIngestedAt: "2026-01-01T00:00:00Z",
              filesCount: { toNumber: () => 10 },
              chunksCount: { toNumber: () => 50 },
              commitsCount: { toNumber: () => 5 },
            };
            return data[key];
          },
        },
      ];

      mockSession.run.mockResolvedValue({ records: mockRecords });

      const projects = await graph.listProjects({ projectId: "proj-1" });

      expect(projects).toHaveLength(1);
      expect(projects[0].projectId).toBe("proj-1");

      // Verify WHERE clause was included in query
      const query = mockSession.run.mock.calls[0][0];
      expect(query).toContain("WHERE p.projectId = $projectId");

      // Verify session was closed
      expect(mockSession.close).toHaveBeenCalled();
    });

    it("should respect limit parameter", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await graph.listProjects({ limit: 50 });

      // Verify LIMIT was passed to Neo4j query
      const params = mockSession.run.mock.calls[0][1];
      expect(params.limit.toNumber()).toBe(50);

      // Verify session was closed
      expect(mockSession.close).toHaveBeenCalled();
    });

    it("should sort by lastIngestedAt by default", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await graph.listProjects();

      const query = mockSession.run.mock.calls[0][0];
      expect(query).toContain("ORDER BY p.lastIngestedAt DESC");

      // Verify session was closed
      expect(mockSession.close).toHaveBeenCalled();
    });

    it("should sort by filesCount when specified", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await graph.listProjects({ sortBy: "filesCount" });

      const query = mockSession.run.mock.calls[0][0];
      expect(query).toContain("ORDER BY filesCount DESC");

      // Verify session was closed
      expect(mockSession.close).toHaveBeenCalled();
    });

    it("should sort by rootPath when specified", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await graph.listProjects({ sortBy: "rootPath" });

      const query = mockSession.run.mock.calls[0][0];
      expect(query).toContain("ORDER BY p.rootPath ASC");

      // Verify session was closed
      expect(mockSession.close).toHaveBeenCalled();
    });

    it("should close session even if query fails (P1 fix)", async () => {
      mockSession.run.mockRejectedValue(new Error("Neo4j query failed"));

      await expect(graph.listProjects()).rejects.toThrow("Neo4j query failed");

      // Critical: session MUST be closed in finally block
      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  describe("project-scoped graph identities", () => {
    it("uses project-scoped file keys when querying chunks", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await graph.queryFileChunks("project-a", "src/index.ts");
      const paramsA = mockSession.run.mock.calls[0][1];

      mockSession.run.mockClear();

      await graph.queryFileChunks("project-b", "src/index.ts");
      const paramsB = mockSession.run.mock.calls[0][1];

      expect(paramsA.fileKey).toBeTruthy();
      expect(paramsB.fileKey).toBeTruthy();
      expect(paramsA.fileKey).not.toBe(paramsB.fileKey);
    });

    it("ensures uniqueness constraints for project-scoped nodes", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await graph.ensureConstraints();

      const statements = mockSession.run.mock.calls.map((call) => call[0]);
      expect(statements).toContain(
        "CREATE CONSTRAINT project_id_unique IF NOT EXISTS FOR (p:Project) REQUIRE p.projectId IS UNIQUE",
      );
      expect(statements).toContain(
        "CREATE CONSTRAINT file_key_unique IF NOT EXISTS FOR (f:File) REQUIRE f.fileKey IS UNIQUE",
      );
      expect(statements).toContain(
        "CREATE CONSTRAINT chunk_key_unique IF NOT EXISTS FOR (c:Chunk) REQUIRE c.chunkKey IS UNIQUE",
      );
      expect(statements).toContain(
        "CREATE CONSTRAINT symbol_key_unique IF NOT EXISTS FOR (s:Symbol) REQUIRE s.symbolKey IS UNIQUE",
      );
    });
  });

  describe("deleteProject", () => {
    it("deletes project data in bounded batches and only sweeps orphans", async () => {
      const countRecord = (deleted: number) => ({
        get: (key: string) => {
          if (key !== "deleted") return undefined;
          return { toNumber: () => deleted };
        },
      });

      const responses = [
        { records: [countRecord(25)] },
        { records: [countRecord(3)] },
        { records: [countRecord(0)] },
        { records: [countRecord(25)] },
        { records: [countRecord(2)] },
        { records: [countRecord(0)] },
        { records: [countRecord(25)] },
        { records: [countRecord(4)] },
        { records: [countRecord(0)] },
        { records: [countRecord(1)] },
        { records: [countRecord(25)] },
        { records: [countRecord(1)] },
        { records: [countRecord(0)] },
        { records: [countRecord(25)] },
        { records: [countRecord(5)] },
        { records: [countRecord(0)] },
        { records: [countRecord(25)] },
        { records: [countRecord(6)] },
        { records: [countRecord(0)] },
        { records: [countRecord(25)] },
        { records: [countRecord(7)] },
        { records: [countRecord(0)] },
      ];

      mockSession.run.mockImplementation(async () => {
        const next = responses.shift();
        return next ?? { records: [countRecord(0)] };
      });

      await graph.deleteProject("proj-1");

      const queries = mockSession.run.mock.calls.map((call) => call[0] as string);
      expect(queries[0]).toContain("MATCH ()-[r:STRUCTURAL_EDGE { projectId: $projectId }]->()");
      expect(queries[0]).toContain("LIMIT $batchSize");
      expect(queries[3]).toContain("MATCH (p:Project { projectId: $projectId })-[r:HAS_COMMIT]->()");
      expect(queries[6]).toContain("MATCH (p:Project { projectId: $projectId })-[r:HAS_FILE]->()");
      expect(queries[9]).toContain("MATCH (p:Project { projectId: $projectId })");
      expect(queries[9]).toContain("DELETE p");
      expect(queries[10]).toContain("MATCH (c:Commit)");
      expect(queries[10]).toContain("NOT EXISTS { MATCH (:Project)-[:HAS_COMMIT]->(c) }");
      expect(queries[13]).toContain("MATCH (f:File)");
      expect(queries[13]).toContain("NOT EXISTS { MATCH (:Project)-[:HAS_FILE]->(f) }");
      expect(queries[16]).toContain("MATCH (c:Chunk)");
      expect(queries[16]).toContain("NOT EXISTS { MATCH (:File)-[:HAS_CHUNK]->(c) }");
      expect(queries[19]).toContain("MATCH (s:Symbol)");
      expect(queries[19]).toContain("NOT EXISTS { MATCH (:File)-[:DEFINES_SYMBOL]->(s) }");
      expect(queries[19]).toContain("NOT EXISTS { MATCH (:Chunk)-[:CONTAINS_SYMBOL]->(s) }");

      expect(mockSession.close).toHaveBeenCalledTimes(mockSession.run.mock.calls.length);
    });
  });
});
