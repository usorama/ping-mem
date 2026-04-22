import { describe, expect, test } from "bun:test";
import { createProjectScopedId, normalizeIngestionIdentity } from "../identity.js";
import type { IngestionResult } from "../IngestionOrchestrator.js";

describe("ingestion identity normalization", () => {
  test("project-scoped IDs stay stable within a project and diverge across projects", () => {
    const localId = "chunk-local-id";
    expect(createProjectScopedId("project-a", localId)).toBe(
      createProjectScopedId("project-a", localId),
    );
    expect(createProjectScopedId("project-a", localId)).not.toBe(
      createProjectScopedId("project-b", localId),
    );
  });

  test("normalizes chunk, parent chunk, and symbol IDs by project", () => {
    const baseResult: IngestionResult = {
      projectId: "project-a",
      projectManifest: {
        projectId: "project-a",
        rootPath: "/tmp/project-a",
        treeHash: "tree-a",
        files: [],
        generatedAt: "2026-04-22T00:00:00Z",
        schemaVersion: 1,
      },
      codeFiles: [
        {
          filePath: "src/index.ts",
          sha256: "sha-index",
          chunks: [
            {
              chunkId: "parent-local",
              type: "class",
              start: 0,
              end: 10,
              lineStart: 1,
              lineEnd: 3,
              content: "class Foo {}",
            },
            {
              chunkId: "child-local",
              type: "function",
              start: 11,
              end: 20,
              lineStart: 4,
              lineEnd: 5,
              content: "function bar() {}",
              parentChunkId: "parent-local",
            },
          ],
          symbols: [
            {
              symbolId: "symbol-local",
              name: "Foo",
              kind: "class",
              filePath: "src/index.ts",
              startLine: 1,
              endLine: 3,
            },
          ],
        },
      ],
      gitHistory: {
        commits: [],
        fileChanges: [],
        hunks: [],
      },
      ingestedAt: "2026-04-22T00:00:00Z",
    };

    const normalizedA = normalizeIngestionIdentity(baseResult);
    const normalizedB = normalizeIngestionIdentity({
      ...baseResult,
      projectId: "project-b",
      projectManifest: {
        ...baseResult.projectManifest,
        projectId: "project-b",
        rootPath: "/tmp/project-b",
      },
    });

    const parentA = normalizedA.codeFiles[0]!.chunks[0]!;
    const childA = normalizedA.codeFiles[0]!.chunks[1]!;
    const symbolA = normalizedA.codeFiles[0]!.symbols[0]!;
    const parentB = normalizedB.codeFiles[0]!.chunks[0]!;
    const childB = normalizedB.codeFiles[0]!.chunks[1]!;
    const symbolB = normalizedB.codeFiles[0]!.symbols[0]!;

    expect(parentA.chunkId).toBe(createProjectScopedId("project-a", "parent-local"));
    expect(childA.parentChunkId).toBe(parentA.chunkId);
    expect(symbolA.symbolId).toBe(createProjectScopedId("project-a", "symbol-local"));

    expect(parentB.chunkId).toBe(createProjectScopedId("project-b", "parent-local"));
    expect(childB.parentChunkId).toBe(parentB.chunkId);
    expect(symbolB.symbolId).toBe(createProjectScopedId("project-b", "symbol-local"));

    expect(parentA.chunkId).not.toBe(parentB.chunkId);
    expect(symbolA.symbolId).not.toBe(symbolB.symbolId);
  });
});
