import { describe, expect, test } from "bun:test";
import { CodeIndexer } from "../CodeIndexer.js";

describe("CodeIndexer", () => {
  test("keeps exact matches when normalized BM25 and dense ranges collapse to zero", async () => {
    const qdrant = {
      getClient: () => ({
        search: async () => [
          {
            score: 0.7,
            payload: {
              chunkId: "chunk-1",
              projectId: "project-a",
              filePath: "src/example.ts",
              type: "code",
              content: "export const exactMatch = true;",
              lineStart: 1,
              lineEnd: 1,
            },
          },
        ],
      }),
      getCollectionName: () => "test-collection",
    };

    const bm25Scorer = {
      search: () => [{ chunkId: "chunk-1", score: 2.5 }],
    };

    const indexer = new CodeIndexer({
      qdrantClient: qdrant as any,
      bm25Scorer: bm25Scorer as any,
    });

    const results = await indexer.search("exactMatch", {
      projectId: "project-a",
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.chunkId).toBe("chunk-1");
    expect(results[0]?.projectId).toBe("project-a");
    expect(results[0]?.score).toBeCloseTo(1, 6);
  });

  test("honors filePath filter when combining BM25 and dense candidates", async () => {
    const qdrant = {
      getClient: () => ({
        search: async () => [
          {
            score: 0.8,
            payload: {
              chunkId: "chunk-target",
              projectId: "project-a",
              filePath: "src/target.ts",
              type: "code",
              content: "export const target = true;",
              lineStart: 20,
              lineEnd: 20,
            },
          },
          {
            score: 0.9,
            payload: {
              chunkId: "chunk-other",
              projectId: "project-a",
              filePath: "src/other.ts",
              type: "code",
              content: "export const other = true;",
              lineStart: 10,
              lineEnd: 10,
            },
          },
        ],
      }),
      getCollectionName: () => "test-collection",
    };

    const bm25Scorer = {
      search: () => [
        { chunkId: "chunk-other", score: 3.0 },
        { chunkId: "chunk-target", score: 1.0 },
      ],
    };

    const indexer = new CodeIndexer({
      qdrantClient: qdrant as any,
      bm25Scorer: bm25Scorer as any,
    });

    const results = await indexer.search("target", {
      projectId: "project-a",
      filePath: "src/target.ts",
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.chunkId).toBe("chunk-target");
    expect(results[0]?.filePath).toBe("src/target.ts");
  });

  test("uses file-scoped FTS fast path when filePath is provided", async () => {
    const qdrant = {
      getClient: () => ({ search: async () => [] }),
      getCollectionName: () => "test-collection",
    };

    const bm25Scorer = {
      search: () => [{ chunkId: "chunk-noise", score: 99 }],
    };

    const codeChunkStore = {
      getChunksForFile: () => [],
      search: () => [
        {
          chunkId: "chunk-route",
          projectId: "project-a",
          filePath: "src/http/rest-server.ts",
          content: "this.app.get(\"/api/v1/codebase/projects\", async (c) => {",
          startLine: 3567,
          endLine: 3567,
          chunkType: "block",
          language: "typescript",
          score: 12.3,
        },
      ],
    };

    const indexer = new CodeIndexer({
      qdrantClient: qdrant as any,
      bm25Scorer: bm25Scorer as any,
      codeChunkStore: codeChunkStore as any,
    });

    const results = await indexer.search("/api/v1/codebase/projects", {
      projectId: "project-a",
      filePath: "src/http/rest-server.ts",
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.chunkId).toBe("chunk-route");
    expect(results[0]?.lineStart).toBe(3567);
  });

  test("rejects file-scoped candidates without lexical evidence from rerank fallbacks", async () => {
    const qdrant = {
      getClient: () => ({
        search: async () => [
          {
            score: 0.95,
            payload: {
              chunkId: "chunk-false-positive",
              projectId: "project-a",
              filePath: "src/http/rest-server.ts",
              type: "code",
              content: "private validateApiKey(apiKey: string | undefined): boolean {",
              lineStart: 4047,
              lineEnd: 4064,
            },
          },
        ],
      }),
      getCollectionName: () => "test-collection",
    };

    const bm25Scorer = {
      search: () => [{ chunkId: "chunk-false-positive", score: 2.0 }],
    };

    const codeChunkStore = {
      getChunksForFile: () => [],
      search: () => [],
    };

    const indexer = new CodeIndexer({
      qdrantClient: qdrant as any,
      bm25Scorer: bm25Scorer as any,
      codeChunkStore: codeChunkStore as any,
    });

    const results = await indexer.search("/api/v1/codebase/projects", {
      projectId: "project-a",
      filePath: "src/http/rest-server.ts",
      limit: 5,
    });

    expect(results).toHaveLength(0);
  });

  test("uses deterministic file scan for route-style exact query matches", async () => {
    const qdrant = {
      getClient: () => ({ search: async () => [] }),
      getCollectionName: () => "test-collection",
    };

    const bm25Scorer = {
      search: () => [],
    };

    const codeChunkStore = {
      getChunksForFile: () => [
        {
          chunkId: "chunk-route-direct",
          projectId: "project-a",
          filePath: "src/http/rest-server.ts",
          content: "this.app.get(\"/api/v1/codebase/projects\", async (c) => {",
          startLine: 3567,
          endLine: 3567,
          chunkType: "block",
          language: "typescript",
        },
      ],
      search: () => [],
    };

    const indexer = new CodeIndexer({
      qdrantClient: qdrant as any,
      bm25Scorer: bm25Scorer as any,
      codeChunkStore: codeChunkStore as any,
    });

    const results = await indexer.search("/api/v1/codebase/projects", {
      projectId: "project-a",
      filePath: "src/http/rest-server.ts",
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.chunkId).toBe("chunk-route-direct");
    expect(results[0]?.lineStart).toBe(3567);
  });

  test("prefers tighter exact-match chunks over broad file chunks", async () => {
    const qdrant = {
      getClient: () => ({ search: async () => [] }),
      getCollectionName: () => "test-collection",
    };

    const bm25Scorer = {
      search: () => [],
    };

    const codeChunkStore = {
      getChunksForFile: () => [
        {
          chunkId: "file-chunk",
          projectId: "project-a",
          filePath: "src/http/rest-server.ts",
          content: "// File: src/http/rest-server.ts (part 3)\nthis.app.get(\"/api/v1/search\", async (c) => {\n ... large block ...",
          startLine: 1587,
          endLine: 2427,
          chunkType: "file",
          language: "typescript",
        },
        {
          chunkId: "route-chunk",
          projectId: "project-a",
          filePath: "src/http/rest-server.ts",
          content: "this.app.get(\"/api/v1/search\", async (c) => {\n  return c.json({ ok: true });\n});",
          startLine: 1910,
          endLine: 1912,
          chunkType: "block",
          language: "typescript",
        },
      ],
      search: () => [],
    };

    const indexer = new CodeIndexer({
      qdrantClient: qdrant as any,
      bm25Scorer: bm25Scorer as any,
      codeChunkStore: codeChunkStore as any,
    });

    const results = await indexer.search("/api/v1/search", {
      projectId: "project-a",
      filePath: "src/http/rest-server.ts",
      limit: 5,
    });

    expect(results[0]?.chunkId).toBe("route-chunk");
    expect(results[0]?.lineStart).toBe(1910);
  });

  test("prefers chunks where the exact symbol match appears earlier", async () => {
    const qdrant = {
      getClient: () => ({ search: async () => [] }),
      getCollectionName: () => "test-collection",
    };

    const bm25Scorer = {
      search: () => [],
    };

    const codeChunkStore = {
      getChunksForFile: () => [
        {
          chunkId: "overlap-chunk",
          projectId: "project-a",
          filePath: "auto_os/tools/agent_store.py",
          content: [
            "def _get_connection() -> sqlite3.Connection:",
            "    pass",
            "",
            "def persist_output(agent_name: str, output_type: str, payload: dict) -> int:",
            "    pass",
          ].join("\n"),
          startLine: 49,
          endLine: 64,
          chunkType: "function",
          language: "python",
        },
        {
          chunkId: "definition-chunk",
          projectId: "project-a",
          filePath: "auto_os/tools/agent_store.py",
          content: [
            "def persist_output(agent_name: str, output_type: str, payload: dict) -> int:",
            "    pass",
          ].join("\n"),
          startLine: 61,
          endLine: 88,
          chunkType: "function",
          language: "python",
        },
      ],
      search: () => [],
    };

    const indexer = new CodeIndexer({
      qdrantClient: qdrant as any,
      bm25Scorer: bm25Scorer as any,
      codeChunkStore: codeChunkStore as any,
    });

    const results = await indexer.search("persist_output", {
      projectId: "project-a",
      filePath: "auto_os/tools/agent_store.py",
      limit: 5,
    });

    expect(results[0]?.chunkId).toBe("definition-chunk");
    expect(results[0]?.lineStart).toBe(61);
  });
});
