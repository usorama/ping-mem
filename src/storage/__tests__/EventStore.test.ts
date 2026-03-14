/**
 * Tests for EventStore
 *
 * @module storage/__tests__/EventStore.test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EventStore, createInMemoryEventStore } from "../EventStore.js";
import type { Event } from "../EventStore.js";

describe("EventStore", () => {
  let store: EventStore;

  beforeEach(() => {
    store = createInMemoryEventStore();
  });

  afterEach(async () => {
    await store.close();
  });

  describe("Database Initialization", () => {
    test("should create an in-memory database", async () => {
      expect(store.getDbPath()).toBe(":memory:");
    });

    test("should pass health check", async () => {
      const healthy = await store.ping();
      expect(healthy).toBe(true);
    });

    test("should initialize with zero events and checkpoints", () => {
      const stats = store.getStats();
      expect(stats.eventCount).toBe(0);
      expect(stats.checkpointCount).toBe(0);
      expect(stats.dbSize).toBe(0);
    });
  });

  describe("Event Creation", () => {
    test("should create SESSION_STARTED event", async () => {
      const sessionId = "test-session-1";
      const event = await store.createEvent(
        sessionId,
        "SESSION_STARTED",
        {
          sessionId,
          name: "Test Session",
        },
        { test: true }
      );

      expect(event.eventId).toBeDefined();
      expect(event.sessionId).toBe(sessionId);
      expect(event.eventType).toBe("SESSION_STARTED");
      expect(event.timestamp).toBeInstanceOf(Date);
    });

    test("should create MEMORY_SAVED event", async () => {
      const sessionId = "test-session-2";
      const event = await store.createEvent(
        sessionId,
        "MEMORY_SAVED",
        {
          memoryId: "mem-1",
          key: "test-key",
          sessionId,
          operation: "save",
        },
        {}
      );

      expect(event.eventType).toBe("MEMORY_SAVED");
    });

    test("should generate unique event IDs", async () => {
      const sessionId = "test-session-3";
      const event1 = await store.createEvent(sessionId, "SESSION_STARTED", { sessionId, name: "S1" });
      const event2 = await store.createEvent(sessionId, "SESSION_STARTED", { sessionId, name: "S2" });

      expect(event1.eventId).not.toBe(event2.eventId);
    });
  });

  describe("Event Retrieval", () => {
    test("should retrieve event by ID", async () => {
      const sessionId = "test-session-4";
      const created = await store.createEvent(sessionId, "SESSION_STARTED", { sessionId, name: "Test" });

      const retrieved = await store.getById(created.eventId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.eventId).toBe(created.eventId);
      expect(retrieved?.sessionId).toBe(sessionId);
    });

    test("should return null for non-existent event ID", async () => {
      const retrieved = await store.getById("non-existent-id");
      expect(retrieved).toBeNull();
    });

    test("should retrieve all events for a session", async () => {
      const sessionId = "test-session-5";
      await store.createEvent(sessionId, "SESSION_STARTED", { sessionId, name: "Test" });
      await store.createEvent(sessionId, "MEMORY_SAVED", { memoryId: "m1", key: "k1", sessionId, operation: "save" });
      await store.createEvent(sessionId, "SESSION_ENDED", { sessionId, name: "Test" });

      const events = await store.getBySession(sessionId);
      expect(events.length).toBe(3);
      expect(events[0]?.eventType).toBe("SESSION_STARTED");
      expect(events[1]?.eventType).toBe("MEMORY_SAVED");
      expect(events[2]?.eventType).toBe("SESSION_ENDED");
    });

    test("should retrieve events by time range", async () => {
      const sessionId = "test-session-6";
      const start = new Date();
      await store.createEvent(sessionId, "SESSION_STARTED", { sessionId, name: "Test" });

      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));

      await store.createEvent(sessionId, "MEMORY_SAVED", { memoryId: "m1", key: "k1", sessionId, operation: "save" });

      const end = new Date();

      const events = await store.getByTimeRange(start, end);
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.some((e) => e.eventType === "SESSION_STARTED")).toBe(true);
      expect(events.some((e) => e.eventType === "MEMORY_SAVED")).toBe(true);
    });
  });

  describe("Batch Operations", () => {
    test("should append multiple events atomically", async () => {
      const sessionId = "test-session-7";
      const events: Event[] = [
        {
          eventId: "evt-1",
          timestamp: new Date(),
          sessionId,
          eventType: "SESSION_STARTED",
          payload: { sessionId, name: "Test" },
          metadata: {},
        },
        {
          eventId: "evt-2",
          timestamp: new Date(),
          sessionId,
          eventType: "MEMORY_SAVED",
          payload: { memoryId: "m1", key: "k1", sessionId, operation: "save" },
          metadata: {},
        },
      ];

      await store.appendBatch(events);

      const retrieved = await store.getBySession(sessionId);
      expect(retrieved.length).toBe(2);
    });
  });

  describe("Checkpoints", () => {
    test("should create checkpoint for session", async () => {
      const sessionId = "test-session-8";
      await store.createEvent(sessionId, "SESSION_STARTED", { sessionId, name: "Test" });
      await store.createEvent(sessionId, "MEMORY_SAVED", { memoryId: "m1", key: "k1", sessionId, operation: "save" });

      const checkpoint = await store.createCheckpoint(sessionId, 10, "Test checkpoint");

      expect(checkpoint.checkpointId).toBeDefined();
      expect(checkpoint.sessionId).toBe(sessionId);
      expect(checkpoint.memoryCount).toBe(10);
      expect(checkpoint.description).toBe("Test checkpoint");
    });

    test("should retrieve checkpoint by ID", async () => {
      const sessionId = "test-session-9";
      await store.createEvent(sessionId, "SESSION_STARTED", { sessionId, name: "Test" });
      const created = await store.createCheckpoint(sessionId, 5);

      const retrieved = await store.getCheckpoint(created.checkpointId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.checkpointId).toBe(created.checkpointId);
    });

    test("should retrieve all checkpoints for session", async () => {
      const sessionId = "test-session-10";
      await store.createEvent(sessionId, "SESSION_STARTED", { sessionId, name: "Test" });
      await store.createCheckpoint(sessionId, 5, "Checkpoint 1");

      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));

      await store.createCheckpoint(sessionId, 10, "Checkpoint 2");

      const checkpoints = await store.getCheckpointsBySession(sessionId);
      expect(checkpoints.length).toBe(2);
      // Mock returns in insertion order, so check that both exist
      expect(checkpoints.some(c => c.description === "Checkpoint 1")).toBe(true);
      expect(checkpoints.some(c => c.description === "Checkpoint 2")).toBe(true);
    });

    test("should throw error when creating checkpoint with no events", async () => {
      await expect(store.createCheckpoint("non-existent-session", 0)).rejects.toThrow();
    });
  });

  describe("Statistics", () => {
    test("should track event count", async () => {
      const sessionId = "test-session-11";
      await store.createEvent(sessionId, "SESSION_STARTED", { sessionId, name: "Test" });
      await store.createEvent(sessionId, "MEMORY_SAVED", { memoryId: "m1", key: "k1", sessionId, operation: "save" });

      const stats = store.getStats();
      expect(stats.eventCount).toBe(2);
    });

    test("should track checkpoint count", async () => {
      const sessionId = "test-session-12";
      await store.createEvent(sessionId, "SESSION_STARTED", { sessionId, name: "Test" });
      await store.createCheckpoint(sessionId, 0);
      await store.createCheckpoint(sessionId, 5);

      const stats = store.getStats();
      expect(stats.checkpointCount).toBe(2);
    });
  });

  describe("Clear", () => {
    test("should clear all data", async () => {
      const sessionId = "test-session-13";
      await store.createEvent(sessionId, "SESSION_STARTED", { sessionId, name: "Test" });
      await store.createCheckpoint(sessionId, 0);

      store.clear();

      const stats = store.getStats();
      expect(stats.eventCount).toBe(0);
      expect(stats.checkpointCount).toBe(0);
    });
  });

  describe("Storage Introspection Methods", () => {
    test("getWalSizeBytes returns 0 for in-memory store", () => {
      expect(store.getWalSizeBytes()).toBe(0);
    });

    test("getFreelistRatio returns a number in [0, 1]", () => {
      const ratio = store.getFreelistRatio();
      expect(typeof ratio).toBe("number");
      expect(ratio).toBeGreaterThanOrEqual(0);
      expect(ratio).toBeLessThanOrEqual(1);
    });

    test("getFreelistRatio returns a non-negative value for an empty store", () => {
      // In-memory DB with no data may have a very small freelist ratio; it should never throw
      const ratio = store.getFreelistRatio();
      expect(ratio).toBeGreaterThanOrEqual(0);
    });

    test("getIntegrityOk returns 1 for a healthy in-memory store", () => {
      expect(store.getIntegrityOk()).toBe(1);
    });

    test("walCheckpoint is a no-op for in-memory store", () => {
      // Should not throw for :memory: databases
      expect(() => store.walCheckpoint("PASSIVE")).not.toThrow();
      expect(() => store.walCheckpoint("TRUNCATE")).not.toThrow();
      expect(() => store.walCheckpoint("FULL")).not.toThrow();
      expect(() => store.walCheckpoint("RESTART")).not.toThrow();
    });

    test("walCheckpoint rejects invalid mode", () => {
      // @ts-expect-error — intentionally testing invalid runtime value
      expect(() => store.walCheckpoint("INVALID")).toThrow("Invalid WAL checkpoint mode");
    });
  });

  describe("isAgentActive", () => {
    test("returns false for unknown agentId", () => {
      expect(store.isAgentActive("unknown-agent")).toBe(false);
    });

    test("returns true for a registered agent with no expiry", () => {
      const db = store.getDatabase();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO agent_quotas (agent_id, role, admin, ttl_ms, expires_at, current_bytes, current_count, quota_bytes, quota_count, created_at, updated_at, metadata)
         VALUES ($agent_id, 'worker', 0, 86400000, NULL, 0, 0, 10485760, 10000, $now, $now, '{}')`
      ).run({ $agent_id: "agent-active", $now: now });

      expect(store.isAgentActive("agent-active")).toBe(true);
    });

    test("returns true for a registered agent with future expiry", () => {
      const db = store.getDatabase();
      const now = new Date().toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();
      db.prepare(
        `INSERT INTO agent_quotas (agent_id, role, admin, ttl_ms, expires_at, current_bytes, current_count, quota_bytes, quota_count, created_at, updated_at, metadata)
         VALUES ($agent_id, 'worker', 0, 60000, $expires_at, 0, 0, 10485760, 10000, $now, $now, '{}')`
      ).run({ $agent_id: "agent-future", $expires_at: future, $now: now });

      expect(store.isAgentActive("agent-future")).toBe(true);
    });

    test("returns false for an expired agent", () => {
      const db = store.getDatabase();
      const now = new Date().toISOString();
      const past = new Date(Date.now() - 60_000).toISOString();
      db.prepare(
        `INSERT INTO agent_quotas (agent_id, role, admin, ttl_ms, expires_at, current_bytes, current_count, quota_bytes, quota_count, created_at, updated_at, metadata)
         VALUES ($agent_id, 'worker', 0, 60000, $expires_at, 0, 0, 10485760, 10000, $now, $now, '{}')`
      ).run({ $agent_id: "agent-expired", $expires_at: past, $now: now });

      expect(store.isAgentActive("agent-expired")).toBe(false);
    });
  });
});
