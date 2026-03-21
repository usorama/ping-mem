/**
 * Tests for MaintenanceRunner
 * @module maintenance/__tests__/MaintenanceRunner.test
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MaintenanceRunner } from "../MaintenanceRunner.js";
import { EventStore } from "../../storage/EventStore.js";

describe("MaintenanceRunner", () => {
  let eventStore: EventStore;

  beforeEach(() => {
    eventStore = new EventStore({ dbPath: ":memory:" });
  });

  afterEach(async () => {
    await eventStore.close();
  });

  it("runs full cycle without errors on empty store", async () => {
    const runner = new MaintenanceRunner({
      eventStore,
      relevanceEngine: null,
    });

    const result = await runner.run();

    expect(result.dedupCount).toBe(0);
    expect(result.consolidateResult.archivedCount).toBe(0);
    expect(result.consolidateResult.digestsCreated).toBe(0);
    expect(result.pruneCount).toBe(0);
    expect(result.vacuumRan).toBe(false);
    expect(result.exportedCount).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("supports dryRun mode", async () => {
    const runner = new MaintenanceRunner({
      eventStore,
      relevanceEngine: null,
    });

    const result = await runner.run({ dryRun: true });

    expect(result.dedupCount).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("dedup finds duplicate keys", async () => {
    // Create a session first
    const sessionId = eventStore.createEvent("test-session", "SESSION_STARTED", {
      name: "test",
    });

    // Create duplicate memories with same key
    eventStore.createEvent("test-session", "CONTEXT_SAVED", {
      memoryId: "mem-1",
      key: "duplicate-key",
      value: "first value",
    });
    eventStore.createEvent("test-session", "CONTEXT_SAVED", {
      memoryId: "mem-2",
      key: "duplicate-key",
      value: "second value",
    });

    const runner = new MaintenanceRunner({
      eventStore,
      relevanceEngine: null,
    });

    // Dry run should report 1 dedup candidate
    const dryResult = await runner.run({ dryRun: true });
    expect(dryResult.dedupCount).toBe(1);

    // Actual run should supersede the duplicate
    const result = await runner.run();
    expect(result.dedupCount).toBe(1);
  });

  it("vacuum does not run when WAL is small", async () => {
    const runner = new MaintenanceRunner({
      eventStore,
      relevanceEngine: null,
    });

    const result = await runner.run({ walThreshold: 50_000_000 });
    expect(result.vacuumRan).toBe(false);
    expect(result.walSizeBefore).toBe(0); // in-memory DB has no WAL
  });

  it("returns complete result shape", async () => {
    const runner = new MaintenanceRunner({
      eventStore,
      relevanceEngine: null,
    });

    const result = await runner.run();

    // Verify all fields exist
    expect(typeof result.dedupCount).toBe("number");
    expect(typeof result.consolidateResult).toBe("object");
    expect(typeof result.consolidateResult.archivedCount).toBe("number");
    expect(typeof result.consolidateResult.digestsCreated).toBe("number");
    expect(typeof result.pruneCount).toBe("number");
    expect(typeof result.vacuumRan).toBe("boolean");
    expect(typeof result.walSizeBefore).toBe("number");
    expect(typeof result.walSizeAfter).toBe("number");
    expect(typeof result.exportedCount).toBe("number");
    expect(typeof result.durationMs).toBe("number");
  });
});
