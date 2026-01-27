/**
 * Tests for MemoryManager
 *
 * @module memory/__tests__/MemoryManager.test
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  MemoryManager,
  createMemoryManager,
  createTestMemoryManager,
  MemoryKeyExistsError,
  MemoryKeyNotFoundError,
  InvalidSessionError,
  MemoryManagerError,
} from "../MemoryManager.js";
import { VectorIndex } from "../../search/VectorIndex.js";
import { createMockVectorDatabase } from "../../search/__tests__/MockVectorDatabase.js";
import type { MemoryCategory, MemoryPriority } from "../../types/index.js";

describe("MemoryManager", () => {
  let memoryManager: MemoryManager;
  const testSessionId = "session-test-001";

  beforeEach(() => {
    memoryManager = createTestMemoryManager(testSessionId);
  });

  afterEach(async () => {
    await memoryManager.close();
  });

  describe("Initialization", () => {
    it("should create memory manager with default configuration", () => {
      expect(memoryManager.getSessionId()).toBe(testSessionId);
      expect(memoryManager.count()).toBe(0);
    });

    it("should throw InvalidSessionError for missing session ID", () => {
      expect(() => {
        createMemoryManager({ sessionId: "" as unknown as string });
      }).toThrow(InvalidSessionError);
    });

    it("should create memory manager with custom configuration", async () => {
      const vectorIndex = new VectorIndex({
        database: createMockVectorDatabase(),
        vectorDimensions: 768,
      });
      const customManager = createMemoryManager({
        sessionId: "custom-session",
        vectorIndex,
        defaultChannel: "test-channel",
        defaultPriority: "high",
        defaultPrivacy: "global",
      });

      expect(customManager.getSessionId()).toBe("custom-session");
      await customManager.close();
    });
  });

  describe("Save Operations", () => {
    it("should save a new memory", async () => {
      const memory = await memoryManager.save("test-key", "test-value");

      expect(memory.key).toBe("test-key");
      expect(memory.value).toBe("test-value");
      expect(memory.sessionId).toBe(testSessionId);
      expect(memory.id).toBeDefined();
      expect(memory.createdAt).toBeInstanceOf(Date);
      expect(memory.updatedAt).toBeInstanceOf(Date);
    });

    it("should save memory with custom options", async () => {
      const memory = await memoryManager.save("test-key", "test-value", {
        category: "task",
        priority: "high",
        privacy: "global",
        channel: "my-channel",
        metadata: { source: "unit-test" },
      });

      expect(memory.category).toBe("task");
      expect(memory.priority).toBe("high");
      expect(memory.privacy).toBe("global");
      expect(memory.channel).toBe("my-channel");
      expect(memory.metadata).toEqual({ source: "unit-test" });
    });

    it("should throw MemoryKeyExistsError for duplicate key", async () => {
      await memoryManager.save("duplicate-key", "value-1");

      await expect(
        memoryManager.save("duplicate-key", "value-2")
      ).rejects.toThrow(MemoryKeyExistsError);
    });

    it("should use default priority and privacy", async () => {
      const memory = await memoryManager.save("test-key", "test-value");

      expect(memory.priority).toBe("normal");
      expect(memory.privacy).toBe("session");
    });
  });

  describe("Save or Update Operations", () => {
    it("should save new memory when key does not exist", async () => {
      const memory = await memoryManager.saveOrUpdate(
        "new-key",
        "new-value"
      );

      expect(memory.key).toBe("new-key");
      expect(memory.value).toBe("new-value");
    });

    it("should update existing memory when key exists", async () => {
      await memoryManager.save("existing-key", "original-value");

      const updated = await memoryManager.saveOrUpdate(
        "existing-key",
        "updated-value"
      );

      expect(updated.key).toBe("existing-key");
      expect(updated.value).toBe("updated-value");
      expect(memoryManager.count()).toBe(1);
    });
  });

  describe("Update Operations", () => {
    it("should update memory value", async () => {
      await memoryManager.save("update-key", "original");

      const updated = await memoryManager.update("update-key", {
        value: "modified",
      });

      expect(updated.value).toBe("modified");
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
        updated.createdAt.getTime()
      );
    });

    it("should update memory category", async () => {
      await memoryManager.save("update-key", "value");

      const updated = await memoryManager.update("update-key", {
        category: "decision",
      });

      expect(updated.category).toBe("decision");
    });

    it("should update memory priority", async () => {
      await memoryManager.save("update-key", "value");

      const updated = await memoryManager.update("update-key", {
        priority: "high",
      });

      expect(updated.priority).toBe("high");
    });

    it("should merge metadata on update", async () => {
      await memoryManager.save("update-key", "value", {
        metadata: { original: true },
      });

      const updated = await memoryManager.update("update-key", {
        metadata: { added: "new-field" },
      });

      expect(updated.metadata).toEqual({ original: true, added: "new-field" });
    });

    it("should throw MemoryKeyNotFoundError for non-existent key", async () => {
      await expect(
        memoryManager.update("non-existent", { value: "new" })
      ).rejects.toThrow(MemoryKeyNotFoundError);
    });
  });

  describe("Delete Operations", () => {
    it("should delete existing memory", async () => {
      await memoryManager.save("delete-key", "value");

      const deleted = await memoryManager.delete("delete-key");

      expect(deleted).toBe(true);
      expect(memoryManager.get("delete-key")).toBeNull();
      expect(memoryManager.count()).toBe(0);
    });

    it("should return false for non-existent key", async () => {
      const deleted = await memoryManager.delete("non-existent");

      expect(deleted).toBe(false);
    });
  });

  describe("Read Operations", () => {
    beforeEach(async () => {
      await memoryManager.save("key-1", "value-1", { category: "task" });
      await memoryManager.save("key-2", "value-2", { category: "decision" });
      await memoryManager.save("key-3", "value-3", {
        category: "task",
        channel: "channel-a",
      });
    });

    it("should get memory by key", () => {
      const memory = memoryManager.get("key-1");

      expect(memory).not.toBeNull();
      expect(memory?.key).toBe("key-1");
      expect(memory?.value).toBe("value-1");
    });

    it("should return null for non-existent key", () => {
      const memory = memoryManager.get("non-existent");

      expect(memory).toBeNull();
    });

    it("should get memory by ID", async () => {
      const saved = await memoryManager.save("id-test", "value");

      const memory = memoryManager.getById(saved.id);

      expect(memory).not.toBeNull();
      expect(memory?.id).toBe(saved.id);
    });

    it("should check if memory exists", () => {
      expect(memoryManager.has("key-1")).toBe(true);
      expect(memoryManager.has("non-existent")).toBe(false);
    });

    it("should list all memories", () => {
      const memories = memoryManager.list();

      expect(memories).toHaveLength(3);
    });

    it("should list memories with limit", () => {
      const memories = memoryManager.list({ limit: 2 });

      expect(memories).toHaveLength(2);
    });

    it("should list memories filtered by category", () => {
      const memories = memoryManager.list({ category: "task" });

      expect(memories).toHaveLength(2);
      memories.forEach((m) => {
        expect(m.category).toBe("task");
      });
    });

    it("should list memories filtered by channel", () => {
      const memories = memoryManager.list({ channel: "channel-a" });

      expect(memories).toHaveLength(1);
      expect(memories[0]?.channel).toBe("channel-a");
    });

    it("should return memories sorted by creation date (newest first)", () => {
      const memories = memoryManager.list();

      for (let i = 0; i < memories.length - 1; i++) {
        const current = memories[i];
        const next = memories[i + 1];
        if (current && next) {
          expect(current.createdAt.getTime()).toBeGreaterThanOrEqual(
            next.createdAt.getTime()
          );
        }
      }
    });
  });

  describe("Recall Operations", () => {
    beforeEach(async () => {
      await memoryManager.save("recall-1", "value-1", {
        category: "task",
        priority: "high",
        channel: "channel-a",
      });
      await memoryManager.save("recall-2", "value-2", {
        category: "decision",
        priority: "normal",
        channel: "channel-b",
      });
      await memoryManager.save("test-pattern-1", "value-3", {
        category: "note",
      });
      await memoryManager.save("test-pattern-2", "value-4", {
        category: "note",
      });
    });

    it("should recall by exact key", async () => {
      const results = await memoryManager.recall({ key: "recall-1" });

      expect(results).toHaveLength(1);
      expect(results[0]?.memory.key).toBe("recall-1");
      expect(results[0]?.score).toBe(1.0);
    });

    it("should recall by key pattern", async () => {
      const results = await memoryManager.recall({ keyPattern: "test-*" });

      expect(results).toHaveLength(2);
      results.forEach((r) => {
        expect(r.memory.key).toMatch(/^test-pattern/);
      });
    });

    it("should recall filtered by category", async () => {
      const results = await memoryManager.recall({ category: "note" });

      expect(results).toHaveLength(2);
      results.forEach((r) => {
        expect(r.memory.category).toBe("note");
      });
    });

    it("should recall filtered by channel", async () => {
      const results = await memoryManager.recall({ channel: "channel-a" });

      expect(results).toHaveLength(1);
      expect(results[0]?.memory.channel).toBe("channel-a");
    });

    it("should recall filtered by priority", async () => {
      const results = await memoryManager.recall({ priority: "high" });

      expect(results).toHaveLength(1);
      expect(results[0]?.memory.priority).toBe("high");
    });

    it("should recall with pagination", async () => {
      const results = await memoryManager.recall({ limit: 2, offset: 1 });

      expect(results).toHaveLength(2);
    });

    it("should recall sorted by created_asc", async () => {
      const results = await memoryManager.recall({ sort: "created_asc" });

      for (let i = 0; i < results.length - 1; i++) {
        const current = results[i];
        const next = results[i + 1];
        if (current && next) {
          expect(current.memory.createdAt.getTime()).toBeLessThanOrEqual(
            next.memory.createdAt.getTime()
          );
        }
      }
    });

    it("should recall sorted by created_desc", async () => {
      const results = await memoryManager.recall({ sort: "created_desc" });

      for (let i = 0; i < results.length - 1; i++) {
        const current = results[i];
        const next = results[i + 1];
        if (current && next) {
          expect(current.memory.createdAt.getTime()).toBeGreaterThanOrEqual(
            next.memory.createdAt.getTime()
          );
        }
      }
    });
  });

  describe("Semantic Search", () => {
    it("should throw error when vector index not configured", async () => {
      const queryEmbedding = new Float32Array(768).fill(0.1);

      await expect(
        memoryManager.semanticSearch(queryEmbedding)
      ).rejects.toThrow(MemoryManagerError);
    });

    it("should perform semantic search when vector index configured", async () => {
      const vectorIndex = new VectorIndex({
        database: createMockVectorDatabase(),
        vectorDimensions: 768,
      });
      const managerWithVector = createMemoryManager({
        sessionId: "vector-session",
        vectorIndex,
      });

      // Save memory with embedding
      const embedding = new Float32Array(768).fill(0.5);
      await managerWithVector.save("semantic-key", "semantic value", {
        embedding,
      });

      // Search with similar embedding
      const results = await managerWithVector.semanticSearch(embedding, {
        threshold: 0.9,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.score).toBeGreaterThan(0.9);

      await managerWithVector.close();
    });
  });

  describe("Statistics", () => {
    beforeEach(async () => {
      await memoryManager.save("stats-1", "value", {
        category: "task",
        priority: "high",
        channel: "channel-a",
      });
      await memoryManager.save("stats-2", "value", {
        category: "task",
        priority: "normal",
        channel: "channel-a",
      });
      await memoryManager.save("stats-3", "value", {
        category: "decision",
        priority: "low",
        channel: "channel-b",
      });
    });

    it("should return correct total count", () => {
      const stats = memoryManager.getStats();

      expect(stats.totalMemories).toBe(3);
    });

    it("should return count by category", () => {
      const stats = memoryManager.getStats();

      expect(stats.byCategory["task"]).toBe(2);
      expect(stats.byCategory["decision"]).toBe(1);
    });

    it("should return count by priority", () => {
      const stats = memoryManager.getStats();

      expect(stats.byPriority.high).toBe(1);
      expect(stats.byPriority.normal).toBe(1);
      expect(stats.byPriority.low).toBe(1);
    });

    it("should return count by channel", () => {
      const stats = memoryManager.getStats();

      expect(stats.byChannel["channel-a"]).toBe(2);
      expect(stats.byChannel["channel-b"]).toBe(1);
    });
  });

  describe("Utility Operations", () => {
    it("should clear all memories", async () => {
      await memoryManager.save("clear-1", "value");
      await memoryManager.save("clear-2", "value");

      memoryManager.clear();

      expect(memoryManager.count()).toBe(0);
    });

    it("should return event store instance", () => {
      const eventStore = memoryManager.getEventStore();

      expect(eventStore).toBeDefined();
    });
  });

  describe("UUID Generation", () => {
    it("should generate unique IDs for each memory", async () => {
      const memory1 = await memoryManager.save("uuid-1", "value");
      const memory2 = await memoryManager.save("uuid-2", "value");

      expect(memory1.id).not.toBe(memory2.id);
    });

    it("should generate UUIDs in correct format", async () => {
      const memory = await memoryManager.save("uuid-format", "value");

      // UUID format: xxxxxxxx-xxxx-7xxx-xxxx-xxxxxxxxxxxx
      const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(memory.id).toMatch(uuidPattern);
    });
  });

  describe("Event Sourcing", () => {
    it("should create event on save", async () => {
      await memoryManager.save("event-save", "value");

      const eventStore = memoryManager.getEventStore();
      const events = await eventStore.getBySession(testSessionId);
      const saveEvents = events.filter((e) => e.eventType === "MEMORY_SAVED");

      expect(saveEvents.length).toBeGreaterThan(0);
    });

    it("should create event on update", async () => {
      await memoryManager.save("event-update", "value");
      await memoryManager.update("event-update", { value: "new-value" });

      const eventStore = memoryManager.getEventStore();
      const events = await eventStore.getBySession(testSessionId);
      const updateEvents = events.filter(
        (e) => e.eventType === "MEMORY_UPDATED"
      );

      expect(updateEvents.length).toBeGreaterThan(0);
    });

    it("should create event on delete", async () => {
      await memoryManager.save("event-delete", "value");
      await memoryManager.delete("event-delete");

      const eventStore = memoryManager.getEventStore();
      const events = await eventStore.getBySession(testSessionId);
      const deleteEvents = events.filter(
        (e) => e.eventType === "MEMORY_DELETED"
      );

      expect(deleteEvents.length).toBeGreaterThan(0);
    });

    it("should create event on recall", async () => {
      await memoryManager.save("event-recall", "value");
      await memoryManager.recall({ key: "event-recall" });

      const eventStore = memoryManager.getEventStore();
      const events = await eventStore.getBySession(testSessionId);
      const recallEvents = events.filter(
        (e) => e.eventType === "MEMORY_RECALLED"
      );

      expect(recallEvents.length).toBeGreaterThan(0);
    });
  });

  describe("Integration Tests", () => {
    it("should handle complete memory lifecycle", async () => {
      // Create
      const created = await memoryManager.save("lifecycle", "initial", {
        category: "task",
        priority: "normal",
      });
      expect(created.value).toBe("initial");

      // Read
      const read = memoryManager.get("lifecycle");
      expect(read?.value).toBe("initial");

      // Update
      const updated = await memoryManager.update("lifecycle", {
        value: "modified",
        priority: "high",
      });
      expect(updated.value).toBe("modified");
      expect(updated.priority).toBe("high");

      // Recall
      const recalled = await memoryManager.recall({ key: "lifecycle" });
      expect(recalled).toHaveLength(1);
      expect(recalled[0]?.memory.value).toBe("modified");

      // Delete
      const deleted = await memoryManager.delete("lifecycle");
      expect(deleted).toBe(true);
      expect(memoryManager.get("lifecycle")).toBeNull();
    });

    it("should maintain data consistency across operations", async () => {
      // Save multiple memories
      for (let i = 0; i < 10; i++) {
        await memoryManager.save(`consistency-${i}`, `value-${i}`, {
          category: i % 2 === 0 ? "task" : "note",
        });
      }

      // Verify count
      expect(memoryManager.count()).toBe(10);

      // Verify stats
      const stats = memoryManager.getStats();
      expect(stats.byCategory["task"]).toBe(5);
      expect(stats.byCategory["note"]).toBe(5);

      // Delete some
      await memoryManager.delete("consistency-0");
      await memoryManager.delete("consistency-1");

      // Verify consistency
      expect(memoryManager.count()).toBe(8);
      expect(memoryManager.has("consistency-0")).toBe(false);
      expect(memoryManager.has("consistency-2")).toBe(true);
    });
  });
});
