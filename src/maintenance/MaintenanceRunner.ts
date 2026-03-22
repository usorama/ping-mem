/**
 * MaintenanceRunner — Orchestrates memory maintenance: dedup → consolidate → prune → vacuum.
 *
 * Called by the memory_maintain MCP tool and optionally at the end of a session.
 *
 * @module maintenance/MaintenanceRunner
 */

import { createLogger } from "../util/logger.js";
import type { EventStore } from "../storage/EventStore.js";
import type { RelevanceEngine } from "../memory/RelevanceEngine.js";
import type { CcMemoryBridge } from "../integration/CcMemoryBridge.js";
import type { DreamingEngine, DreamResult } from "../dreaming/DreamingEngine.js";
import type { SessionId } from "../types/index.js";

const log = createLogger("MaintenanceRunner");

// ============================================================================
// Types
// ============================================================================

export interface MaintenanceResult {
  dedupCount: number;
  consolidateResult: { archivedCount: number; digestsCreated: number };
  pruneCount: number;
  vacuumRan: boolean;
  walSizeBefore: number;
  walSizeAfter: number;
  exportedCount: number;
  refreshedScores: number;
  durationMs: number;
  dreamResult?: DreamResult | undefined;
}

export interface MaintenanceOptions {
  /** Preview without modifying (default: false) */
  dryRun?: boolean | undefined;
  /** Run dreaming cycle after consolidation (default: false) */
  dream?: boolean | undefined;
  /** Similarity threshold for dedup (default: 0.95) */
  dedupThreshold?: number | undefined;
  /** Minimum relevance score for consolidation (default: 0.3) */
  consolidateMaxScore?: number | undefined;
  /** Minimum days since last access for consolidation (default: 30) */
  consolidateMinDays?: number | undefined;
  /** Relevance threshold below which memories are pruned (default: 0.2) */
  pruneThreshold?: number | undefined;
  /** Minimum age in days for pruning (default: 30) */
  pruneMinAgeDays?: number | undefined;
  /** WAL size threshold in bytes for vacuum (default: 50MB) */
  walThreshold?: number | undefined;
  /** Directory to export native memories to */
  exportDir?: string | undefined;
}

// ============================================================================
// MaintenanceRunner
// ============================================================================

export class MaintenanceRunner {
  private readonly eventStore: EventStore;
  private readonly relevanceEngine: RelevanceEngine | null;
  private readonly ccMemoryBridge: CcMemoryBridge | null;
  private readonly dreamingEngine: DreamingEngine | null;

  constructor(options: {
    eventStore: EventStore;
    relevanceEngine: RelevanceEngine | null;
    ccMemoryBridge?: CcMemoryBridge | null;
    dreamingEngine?: DreamingEngine | null;
  }) {
    this.eventStore = options.eventStore;
    this.relevanceEngine = options.relevanceEngine;
    this.ccMemoryBridge = options.ccMemoryBridge ?? null;
    this.dreamingEngine = options.dreamingEngine ?? null;
  }

  /**
   * Run full maintenance cycle: dedup → consolidate → prune → vacuum → export.
   */
  async run(options: MaintenanceOptions = {}): Promise<MaintenanceResult> {
    const start = Date.now();
    const dryRun = options.dryRun ?? false;

    log.info("Maintenance cycle starting", { dryRun });

    // Step 1: Dedup
    const dedupCount = await this.dedup(options, dryRun);

    // Step 2: Consolidate
    const consolidateResult = await this.consolidate(options, dryRun);

    // Step 2.5: Dreaming (opt-in)
    let dreamResult: DreamResult | undefined;
    if (options.dream && this.dreamingEngine) {
      const sessionId = `maintenance-${Date.now()}` as SessionId;
      dreamResult = await this.dreamingEngine.dream(sessionId);
    }

    // Step 3: Prune
    const pruneCount = await this.prune(options, dryRun);

    // Step 4: Vacuum
    const walSizeBefore = this.eventStore.getWalSizeBytes();
    const vacuumRan = await this.vacuum(options, dryRun);
    const walSizeAfter = this.eventStore.getWalSizeBytes();

    // Step 5: Export to native memory (if bridge available)
    const exportedCount = await this.exportToNative(options, dryRun);

    // Step: Refresh FSRS decay scores
    const refreshedScores = this.relevanceEngine ? await this.relevanceEngine.recalculateAll() : 0;

    const durationMs = Date.now() - start;
    const result: MaintenanceResult = {
      dedupCount,
      consolidateResult,
      pruneCount,
      vacuumRan,
      walSizeBefore,
      walSizeAfter,
      exportedCount,
      refreshedScores,
      durationMs,
      dreamResult,
    };

    log.info("Maintenance cycle complete", { ...result, dryRun });
    return result;
  }

