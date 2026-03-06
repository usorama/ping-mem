/**
 * Tests for multi-agent quota enforcement in MemoryManager.
 *
 * Validates that byte and count quotas are enforced during save operations.
 *
 * @module memory/__tests__/agent-quota.test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryManager, createMemoryManager } from "../MemoryManager.js";
import { createInMemoryEventStore, EventStore } from "../../storage/EventStore.js";
import { createAgentId, type AgentId } from "../../types/index.js";
import { QuotaExhaustedError } from "../../types/agent-errors.js";

// ============================================================================
// Test Helpers
// ============================================================================

function registerAgent(
  eventStore: EventStore,
  agentId: string,
  opts: { quotaBytes?: number; quotaCount?: number } = {}
): void {
  const db = eventStore.getDatabase();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();

  db.prepare(
    `INSERT INTO agent_quotas
      (agent_id, role, admin, ttl_ms, expires_at, current_bytes, current_count, quota_bytes, quota_count, created_at, updated_at, metadata)
     VALUES ($agent_id, $role, 0, 86400000, $expires_at, 0, 0, $quota_bytes, $quota_count, $created_at, $updated_at, '{}')`
  ).run({
    $agent_id: agentId,
    $role: "tester",
    $expires_at: expiresAt,
    $quota_bytes: opts.quotaBytes ?? 10_485_760,
    $quota_count: opts.quotaCount ?? 10_000,
    $created_at: now,
    $updated_at: now,
  });
}

function makeManager(
  eventStore: EventStore,
  agentId: AgentId
): MemoryManager {
  return createMemoryManager({
    sessionId: "quota-test-session",
    eventStore,
    agentId,
    agentRole: "tester",
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("Agent Quota Enforcement", () => {
  let eventStore: EventStore;

  beforeEach(() => {
    eventStore = createInMemoryEventStore();
  });

  afterEach(async () => {
    await eventStore.close();
  });

  // --------------------------------------------------------------------------
  // Byte quota
  // --------------------------------------------------------------------------

  describe("byte quota", () => {
    test("save succeeds within byte quota", async () => {
      const agentId = createAgentId("agent-byte-ok");
      registerAgent(eventStore, agentId, { quotaBytes: 1000 });
      const mm = makeManager(eventStore, agentId);

      // "hello" is 5 bytes — well within 1000
      const memory = await mm.save("k1", "hello");
      expect(memory.key).toBe("k1");
      expect(memory.value).toBe("hello");
    });

    test("save throws QuotaExhaustedError when byte quota exceeded", async () => {
      const agentId = createAgentId("agent-byte-over");
      // Set a very small byte quota
      registerAgent(eventStore, agentId, { quotaBytes: 10 });
      const mm = makeManager(eventStore, agentId);

      // "hello" is 5 bytes, succeeds
      await mm.save("k1", "hello");

      // "world!!" is 7 bytes, current_bytes is now 5 + 7 = 12 > 10
      await expect(mm.save("k2", "world!!")).rejects.toThrow(QuotaExhaustedError);
    });

    test("QuotaExhaustedError has correct properties for bytes", async () => {
      const agentId = createAgentId("agent-byte-props");
      registerAgent(eventStore, agentId, { quotaBytes: 5 });
      const mm = makeManager(eventStore, agentId);

      try {
        // 10 bytes, exceeds 5 byte quota
        await mm.save("k1", "1234567890");
        expect(true).toBe(false); // Should not reach
      } catch (error) {
        expect(error).toBeInstanceOf(QuotaExhaustedError);
        const qe = error as QuotaExhaustedError;
        expect(qe.code).toBe("QUOTA_EXHAUSTED");
        expect(qe.context?.quotaType).toBe("bytes");
        expect(qe.context?.limit).toBe(5);
        expect(typeof qe.fix).toBe("string");
        expect(qe.fix.length).toBeGreaterThan(0);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Count quota
  // --------------------------------------------------------------------------

  describe("count quota", () => {
    test("save succeeds within count quota", async () => {
      const agentId = createAgentId("agent-count-ok");
      registerAgent(eventStore, agentId, { quotaCount: 5 });
      const mm = makeManager(eventStore, agentId);

      await mm.save("k1", "v1");
      await mm.save("k2", "v2");
      expect(mm.count()).toBe(2);
    });

    test("save throws QuotaExhaustedError when count quota exceeded", async () => {
      const agentId = createAgentId("agent-count-over");
      registerAgent(eventStore, agentId, { quotaCount: 2, quotaBytes: 999999 });
      const mm = makeManager(eventStore, agentId);

      await mm.save("k1", "v1");
      await mm.save("k2", "v2");
      // Third save should fail — count quota is 2
      await expect(mm.save("k3", "v3")).rejects.toThrow(QuotaExhaustedError);
    });

    test("QuotaExhaustedError has correct properties for count", async () => {
      const agentId = createAgentId("agent-count-props");
      registerAgent(eventStore, agentId, { quotaCount: 1, quotaBytes: 999999 });
      const mm = makeManager(eventStore, agentId);

      await mm.save("k1", "v1");

      try {
        await mm.save("k2", "v2");
        expect(true).toBe(false); // Should not reach
      } catch (error) {
        expect(error).toBeInstanceOf(QuotaExhaustedError);
        const qe = error as QuotaExhaustedError;
        expect(qe.code).toBe("QUOTA_EXHAUSTED");
        expect(qe.context?.quotaType).toBe("count");
        expect(qe.context?.limit).toBe(1);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Quota updates
  // --------------------------------------------------------------------------

  describe("quota usage tracking", () => {
    test("current_bytes and current_count are updated after save", async () => {
      const agentId = createAgentId("agent-tracking");
      registerAgent(eventStore, agentId, { quotaBytes: 10000, quotaCount: 100 });
      const mm = makeManager(eventStore, agentId);

      await mm.save("k1", "hello"); // 5 bytes

      const db = eventStore.getDatabase();
      const row = db
        .prepare("SELECT current_bytes, current_count FROM agent_quotas WHERE agent_id = $id")
        .get({ $id: agentId }) as { current_bytes: number; current_count: number };

      expect(row.current_bytes).toBe(5);
      expect(row.current_count).toBe(1);
    });

    test("saves without agentId bypass quota checks", async () => {
      // Legacy manager (no agentId) — should not be subject to any quota
      const mm = createMemoryManager({
        sessionId: "legacy-session",
        eventStore,
      });

      // Should succeed regardless of whether agent_quotas has data
      const memory = await mm.save("legacy-key", "legacy-value");
      expect(memory.key).toBe("legacy-key");
    });
  });
});
