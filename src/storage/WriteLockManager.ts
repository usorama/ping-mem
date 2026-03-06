/**
 * Write Lock Manager for ping-mem multi-agent memory
 *
 * Provides distributed write locking for session keys so that
 * concurrent agents don't clobber each other's writes.
 * Uses SQLite's write_locks table for atomic lock acquisition.
 *
 * @module storage/WriteLockManager
 * @version 2.0.0
 */

import type { Database } from "bun:sqlite";
import { WriteLockConflictError } from "../types/agent-errors.js";
import { createAgentId } from "../types/index.js";

// ============================================================================
// Types
// ============================================================================

/** Result returned when a lock is successfully acquired */
export interface LockAcquireResult {
  acquired: true;
  expiresAt: string;
}

/** Information about a currently held lock */
export interface LockInfo {
  lockKey: string;
  holderId: string;
  acquiredAt: string;
  expiresAt: string;
  metadata: Record<string, unknown>;
}

/** Row shape from the write_locks table */
interface WriteLockRow {
  lock_key: string;
  holder_id: string;
  acquired_at: string;
  expires_at: string;
  metadata: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Default lock TTL: 30 seconds */
const DEFAULT_LOCK_TTL_MS = 30_000;

// ============================================================================
// WriteLockManager Implementation
// ============================================================================

/**
 * Manages write locks for multi-agent memory coordination.
 *
 * Design principles:
 * - 50ms fast-fail: if a lock is held by someone else, throw immediately
 * - Lazy cleanup: expired locks and agents are cleaned up on acquire
 * - Atomic acquisition: uses INSERT ... ON CONFLICT DO UPDATE with WHERE guard
 */
export class WriteLockManager {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Acquire a write lock on the given key.
   *
   * 1. Lazy cleanup: deletes expired locks and expired agents
   * 2. Atomic INSERT ... ON CONFLICT DO UPDATE: only succeeds if no valid
   *    lock exists or the existing lock has expired
   * 3. Fast-fail: if the lock is held by another agent and not expired,
   *    throws WriteLockConflictError immediately (no busy-wait)
   *
   * @param key - The lock key (typically a session/memory key)
   * @param holderId - The agent ID requesting the lock
   * @param ttlMs - Lock TTL in milliseconds (default: 30s)
   * @returns Lock acquisition result with expiry timestamp
   * @throws WriteLockConflictError if the lock is held by another agent
   */
  acquireLock(
    key: string,
    holderId: string,
    ttlMs: number = DEFAULT_LOCK_TTL_MS
  ): LockAcquireResult {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const acquiredAt = nowIso;

    // Step 1: Lazy cleanup — delete expired locks and expired agents
    this.db
      .prepare("DELETE FROM write_locks WHERE expires_at < $now")
      .run({ $now: nowIso });
    // Step 2: Atomic INSERT ... ON CONFLICT DO UPDATE
    // The UPDATE only succeeds if the existing lock has expired OR is held by the same agent
    const stmt = this.db.prepare(`
      INSERT INTO write_locks (lock_key, holder_id, acquired_at, expires_at, metadata)
      VALUES ($lock_key, $holder_id, $acquired_at, $expires_at, '{}')
      ON CONFLICT(lock_key) DO UPDATE SET
        holder_id = $holder_id,
        acquired_at = $acquired_at,
        expires_at = $expires_at,
        metadata = '{}'
      WHERE write_locks.expires_at < $now
         OR write_locks.holder_id = $holder_id
    `);

    const result = stmt.run({
      $lock_key: key,
      $holder_id: holderId,
      $acquired_at: acquiredAt,
      $expires_at: expiresAt,
      $now: nowIso,
    });

    // Step 3: Check if the upsert actually wrote a row
    // If changes === 0, a valid lock exists held by someone else
    if (result.changes === 0) {
      const existing = this.getLockInfo(key);
      if (existing && existing.holderId !== holderId) {
        throw new WriteLockConflictError(
          key,
          createAgentId(existing.holderId),
          createAgentId(holderId)
        );
      }
      // Edge case: lock was released between our check and here.
      // Retry once (non-recursive, just re-run the statement).
      const retryResult = stmt.run({
        $lock_key: key,
        $holder_id: holderId,
        $acquired_at: acquiredAt,
        $expires_at: expiresAt,
        $now: nowIso,
      });
      if (retryResult.changes === 0) {
        const retryExisting = this.getLockInfo(key);
        throw new WriteLockConflictError(
          key,
          createAgentId(retryExisting?.holderId ?? "unknown"),
          createAgentId(holderId)
        );
      }
    }

    return { acquired: true, expiresAt };
  }

  /**
   * Release a write lock. Only succeeds if the lock is held by the
   * specified holder (prevents one agent from releasing another's lock).
   *
   * @param key - The lock key to release
   * @param holderId - The agent ID that holds the lock
   * @returns true if the lock was released, false if not found or not owned
   */
  releaseLock(key: string, holderId: string): boolean {
    const stmt = this.db.prepare(
      "DELETE FROM write_locks WHERE lock_key = $lock_key AND holder_id = $holder_id"
    );
    const result = stmt.run({
      $lock_key: key,
      $holder_id: holderId,
    });
    return result.changes > 0;
  }

  /**
   * Check if a valid (non-expired) lock exists on the given key.
   *
   * @param key - The lock key to check
   * @returns true if a valid lock exists
   */
  isLocked(key: string): boolean {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        "SELECT lock_key FROM write_locks WHERE lock_key = $lock_key AND expires_at >= $now"
      )
      .get({ $lock_key: key, $now: now }) as { lock_key: string } | null;
    return row !== null;
  }

  /**
   * Get full information about a lock, including holder and expiry.
   * Returns null if no valid (non-expired) lock exists.
   *
   * @param key - The lock key to query
   * @returns Lock info or null
   */
  getLockInfo(key: string): LockInfo | null {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `SELECT lock_key, holder_id, acquired_at, expires_at, metadata
         FROM write_locks
         WHERE lock_key = $lock_key AND expires_at >= $now`
      )
      .get({ $lock_key: key, $now: now }) as WriteLockRow | null;

    if (!row) {
      return null;
    }

    return {
      lockKey: row.lock_key,
      holderId: row.holder_id,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
      metadata: (() => { try { return JSON.parse(row.metadata) as Record<string, unknown>; } catch { return {}; } })(),
    };
  }
}
