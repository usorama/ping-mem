/**
 * Phase 3 tests: IngestionEventEmitter + event wiring.
 */
import { describe, test, expect } from "bun:test";
import { IngestionEventEmitter, type IngestionEvent } from "../IngestionEventEmitter.js";

describe("IngestionEventEmitter", () => {
  test("emitIngestion fires 'ingestion' event with correct data", () => {
    const emitter = new IngestionEventEmitter();
    const received: IngestionEvent[] = [];

    emitter.onIngestion((event) => {
      received.push(event);
    });

    const eventData: IngestionEvent = {
      eventType: "CODEBASE_INGESTION_STARTED",
      runId: "test-run-1",
      projectDir: "/test/project",
    };

    emitter.emitIngestion(eventData);

    expect(received.length).toBe(1);
    expect(received[0].eventType).toBe("CODEBASE_INGESTION_STARTED");
    expect(received[0].runId).toBe("test-run-1");
    expect(received[0].projectDir).toBe("/test/project");
  });

  test("emitIngestion fires completed event with all fields", () => {
    const emitter = new IngestionEventEmitter();
    const received: IngestionEvent[] = [];

    emitter.onIngestion((event) => received.push(event));

    emitter.emitIngestion({
      eventType: "CODEBASE_INGESTION_COMPLETED",
      runId: "run-2",
      projectDir: "/test",
      projectId: "proj-abc",
      filesIndexed: 42,
      chunksIndexed: 200,
      commitsIndexed: 15,
      durationMs: 5000,
    });

    expect(received.length).toBe(1);
    expect(received[0].projectId).toBe("proj-abc");
    expect(received[0].filesIndexed).toBe(42);
    expect(received[0].durationMs).toBe(5000);
  });

  test("emitIngestion fires failed event with error", () => {
    const emitter = new IngestionEventEmitter();
    const received: IngestionEvent[] = [];

    emitter.onIngestion((event) => received.push(event));

    emitter.emitIngestion({
      eventType: "CODEBASE_INGESTION_FAILED",
      runId: "run-3",
      projectDir: "/test",
      phase: "persisting_neo4j",
      error: "Connection refused",
      durationMs: 1200,
    });

    expect(received.length).toBe(1);
    expect(received[0].eventType).toBe("CODEBASE_INGESTION_FAILED");
    expect(received[0].phase).toBe("persisting_neo4j");
    expect(received[0].error).toBe("Connection refused");
  });

  test("multiple listeners receive the same event", () => {
    const emitter = new IngestionEventEmitter();
    let count = 0;

    emitter.onIngestion(() => count++);
    emitter.onIngestion(() => count++);

    emitter.emitIngestion({
      eventType: "CODEBASE_INGESTION_STARTED",
      runId: "run-4",
      projectDir: "/test",
    });

    expect(count).toBe(2);
  });

  test("offIngestion removes listener", () => {
    const emitter = new IngestionEventEmitter();
    let count = 0;
    const handler = () => count++;

    emitter.onIngestion(handler);
    emitter.emitIngestion({
      eventType: "CODEBASE_INGESTION_STARTED",
      runId: "run-5",
      projectDir: "/test",
    });
    expect(count).toBe(1);

    emitter.offIngestion(handler);
    emitter.emitIngestion({
      eventType: "CODEBASE_INGESTION_STARTED",
      runId: "run-6",
      projectDir: "/test",
    });
    expect(count).toBe(1); // not incremented
  });

  test("no listeners does not throw", () => {
    const emitter = new IngestionEventEmitter();
    // Should not throw even with no listeners
    expect(() => {
      emitter.emitIngestion({
        eventType: "CODEBASE_INGESTION_STARTED",
        runId: "run-7",
        projectDir: "/test",
      });
    }).not.toThrow();
  });
});

describe("IngestionEventData type in types/index.ts", () => {
  test("IngestionEventData interface is importable and usable", async () => {
    const { type } = await import("../../types/index.js");
    // Just verify the import doesn't crash — the interface exists at compile time
    // We verify the shape by constructing a conforming object
    const data: import("../../types/index.js").IngestionEventData = {
      runId: "test",
      projectDir: "/test",
      projectId: "abc",
      phase: "scanning",
      filesIndexed: 10,
      chunksIndexed: 50,
      commitsIndexed: 5,
      durationMs: 1000,
      error: "test error",
    };
    expect(data.runId).toBe("test");
    expect(data.projectDir).toBe("/test");
  });
});

describe("EventType includes ingestion types", () => {
  test("CODEBASE_INGESTION_* types are valid EventType values", () => {
    // We can't directly test a type union at runtime, but we can verify
    // the types compile by importing and assigning
    const started: import("../../types/index.js").EventType = "CODEBASE_INGESTION_STARTED";
    const completed: import("../../types/index.js").EventType = "CODEBASE_INGESTION_COMPLETED";
    const failed: import("../../types/index.js").EventType = "CODEBASE_INGESTION_FAILED";
    expect(started).toBe("CODEBASE_INGESTION_STARTED");
    expect(completed).toBe("CODEBASE_INGESTION_COMPLETED");
    expect(failed).toBe("CODEBASE_INGESTION_FAILED");
  });
});
