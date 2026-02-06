/**
 * Migration Ledger for Idempotency
 *
 * Tracks which items have been migrated to enable safe re-runs.
 * Uses a simple SQLite table to record completed migrations.
 *
 * @module migration/MigrationLedger
 * @version 1.0.0
 */

import { Database } from "bun:sqlite";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// ============================================================================
// Migration Ledger Types
// ============================================================================

export interface MigrationRecord {
  sourceTable: "sessions" | "context_items" | "checkpoints";
  sourceId: string | number;
  targetId: string;
  migratedAt: string;
  status: "success" | "failed" | "skipped";
  errorMessage: string | null;
}

// ============================================================================
// Migration Ledger
// ============================================================================

export class MigrationLedger {
  private db: Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? path.join(os.homedir(), ".ping-mem", "migration-ledger.db");

    // Ensure directory exists
    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Open database
    this.db = new Database(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");

    // Initialize schema
    this.initializeSchema();
  }

  /**
   * Initialize ledger schema
   */
  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migration_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_table TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        migrated_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('success', 'failed', 'skipped')),
        error_message TEXT,
        UNIQUE(source_table, source_id)
      );

      CREATE INDEX IF NOT EXISTS idx_migration_records_source
        ON migration_records(source_table, source_id);

      CREATE INDEX IF NOT EXISTS idx_migration_records_status
        ON migration_records(status);
    `);
  }

  /**
   * Record a successful migration
   */
  recordSuccess(
    sourceTable: MigrationRecord["sourceTable"],
    sourceId: string | number,
    targetId: string
  ): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO migration_records
      (source_table, source_id, target_id, migrated_at, status, error_message)
      VALUES (?, ?, ?, ?, 'success', NULL)
    `);
    stmt.run(sourceTable, String(sourceId), targetId, new Date().toISOString());
  }

  /**
   * Record a failed migration
   */
  recordFailure(
    sourceTable: MigrationRecord["sourceTable"],
    sourceId: string | number,
    targetId: string,
    errorMessage: string
  ): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO migration_records
      (source_table, source_id, target_id, migrated_at, status, error_message)
      VALUES (?, ?, ?, ?, 'failed', ?)
    `);
    stmt.run(
      sourceTable,
      String(sourceId),
      targetId,
      new Date().toISOString(),
      errorMessage
    );
  }

  /**
   * Record a skipped migration
   */
  recordSkipped(
    sourceTable: MigrationRecord["sourceTable"],
    sourceId: string | number,
    reason: string
  ): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO migration_records
      (source_table, source_id, target_id, migrated_at, status, error_message)
      VALUES (?, ?, '', ?, 'skipped', ?)
    `);
    stmt.run(sourceTable, String(sourceId), new Date().toISOString(), reason);
  }

  /**
   * Check if an item has been migrated
   */
  wasMigrated(
    sourceTable: MigrationRecord["sourceTable"],
    sourceId: string | number
  ): boolean {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM migration_records
      WHERE source_table = ? AND source_id = ? AND status = 'success'
    `);
    const result = stmt.get(sourceTable, String(sourceId)) as { count: number };
    return result.count > 0;
  }

  /**
   * Get migration record for an item
   */
  getRecord(
    sourceTable: MigrationRecord["sourceTable"],
    sourceId: string | number
  ): MigrationRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        source_table as sourceTable,
        source_id as sourceId,
        target_id as targetId,
        migrated_at as migratedAt,
        status,
        error_message as errorMessage
      FROM migration_records
      WHERE source_table = ? AND source_id = ?
    `);
    const result = stmt.get(sourceTable, String(sourceId)) as MigrationRecord | undefined;
    return result ?? null;
  }

  /**
   * Get migration statistics
   */
  getStats(): {
    totalRecords: number;
    successCount: number;
    failedCount: number;
    skippedCount: number;
    bySourceTable: Record<string, number>;
  } {
    const totalStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM migration_records"
    );
    const successStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM migration_records WHERE status = 'success'"
    );
    const failedStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM migration_records WHERE status = 'failed'"
    );
    const skippedStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM migration_records WHERE status = 'skipped'"
    );
    const byTableStmt = this.db.prepare(`
      SELECT source_table, COUNT(*) as count
      FROM migration_records
      WHERE status = 'success'
      GROUP BY source_table
    `);

    const total = (totalStmt.get() as { count: number }).count;
    const success = (successStmt.get() as { count: number }).count;
    const failed = (failedStmt.get() as { count: number }).count;
    const skipped = (skippedStmt.get() as { count: number }).count;
    const byTable = byTableStmt.all() as Array<{ source_table: string; count: number }>;

    const bySourceTable: Record<string, number> = {};
    for (const row of byTable) {
      bySourceTable[row.source_table] = row.count;
    }

    return {
      totalRecords: total,
      successCount: success,
      failedCount: failed,
      skippedCount: skipped,
      bySourceTable,
    };
  }

  /**
   * Clear all records (use with caution)
   */
  clear(): void {
    this.db.exec("DELETE FROM migration_records");
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
