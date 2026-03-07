/**
 * Tests for MigrationLedger
 *
 * @module migration/__tests__/MigrationLedger.test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MigrationLedger } from "../MigrationLedger.js";

describe("MigrationLedger", () => {
  let ledger: MigrationLedger;

  beforeEach(() => {
    ledger = new MigrationLedger(":memory:");
  });

  afterEach(() => {
    ledger.close();
  });

  describe("recordSuccess", () => {
    test("should record a successful migration", () => {
      ledger.recordSuccess("sessions", "sess-1", "target-1");
      const record = ledger.getRecord("sessions", "sess-1");
      expect(record).not.toBeNull();
      expect(record!.sourceTable).toBe("sessions");
      expect(record!.sourceId).toBe("sess-1");
      expect(record!.targetId).toBe("target-1");
      expect(record!.status).toBe("success");
      expect(record!.errorMessage).toBeNull();
      expect(record!.migratedAt).toBeTruthy();
    });

    test("should mark item as migrated", () => {
      ledger.recordSuccess("sessions", "sess-2", "target-2");
      expect(ledger.wasMigrated("sessions", "sess-2")).toBe(true);
    });

    test("should handle numeric sourceId", () => {
      ledger.recordSuccess("checkpoints", 42, "target-42");
      expect(ledger.wasMigrated("checkpoints", 42)).toBe(true);
      const record = ledger.getRecord("checkpoints", 42);
      expect(record!.sourceId).toBe("42");
    });
  });

  describe("recordFailure", () => {
    test("should record a failed migration with error message", () => {
      ledger.recordFailure("context_items", "ctx-1", "target-ctx-1", "Connection timeout");
      const record = ledger.getRecord("context_items", "ctx-1");
      expect(record!.status).toBe("failed");
      expect(record!.errorMessage).toBe("Connection timeout");
    });

    test("failed records should NOT count as migrated", () => {
      ledger.recordFailure("sessions", "sess-fail", "tgt", "Error");
      expect(ledger.wasMigrated("sessions", "sess-fail")).toBe(false);
    });
  });

  describe("recordSkipped", () => {
    test("should record a skipped migration with reason", () => {
      ledger.recordSkipped("context_items", "ctx-skip", "Duplicate entry");
      const record = ledger.getRecord("context_items", "ctx-skip");
      expect(record!.status).toBe("skipped");
      expect(record!.errorMessage).toBe("Duplicate entry");
      expect(record!.targetId).toBe("");
    });
  });

  describe("getRecord", () => {
    test("should return null for non-existent record", () => {
      const record = ledger.getRecord("sessions", "nonexistent");
      expect(record).toBeNull();
    });

    test("should return correct data for existing record", () => {
      ledger.recordSuccess("sessions", "s1", "t1");
      const record = ledger.getRecord("sessions", "s1");
      expect(record).not.toBeNull();
      expect(record!.sourceTable).toBe("sessions");
      expect(record!.sourceId).toBe("s1");
      expect(record!.targetId).toBe("t1");
    });
  });

  describe("getStats", () => {
    test("should return zero counts for empty ledger", () => {
      const stats = ledger.getStats();
      expect(stats.totalRecords).toBe(0);
      expect(stats.successCount).toBe(0);
      expect(stats.failedCount).toBe(0);
      expect(stats.skippedCount).toBe(0);
      expect(Object.keys(stats.bySourceTable).length).toBe(0);
    });

    test("should count records correctly by status", () => {
      ledger.recordSuccess("sessions", "s1", "t1");
      ledger.recordSuccess("sessions", "s2", "t2");
      ledger.recordFailure("context_items", "c1", "tc1", "Error");
      ledger.recordSkipped("checkpoints", "cp1", "Skip reason");

      const stats = ledger.getStats();
      expect(stats.totalRecords).toBe(4);
      expect(stats.successCount).toBe(2);
      expect(stats.failedCount).toBe(1);
      expect(stats.skippedCount).toBe(1);
    });

    test("should count success records by source table", () => {
      ledger.recordSuccess("sessions", "s1", "t1");
      ledger.recordSuccess("sessions", "s2", "t2");
      ledger.recordSuccess("context_items", "c1", "tc1");
      ledger.recordSuccess("checkpoints", "cp1", "tcp1");

      const stats = ledger.getStats();
      expect(stats.bySourceTable.sessions).toBe(2);
      expect(stats.bySourceTable.context_items).toBe(1);
      expect(stats.bySourceTable.checkpoints).toBe(1);
    });
  });

  describe("idempotent upsert (INSERT OR REPLACE)", () => {
    test("should overwrite previous record for same source_table + source_id", () => {
      ledger.recordFailure("sessions", "s1", "t1", "First attempt failed");
      ledger.recordSuccess("sessions", "s1", "t1");

      const record = ledger.getRecord("sessions", "s1");
      expect(record!.status).toBe("success");
      expect(record!.errorMessage).toBeNull();
    });

    test("total records should not increase on upsert", () => {
      ledger.recordSuccess("sessions", "s1", "t1");
      ledger.recordSuccess("sessions", "s1", "t1-updated");

      const stats = ledger.getStats();
      expect(stats.totalRecords).toBe(1);
    });
  });

  describe("clear", () => {
    test("should remove all records", () => {
      ledger.recordSuccess("sessions", "s1", "t1");
      ledger.recordSuccess("sessions", "s2", "t2");
      ledger.recordFailure("context_items", "c1", "tc1", "Err");

      ledger.clear();
      const stats = ledger.getStats();
      expect(stats.totalRecords).toBe(0);
      expect(stats.successCount).toBe(0);
      expect(stats.failedCount).toBe(0);
    });
  });
});
