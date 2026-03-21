/**
 * Tests for supersede-never-delete memory semantics.
 *
 * When a memory is saved with a key that already exists, the old memory
 * is marked as superseded (not deleted) and a MEMORY_SUPERSEDED event
 * is recorded.
 *
 * @module memory/__tests__/supersede-semantics.test
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  MemoryManager,
  createTestMemoryManager,
} from "../MemoryManager.js";
import { createInMemoryEventStore, EventStore } from "../../storage/EventStore.js";
import type { Memory, EventType } from "../../types/index.js";

describe("Supersede-Never-Delete Semantics", () => {
  let memoryManager: MemoryManager;
  let eventStore: EventStore;
  const testSessionId = "session-supersede-001";

  beforeEach(() => {
    eventStore = createInMemoryEventStore();
    memoryManager = new MemoryManager({
      sessionId: testSessionId,
      eventStore,
    });
  });

  afterEach(async () => {
    await memoryManager.close();
  });

  describe("save with new key", () => {
    it("should save normally with status=active metadata", async () => {
      const memory = await memoryManager.supersede("new-key", "some value", {
        category: "note",
      });

      expect(memory.key).toBe("new-key");
      expect(memory.value).toBe("some value");
      expect(memory.metadata.status).toBe("active");
    });
  });

  describe("supersede with existing key", () => {
    it("should mark old memory as superseded and create new active memory", async () => {
      // Save initial memory
      const original = await memoryManager.save("my-key", "original value", {
        category: "decision",
        metadata: { source: "user" },
      });

      // Supersede with new value
      const replacement = await memoryManager.supersede("my-key", "updated value", {
        category: "decision",
      });

      // New memory should be active and reference the old one
      expect(replacement.key).toBe("my-key");
      expect(replacement.value).toBe("updated value");
      expect(replacement.metadata.status).toBe("active");
      expect(replacement.metadata.supersedes).toBe(original.id);

      // Old memory should still exist but under a superseded key
      const supersededKey = `my-key::superseded::${original.id}`;
      const oldMemory = await memoryManager.get(supersededKey);
      expect(oldMemory).not.toBeNull();
      expect(oldMemory!.metadata.status).toBe("superseded");
      expect(oldMemory!.metadata.supersededBy).toBe(replacement.id);
      expect(oldMemory!.metadata.originalKey).toBe("my-key");
      // Original value is preserved
      expect(oldMemory!.value).toBe("original value");
    });

    it("should record a MEMORY_SUPERSEDED event", async () => {
      // Save initial memory
      const original = await memoryManager.save("event-key", "first value");

      // Supersede
      const replacement = await memoryManager.supersede("event-key", "second value");

      // Query events from the event store
      const events = await eventStore.getBySession(testSessionId);
      const supersedeEvents = events.filter(
        (e) => e.eventType === ("MEMORY_SUPERSEDED" as EventType)
      );

      expect(supersedeEvents.length).toBe(1);
      const supersedeEvent = supersedeEvents[0];
      expect(supersedeEvent.payload).toMatchObject({
        memoryId: original.id,
        sessionId: testSessionId,
        operation: "supersede",
      });
      expect(supersedeEvent.metadata).toMatchObject({
        originalKey: "event-key",
        supersededBy: replacement.id,
        newMemoryId: replacement.id,
      });
    });

    it("should preserve superseded memories (never delete)", async () => {
      // Save and supersede multiple times
      const v1 = await memoryManager.save("chain-key", "version 1");
      const v2 = await memoryManager.supersede("chain-key", "version 2");
      const v3 = await memoryManager.supersede("chain-key", "version 3");

      // Current key should point to v3
      const current = await memoryManager.get("chain-key");
      expect(current).not.toBeNull();
      expect(current!.value).toBe("version 3");
      expect(current!.metadata.status).toBe("active");
      expect(current!.metadata.supersedes).toBe(v2.id);

      // v2 should be superseded
      const v2Key = `chain-key::superseded::${v2.id}`;
      const v2Mem = await memoryManager.get(v2Key);
      expect(v2Mem).not.toBeNull();
      expect(v2Mem!.value).toBe("version 2");
      expect(v2Mem!.metadata.status).toBe("superseded");
      expect(v2Mem!.metadata.supersededBy).toBe(v3.id);

      // v1 should also be superseded
      const v1Key = `chain-key::superseded::${v1.id}`;
      const v1Mem = await memoryManager.get(v1Key);
      expect(v1Mem).not.toBeNull();
      expect(v1Mem!.value).toBe("version 1");
      expect(v1Mem!.metadata.status).toBe("superseded");
      expect(v1Mem!.metadata.supersededBy).toBe(v2.id);

      // Total memory count: 3 (v1 superseded, v2 superseded, v3 active)
      expect(memoryManager.count()).toBe(3);
    });

    it("should allow querying superseded memories by pattern", async () => {
      await memoryManager.save("patterned-key", "old value");
      await memoryManager.supersede("patterned-key", "new value");

      // Query with key pattern matching superseded memories
      const results = await memoryManager.recall({
        keyPattern: "patterned-key::superseded::*",
      });

      expect(results.length).toBe(1);
      expect(results[0].memory.value).toBe("old value");
      expect(results[0].memory.metadata.status).toBe("superseded");
    });
  });

  describe("MEMORY_SUPERSEDED event type", () => {
    it("should have correct event type in EventStore", async () => {
      await memoryManager.save("evt-key", "original");
      await memoryManager.supersede("evt-key", "replacement");

      const events = await eventStore.getBySession(testSessionId);
      const eventTypes = events.map((e) => e.eventType);

      // Should have: MEMORY_SAVED (original), MEMORY_SAVED (replacement), MEMORY_SUPERSEDED
      expect(eventTypes).toContain("MEMORY_SAVED");
      expect(eventTypes).toContain("MEMORY_SUPERSEDED");

      const savedCount = eventTypes.filter((t) => t === "MEMORY_SAVED").length;
      expect(savedCount).toBe(2); // original + replacement
    });
  });
});
