/**
 * Tests for WriteLockManager.
 *
 * Validates write lock acquisition, conflict detection, expiry handling,
 * and cleanup behavior.
 *
 * @module storage/__tests__/WriteLockManager.test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WriteLockManager } from "../WriteLockManager.js";
import { EventStore, createInMemoryEventStore } from "../EventStore.js";
import { WriteLockConflictError } from "../../types/agent-errors.js";
import type { Database } from "bun:sqlite";

// ============================================================================
// Test Helpers
// ============================================================================

function seedAgentQuota(db: Database, agentId: string, ttlMs: number = 86_400_000): void {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO agent_quotas
      (agent_id, role, admin, ttl_ms, expires_at, current_bytes, current_count, quota_bytes, quota_count, created_at, updated_at, metadata)
     VALUES ($agent_id, 'tester', 0, $ttl_ms, $expires_at, 0, 0, 10485760, 10000, $now, $now, '{}')`
  ).run({
    $agent_id: agentId,
    $ttl_ms: ttlMs,
    $expires_at: expiresAt,
    $now: now,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("WriteLockManager", () => {
  let eventStore: EventStore;
  let db: Database;
  let lockManager: WriteLockManager;

  beforeEach(() => {
    eventStore = createInMemoryEventStore();
    db = eventStore.getDatabase();
    lockManager = new WriteLockManager(db);
  });

  afterEach(async () => {
    await eventStore.close();
  });

  // --------------------------------------------------------------------------
  // Acquire lock
  // --------------------------------------------------------------------------

  describe("acquireLock", () => {
    test("succeeds when key is unlocked", () => {
      const result = lockManager.acquireLock("key-1", "agent-a");
      expect(result.acquired).toBe(true);
      expect(typeof result.expiresAt).toBe("string");
    });

    test("succeeds when same agent reacquires the lock", () => {
      lockManager.acquireLock("key-1", "agent-a");
      const result = lockManager.acquireLock("key-1", "agent-a");
      expect(result.acquired).toBe(true);
    });

    test("fails when lock is held by another agent (WriteLockConflictError)", () => {
      lockManager.acquireLock("key-1", "agent-a", 60_000); // 60s TTL
      expect(() => {
        lockManager.acquireLock("key-1", "agent-b");
      }).toThrow(WriteLockConflictError);
    });

    test("WriteLockConflictError has correct properties", () => {
      lockManager.acquireLock("key-1", "agent-a", 60_000);
      try {
        lockManager.acquireLock("key-1", "agent-b");
        expect(true).toBe(false); // Should not reach
      } catch (error) {
        expect(error).toBeInstanceOf(WriteLockConflictError);
        const wlc = error as WriteLockConflictError;
        expect(wlc.code).toBe("WRITE_LOCK_CONFLICT");
        expect(wlc.context?.key).toBe("key-1");
        expect(wlc.context?.holdingAgentId).toBe("agent-a");
        expect(wlc.context?.requestingAgentId).toBe("agent-b");
        expect(typeof wlc.fix).toBe("string");
      }
    });

    test("succeeds when previous lock has expired", () => {
      // Insert an already-expired lock manually
      db.prepare(
        `INSERT INTO write_locks (lock_key, holder_id, acquired_at, expires_at, metadata)
         VALUES ($key, $holder, $acquired, $expires, '{}')`
      ).run({
        $key: "key-expired",
        $holder: "agent-old",
        $acquired: "2020-01-01T00:00:00Z",
        $expires: "2020-01-01T00:01:00Z", // long expired
      });

      // New agent should be able to acquire
      const result = lockManager.acquireLock("key-expired", "agent-new");
      expect(result.acquired).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Release lock
  // --------------------------------------------------------------------------

  describe("releaseLock", () => {
    test("releases a held lock", () => {
      lockManager.acquireLock("key-1", "agent-a");
      const released = lockManager.releaseLock("key-1", "agent-a");
      expect(released).toBe(true);

      // Key should now be available
      expect(lockManager.isLocked("key-1")).toBe(false);
    });

    test("returns false when lock is not held by the requesting agent", () => {
      lockManager.acquireLock("key-1", "agent-a");
      const released = lockManager.releaseLock("key-1", "agent-b");
      expect(released).toBe(false);

      // Lock should still be held
      expect(lockManager.isLocked("key-1")).toBe(true);
    });

    test("returns false for non-existent lock", () => {
      const released = lockManager.releaseLock("nonexistent", "agent-a");
      expect(released).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // isLocked
  // --------------------------------------------------------------------------

  describe("isLocked", () => {
    test("returns true for an active lock", () => {
      lockManager.acquireLock("key-1", "agent-a");
      expect(lockManager.isLocked("key-1")).toBe(true);
    });

    test("returns false when no lock exists", () => {
      expect(lockManager.isLocked("key-none")).toBe(false);
    });

    test("returns false for an expired lock", () => {
      // Insert expired lock
      db.prepare(
        `INSERT INTO write_locks (lock_key, holder_id, acquired_at, expires_at, metadata)
         VALUES ($key, $holder, $acquired, $expires, '{}')`
      ).run({
        $key: "key-expired",
        $holder: "agent-old",
        $acquired: "2020-01-01T00:00:00Z",
        $expires: "2020-01-01T00:01:00Z",
      });

      expect(lockManager.isLocked("key-expired")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getLockInfo
  // --------------------------------------------------------------------------

  describe("getLockInfo", () => {
    test("returns lock info for active lock", () => {
      lockManager.acquireLock("key-1", "agent-a");
      const info = lockManager.getLockInfo("key-1");
      expect(info).not.toBeNull();
      expect(info!.lockKey).toBe("key-1");
      expect(info!.holderId).toBe("agent-a");
      expect(typeof info!.acquiredAt).toBe("string");
      expect(typeof info!.expiresAt).toBe("string");
    });

    test("returns null for non-existent lock", () => {
      const info = lockManager.getLockInfo("key-none");
      expect(info).toBeNull();
    });

    test("returns null for expired lock", () => {
      db.prepare(
        `INSERT INTO write_locks (lock_key, holder_id, acquired_at, expires_at, metadata)
         VALUES ($key, $holder, $acquired, $expires, '{}')`
      ).run({
        $key: "key-expired",
        $holder: "agent-old",
        $acquired: "2020-01-01T00:00:00Z",
        $expires: "2020-01-01T00:01:00Z",
      });

      const info = lockManager.getLockInfo("key-expired");
      expect(info).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Lazy cleanup on acquire
  // --------------------------------------------------------------------------

  describe("lazy cleanup", () => {
    test("expired locks are cleaned up on acquire", () => {
      // Insert expired lock
      db.prepare(
        `INSERT INTO write_locks (lock_key, holder_id, acquired_at, expires_at, metadata)
         VALUES ($key, $holder, $acquired, $expires, '{}')`
      ).run({
        $key: "stale-key",
        $holder: "dead-agent",
        $acquired: "2020-01-01T00:00:00Z",
        $expires: "2020-01-01T00:01:00Z",
      });

      // Acquire a different key — this triggers cleanup
      lockManager.acquireLock("fresh-key", "agent-x");

      // The stale lock should have been deleted
      const row = db
        .prepare("SELECT * FROM write_locks WHERE lock_key = 'stale-key'")
        .get();
      expect(row).toBeNull();
    });

    test("expired agents are NOT cleaned up by lock acquire (layer separation)", () => {
      // Insert an expired agent quota
      db.prepare(
        `INSERT INTO agent_quotas
          (agent_id, role, admin, ttl_ms, expires_at, current_bytes, current_count, quota_bytes, quota_count, created_at, updated_at, metadata)
         VALUES ($agent_id, 'expired-role', 0, 1000, '2020-01-01T00:00:00Z', 0, 0, 10485760, 10000, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', '{}')`
      ).run({ $agent_id: "expired-agent" });

      // Acquire a lock — should NOT clean up agent_quotas (layer violation removed)
      lockManager.acquireLock("any-key", "live-agent");

      // The expired agent quota should still exist (cleanup is not WriteLockManager's job)
      const row = db
        .prepare("SELECT * FROM agent_quotas WHERE agent_id = 'expired-agent'")
        .get();
      expect(row).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Multiple locks
  // --------------------------------------------------------------------------

  describe("multiple locks", () => {
    test("same agent can hold multiple locks on different keys", () => {
      const r1 = lockManager.acquireLock("key-a", "agent-a");
      const r2 = lockManager.acquireLock("key-b", "agent-a");
      expect(r1.acquired).toBe(true);
      expect(r2.acquired).toBe(true);
      expect(lockManager.isLocked("key-a")).toBe(true);
      expect(lockManager.isLocked("key-b")).toBe(true);
    });

    test("different agents can hold locks on different keys", () => {
      lockManager.acquireLock("key-a", "agent-a");
      lockManager.acquireLock("key-b", "agent-b");
      expect(lockManager.isLocked("key-a")).toBe(true);
      expect(lockManager.isLocked("key-b")).toBe(true);
    });
  });
});
