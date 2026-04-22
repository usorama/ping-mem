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
});