  /**
   * Step 1: Dedup — find near-duplicate memories and supersede the lower-relevance one.
   * Without vector index, this is a no-op (returns 0).
   */
  private async dedup(options: MaintenanceOptions, dryRun: boolean): Promise<number> {
    const threshold = options.dedupThreshold ?? 0.95;
    const db = this.eventStore.getDatabase();

    // Find candidate duplicates using exact key prefix matching
    // (Full vector similarity requires VectorIndex which may not be available)
    type DupRow = { key: string; count: number };
    type EventRow = { id: string; payload: string; created_at: string };
    type SessionRow = { session_id: string };

    const rows = db.prepare(
      `SELECT json_extract(payload, '$.key') as key, COUNT(*) as count
       FROM events
       WHERE event_type = 'CONTEXT_SAVED'
       AND json_extract(payload, '$.key') IS NOT NULL
       GROUP BY json_extract(payload, '$.key')
       HAVING count > 1
       LIMIT 100`
    ).all() as DupRow[];

    let dedupCount = 0;
    for (const row of rows) {
      if (!row.key) continue;

      // Get all events for this key, ordered by timestamp (newest first)
      const dupes = db.prepare(
        `SELECT event_id as id, payload, timestamp as created_at FROM events
         WHERE event_type = 'CONTEXT_SAVED'
         AND json_extract(payload, '$.key') = ?
         ORDER BY created_at DESC`
      ).all(row.key) as EventRow[];

      if (dupes.length <= 1) continue;

      // Keep the newest, supersede the rest
      if (!dryRun) {
        for (let i = 1; i < dupes.length; i++) {
          const dupe = dupes[i];
          if (!dupe) continue;
          try {
            const sessionRow = db.prepare(
              `SELECT session_id FROM events WHERE event_id = ?`
            ).get(dupe.id) as SessionRow | null;
            if (sessionRow) {
              this.eventStore.createEvent(
                sessionRow.session_id,
                "MEMORY_SUPERSEDED",
                {
                  oldMemoryId: dupe.id,
                  newMemoryId: dupes[0]!.id,
                  key: row.key,
                  reason: "maintenance-dedup",
                },
              );
            }
          } catch (err) {
            log.warn("Dedup supersede failed", { key: row.key, error: err instanceof Error ? err.message : String(err) });
          }
          dedupCount++;
        }
      } else {
        dedupCount += dupes.length - 1;
      }
    }

    log.info("Dedup complete", { dedupCount, dryRun, threshold });
    return dedupCount;
  }

  /**
   * Step 2: Consolidate — delegate to RelevanceEngine.consolidate().
   */
  private async consolidate(
    options: MaintenanceOptions,
    dryRun: boolean
  ): Promise<{ archivedCount: number; digestsCreated: number }> {
    if (!this.relevanceEngine) {
      return { archivedCount: 0, digestsCreated: 0 };
    }

    if (dryRun) {
      // In dry run, just count what would be consolidated
      const stats = this.relevanceEngine.getStats();
      return { archivedCount: stats.staleCount, digestsCreated: 0 };
    }

    const consolidateOpts: { maxScore?: number; minDaysOld?: number } = {};
    if (options.consolidateMaxScore !== undefined) {
      consolidateOpts.maxScore = options.consolidateMaxScore;
    }
    if (options.consolidateMinDays !== undefined) {
      consolidateOpts.minDaysOld = options.consolidateMinDays;
    }

    return this.relevanceEngine.consolidate(consolidateOpts);
  }

  /**
   * Step 3: Prune — archive memories with very low relevance, zero access, and old age.
   * Does NOT delete — marks as superseded with reason "maintenance-prune".
   */
  private async prune(options: MaintenanceOptions, dryRun: boolean): Promise<number> {
    if (!this.relevanceEngine) {
      return 0;
    }

    const pruneThreshold = options.pruneThreshold ?? 0.2;
    const pruneMinAgeDays = options.pruneMinAgeDays ?? 30;
    const db = this.eventStore.getDatabase();

    type CandidateRow = { memory_id: string; relevance_score: number };
    type SessionRow = { session_id: string };

    // Find memories that are very low relevance, never accessed, and old
    const candidates = db.prepare(
      `SELECT memory_id, relevance_score FROM memory_relevance
       WHERE relevance_score < ?
       AND access_count = 0
       AND last_accessed < datetime('now', '-' || ? || ' days')
       LIMIT 500`
    ).all(pruneThreshold, pruneMinAgeDays) as CandidateRow[];

    if (dryRun) {
      return candidates.length;
    }

    let pruneCount = 0;
    for (const candidate of candidates) {
      try {
        const sessionRow = db.prepare(
          `SELECT session_id FROM events
           WHERE event_type = 'CONTEXT_SAVED'
           AND json_extract(payload, '$.memoryId') = ?
           LIMIT 1`
        ).get(candidate.memory_id) as SessionRow | null;

        if (sessionRow) {
          this.eventStore.createEvent(
            sessionRow.session_id,
            "MEMORY_SUPERSEDED",
            {
              oldMemoryId: candidate.memory_id,
              reason: "maintenance-prune",
              relevanceScore: candidate.relevance_score,
            },
          );
          pruneCount++;
        }
      } catch (err) {
        log.warn("Prune failed for memory", {
          memoryId: candidate.memory_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info("Prune complete", { pruneCount });
    return pruneCount;
  }

  /**
   * Step 4: Vacuum — checkpoint WAL if over threshold.
   */
  private async vacuum(options: MaintenanceOptions, dryRun: boolean): Promise<boolean> {
    const walThreshold = options.walThreshold ?? 50_000_000; // 50MB
    const walSize = this.eventStore.getWalSizeBytes();

    if (walSize < walThreshold) {
      return false;
    }

    if (dryRun) {
      log.info("Vacuum would run", { walSize, walThreshold });
      return true;
    }

    try {
      this.eventStore.walCheckpoint("TRUNCATE");
      log.info("WAL vacuum complete", { walSizeBefore: walSize, walSizeAfter: this.eventStore.getWalSizeBytes() });
      return true;
    } catch (err) {
      log.warn("WAL vacuum failed", { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /**
   * Step 5: Export high-relevance memories to native memory files.
   */
  private async exportToNative(options: MaintenanceOptions, dryRun: boolean): Promise<number> {
    if (!this.ccMemoryBridge || !options.exportDir) {
      return 0;
    }

    if (dryRun) {
      return 0;
    }

    try {
      return await this.ccMemoryBridge.exportToNativeMemory({
        topicsDir: options.exportDir,
        eventStore: this.eventStore,
      });
    } catch (err) {
      log.warn("Native memory export failed", { error: err instanceof Error ? err.message : String(err) });
      return 0;
    }
  }
}
