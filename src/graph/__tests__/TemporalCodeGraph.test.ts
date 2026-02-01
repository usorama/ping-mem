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
});
