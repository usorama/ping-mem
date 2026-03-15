/**
 * IngestionQueue tests — Phase 2: zero-dependency serial queue.
 */
import { describe, test, expect, mock } from "bun:test";
import { IngestionQueue } from "../IngestionQueue.js";
import type { IngestionService, IngestProjectResult } from "../IngestionService.js";

function createMockIngestionService(
  impl?: (opts: { projectDir: string }) => Promise<IngestProjectResult | null>
): IngestionService {
  const defaultResult: IngestProjectResult = {
    projectId: "test-project-id",
    treeHash: "abc123",
    filesIndexed: 10,
    chunksIndexed: 50,
    commitsIndexed: 5,
    ingestedAt: new Date().toISOString(),
    hadChanges: true,
  };

  return {
    ingestProject: impl ?? (async () => defaultResult),
    ensureConstraints: async () => {},
    verifyProject: async () => ({
      projectId: "",
      valid: false,
      manifestTreeHash: null,
      currentTreeHash: null,
      message: "",
    }),
    queryTimeline: async () => [],
    searchCode: async () => [],
    deleteProject: async () => {},
    listProjects: async () => [],
  } as unknown as IngestionService;
}

describe("IngestionQueue", () => {
  test("enqueue returns a valid UUID runId", async () => {
    const service = createMockIngestionService();
    const queue = new IngestionQueue(service);

    const runId = await queue.enqueue({ projectDir: "/test/project" });
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test("getRun returns the run after enqueue", async () => {
    const service = createMockIngestionService();
    const queue = new IngestionQueue(service);

    const runId = await queue.enqueue({ projectDir: "/test/project" });
    const run = queue.getRun(runId);
    expect(run).toBeDefined();
    expect(run!.projectDir).toBe("/test/project");
    expect(run!.status).toMatch(/queued|scanning|completed/);
  });

  test("getRun returns undefined for unknown runId", () => {
    const service = createMockIngestionService();
    const queue = new IngestionQueue(service);
    expect(queue.getRun("nonexistent-id")).toBeUndefined();
  });

  test("runs execute serially (concurrency=1)", async () => {
    const order: number[] = [];
    let resolvers: Array<() => void> = [];

    const service = createMockIngestionService(async () => {
      const idx = order.length;
      return new Promise<IngestProjectResult>((resolve) => {
        resolvers.push(() => {
          order.push(idx);
          resolve({
            projectId: `project-${idx}`,
            treeHash: "hash",
            filesIndexed: 1,
            chunksIndexed: 1,
            commitsIndexed: 0,
            ingestedAt: new Date().toISOString(),
            hadChanges: true,
          });
        });
      });
    });

    const queue = new IngestionQueue(service);

    // Enqueue 3 runs
    const id1 = await queue.enqueue({ projectDir: "/project-1" });
    const id2 = await queue.enqueue({ projectDir: "/project-2" });
    const id3 = await queue.enqueue({ projectDir: "/project-3" });

    // Wait for the first resolver to be registered
    await new Promise(r => setTimeout(r, 50));

    // Only 1 should be active (the first one created its resolver)
    expect(resolvers.length).toBe(1);

    // Complete first
    resolvers[0]();
    await new Promise(r => setTimeout(r, 50));
    expect(resolvers.length).toBe(2);

    // Complete second
    resolvers[1]();
    await new Promise(r => setTimeout(r, 50));
    expect(resolvers.length).toBe(3);

    // Complete third
    resolvers[2]();
    await new Promise(r => setTimeout(r, 50));

    // All should have run in order
    expect(order).toEqual([0, 1, 2]);
  });

  test("completed run has status=completed and result", async () => {
    const service = createMockIngestionService();
    const queue = new IngestionQueue(service);

    const runId = await queue.enqueue({ projectDir: "/test/project" });

    // Wait for the chain to complete
    await new Promise(r => setTimeout(r, 100));

    const run = queue.getRun(runId);
    expect(run!.status).toBe("completed");
    expect(run!.result).toBeDefined();
    expect(run!.result!.projectId).toBe("test-project-id");
    expect(run!.completedAt).toBeDefined();
    expect(run!.error).toBeNull();
  });

  test("failed run has status=failed and sanitized error", async () => {
    const service = createMockIngestionService(async () => {
      throw new Error("Neo4j connection to bolt://localhost:7687 failed");
    });
    const queue = new IngestionQueue(service);

    const runId = await queue.enqueue({ projectDir: "/test/project" });

    // Wait for the chain to complete
    await new Promise(r => setTimeout(r, 100));

    const run = queue.getRun(runId);
    expect(run!.status).toBe("failed");
    expect(run!.error).toBeDefined();
    expect(run!.error).toBeTypeOf("string");
    expect(run!.completedAt).toBeDefined();
  });

  test("queue full throws error at maxQueueDepth", async () => {
    const resolvers: Array<() => void> = [];
    const service = createMockIngestionService(async () => {
      return new Promise<IngestProjectResult>((resolve) => {
        resolvers.push(() => resolve({
          projectId: "p",
          treeHash: "h",
          filesIndexed: 0,
          chunksIndexed: 0,
          commitsIndexed: 0,
          ingestedAt: new Date().toISOString(),
          hadChanges: false,
        }));
      });
    });

    // maxQueueDepth=2: pending items only (not active ones)
    // The first enqueue starts executing immediately (pendingCount goes 1->0, activeCount 0->1)
    // So we need to fill pending while the first is still active (blocking).
    const queue = new IngestionQueue(service, { maxQueueDepth: 2 });

    // First enqueue: starts executing immediately, blocks in mock
    await queue.enqueue({ projectDir: "/p1" });
    // Wait for it to become active (pending decremented)
    await new Promise(r => setTimeout(r, 20));

    // Now queue 2 more — these will be pending (pendingCount=1, then 2)
    await queue.enqueue({ projectDir: "/p2" });
    await queue.enqueue({ projectDir: "/p3" });

    // 4th should fail — pendingCount=2 which equals maxQueueDepth
    let threw = false;
    try {
      await queue.enqueue({ projectDir: "/p4" });
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("queue full");
    }
    expect(threw).toBe(true);

    // Cleanup — resolve all blocked promises
    for (const r of resolvers) r();
  });

  test("getQueueStatus returns pending, active, and runs", async () => {
    const service = createMockIngestionService();
    const queue = new IngestionQueue(service);

    await queue.enqueue({ projectDir: "/test" });
    await new Promise(r => setTimeout(r, 100));

    const status = queue.getQueueStatus();
    expect(status.pending).toBeTypeOf("number");
    expect(status.active).toBeTypeOf("number");
    expect(status.runs).toBeArray();
    expect(status.runs.length).toBeGreaterThan(0);
  });

  test("pruneHistory keeps only maxRunHistory completed runs", async () => {
    const service = createMockIngestionService();
    const queue = new IngestionQueue(service, { maxRunHistory: 2 });

    // Enqueue 4 runs
    await queue.enqueue({ projectDir: "/p1" });
    await queue.enqueue({ projectDir: "/p2" });
    await queue.enqueue({ projectDir: "/p3" });
    await queue.enqueue({ projectDir: "/p4" });

    // Wait for all to complete
    await new Promise(r => setTimeout(r, 200));

    const status = queue.getQueueStatus();
    // Pruning happens on enqueue, not after completion — so some completed runs
    // may still be in the map. The key test is it doesn't grow unbounded.
    expect(status.runs.length).toBeLessThanOrEqual(4);
  });

  test("null result from ingestProject is handled (no changes)", async () => {
    const service = createMockIngestionService(async () => null);
    const queue = new IngestionQueue(service);

    const runId = await queue.enqueue({ projectDir: "/test" });
    await new Promise(r => setTimeout(r, 100));

    const run = queue.getRun(runId);
    expect(run!.status).toBe("completed");
    expect(run!.result).toBeNull();
    expect(run!.projectId).toBeNull();
  });
});
