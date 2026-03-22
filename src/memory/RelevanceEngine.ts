/**
 * Relevance Engine for ping-mem
 *
 * Implements relevance decay and auto-consolidation for memory items.
 * Uses time-based exponential decay with priority/category/access weighting
 * to determine memory relevance, and consolidates stale memories into digests.
 *
 * @module memory/RelevanceEngine
 * @version 1.0.0
 */

import { Database, Statement } from "bun:sqlite";
import { SemanticCompressor } from "./SemanticCompressor.js";
import type { Memory } from "../types/index.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("RelevanceEngine");

/** FSRS per-category stability in days — how long before 50% retention */
const CATEGORY_STABILITY_DAYS: Record<string, number> = {
  decision: 180,
  error: 90,
  task: 30,
  fact: 30,
  observation: 3,
  progress: 7,
  note: 14,
  knowledge_entry: 60,
};

/** FSRS constants: R(t,S) = (1 + FSRS_FACTOR * t/S)^FSRS_DECAY */
const FSRS_DECAY = -0.5;
const FSRS_FACTOR = 19 / 81; // ≈ 0.2346

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for the RelevanceEngine
 */
export interface RelevanceEngineConfig {
  /** Decay factor per day (default: 0.97, halves every ~23 days) */
  decayFactor?: number;
  /** Score threshold below which memories are considered stale (default: 0.3) */
  staleThreshold?: number;
  /** Minimum days since last access for consolidation eligibility (default: 30) */
  minDaysForConsolidation?: number;
  /** Maximum number of memories per digest entry (default: 20) */
  maxPerDigest?: number;
  /** Maximum character length for digest values (default: 2000) */
  maxDigestLength?: number;
}

/**
 * Priority weight mapping
 */
const PRIORITY_WEIGHTS: Record<string, number> = {
  high: 1.5,
  normal: 1.0,
  low: 0.5,
};

/**
 * Category weight mapping
 */
const CATEGORY_WEIGHTS: Record<string, number> = {
  decision: 1.3,
  error: 1.2,
  task: 1.0,
  warning: 1.0,
  fact: 0.9,
  observation: 0.8,
  progress: 0.8,
  note: 0.7,
};

/**
 * Row from memory_relevance table
 */
interface RelevanceRow {
  memory_id: string;
  last_accessed: string | null;
  access_count: number;
  relevance_score: number;
}

/**
 * Row from events table for MEMORY_SAVED payloads
 */
interface MemoryEventRow {
  event_id: string;
  payload: string;
  metadata: string;
}

/**
 * Statistics about memory relevance distribution
 */
export interface RelevanceStats {
  /** Total tracked memories */
  total: number;
  /** Count of stale memories (score < staleThreshold) */
  staleCount: number;
  /** Average relevance score across all tracked memories */
  avgRelevance: number;
  /** Distribution by relevance tier */
  distribution: {
    /** Score >= 0.7 */
    high: number;
    /** Score >= 0.4 and < 0.7 */
    medium: number;
    /** Score >= staleThreshold and < 0.4 */
    low: number;
    /** Score < staleThreshold */
    stale: number;
  };
}

/**
 * A stale memory record found by findStaleMemories
 */
export interface StaleMemory {
  memoryId: string;
  lastAccessed: string | null;
  accessCount: number;
  relevanceScore: number;
}

/**
 * Options for finding stale memories
 */
export interface FindStaleOptions {
  /** Maximum relevance score to include (default: staleThreshold) */
  maxScore?: number;
  /** Minimum days since last access (default: 0) */
  minDaysOld?: number;
  /** Maximum number of results (default: 100) */
  limit?: number;
}

/**
 * Result of a consolidation operation
 */
export interface ConsolidationResult {
  /** Number of memories archived */
  archivedCount: number;
  /** Number of digest entries created */
  digestsCreated: number;
}

/**
 * Options for consolidation
 */
export interface ConsolidateOptions {
  /** Maximum relevance score for consolidation (default: staleThreshold) */
  maxScore?: number;
  /** Minimum days since last access (default: minDaysForConsolidation) */
  minDaysOld?: number;
}

/**
 * Parsed memory payload from MEMORY_SAVED event
 */
interface ParsedMemoryPayload {
  priority?: string;
  category?: string;
  key?: string;
  value?: string;
  sessionId?: string;
  channel?: string;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: Required<RelevanceEngineConfig> = {
  decayFactor: 0.97,
  staleThreshold: 0.3,
  minDaysForConsolidation: 30,
  maxPerDigest: 20,
  maxDigestLength: 2000,
};

// ============================================================================
// RelevanceEngine Implementation
// ============================================================================

/**
 * Manages memory relevance scoring, decay, and auto-consolidation.
 *
 * Uses the existing `memory_relevance` table (created by VectorIndex)
 * and creates an `archived_memories` table for consolidated memories.
 */
export class RelevanceEngine {
  private db: Database;
  private config: Required<RelevanceEngineConfig>;

  // Prepared statements
  private stmtGetRelevance: Statement;
  private stmtUpsertRelevance: Statement;
  private stmtUpdateScore: Statement;
  private stmtGetMemoryEvent: Statement;
  private stmtGetAllRelevance: Statement;
  private stmtDeleteRelevance: Statement;
  private stmtInsertArchive: Statement;
  private stmtGetStale: Statement;

  constructor(db: Database, config?: RelevanceEngineConfig) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize the archived_memories table (memory_relevance already exists)
    this.initializeSchema();

    // Prepare statements
    this.stmtGetRelevance = this.db.prepare(
      `SELECT memory_id, last_accessed, access_count, relevance_score
       FROM memory_relevance
       WHERE memory_id = $memoryId`
    );

    this.stmtUpsertRelevance = this.db.prepare(
      `INSERT INTO memory_relevance (memory_id, last_accessed, access_count, relevance_score)
       VALUES ($memoryId, $lastAccessed, $accessCount, $relevanceScore)
       ON CONFLICT(memory_id) DO UPDATE SET
         last_accessed = $lastAccessed,
         access_count = $accessCount,
         relevance_score = $relevanceScore`
    );

    this.stmtUpdateScore = this.db.prepare(
      `UPDATE memory_relevance
       SET relevance_score = $relevanceScore
       WHERE memory_id = $memoryId`
    );

    this.stmtGetMemoryEvent = this.db.prepare(
      `SELECT event_id, payload, metadata
       FROM events
       WHERE event_type = 'MEMORY_SAVED'
         AND json_extract(payload, '$.memoryId') = $memoryId
       ORDER BY timestamp DESC
       LIMIT 1`
    );

    this.stmtGetAllRelevance = this.db.prepare(
      `SELECT memory_id, last_accessed, access_count, relevance_score
       FROM memory_relevance`
    );

    this.stmtDeleteRelevance = this.db.prepare(
      `DELETE FROM memory_relevance WHERE memory_id = $memoryId`
    );

    this.stmtInsertArchive = this.db.prepare(
      `INSERT OR REPLACE INTO archived_memories
        (memory_id, original_key, original_value, original_category,
         original_session_id, archived_at, digest_key)
       VALUES ($memoryId, $originalKey, $originalValue, $originalCategory,
               $originalSessionId, $archivedAt, $digestKey)`
    );

    this.stmtGetStale = this.db.prepare(
      `SELECT memory_id, last_accessed, access_count, relevance_score
       FROM memory_relevance
       WHERE relevance_score < $maxScore
       ORDER BY relevance_score ASC
       LIMIT $limit`
    );
  }

  /**
   * Initialize tables for relevance tracking and archival.
   * Creates memory_relevance in EventStore's DB (separate from VectorIndex's copy)
   * and archived_memories for consolidated items.
   */
  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_relevance (
        memory_id TEXT PRIMARY KEY,
        last_accessed TEXT,
        access_count INTEGER DEFAULT 0,
        relevance_score REAL DEFAULT 1.0
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_relevance_score
      ON memory_relevance(relevance_score)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_relevance_accessed
      ON memory_relevance(last_accessed)
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS archived_memories (
        memory_id TEXT PRIMARY KEY,
        original_key TEXT NOT NULL,
        original_value TEXT NOT NULL,
        original_category TEXT,
        original_session_id TEXT NOT NULL,
        archived_at TEXT NOT NULL,
        digest_key TEXT
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_archived_memories_session
      ON archived_memories(original_session_id)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_archived_memories_digest
      ON archived_memories(digest_key)
    `);
  }

  // ========== Core Operations ==========

  /**
   * Track an access to a memory.
   * Increments access_count, updates last_accessed, and recalculates relevance.
   */
  trackAccess(memoryId: string): void {
    const now = new Date().toISOString();
    const existing = this.stmtGetRelevance.get({ $memoryId: memoryId }) as
      | RelevanceRow
      | undefined;

    if (existing) {
      const newAccessCount = existing.access_count + 1;
      const newScore = this.computeRelevance(memoryId, newAccessCount, now);

      this.stmtUpsertRelevance.run({
        $memoryId: memoryId,
        $lastAccessed: now,
        $accessCount: newAccessCount,
        $relevanceScore: newScore,
      });
    } else {
      // First access - insert with defaults
      const newScore = this.computeRelevance(memoryId, 1, now);
      this.stmtUpsertRelevance.run({
        $memoryId: memoryId,
        $lastAccessed: now,
        $accessCount: 1,
        $relevanceScore: newScore,
      });
    }
  }

  /**
   * Recalculate relevance score for a specific memory.
   * Returns the new score, or 0 if the memory is not tracked.
   */
  recalculateRelevance(memoryId: string): number {
    const existing = this.stmtGetRelevance.get({ $memoryId: memoryId }) as
      | RelevanceRow
      | undefined;

    if (!existing) {
      return 0;
    }

    const score = this.computeRelevance(
      memoryId,
      existing.access_count,
      existing.last_accessed
    );

    this.stmtUpdateScore.run({
      $memoryId: memoryId,
      $relevanceScore: score,
    });

    return score;
  }

  /**
   * Recalculate decay scores for all memories (batch operation for maintenance)
   */
  async recalculateAll(): Promise<number> {
    try {
      const rows = this.db.prepare("SELECT key, category, updated_at, access_count FROM memories").all() as Array<{
        key: string;
        category: string;
        updated_at: string;
        access_count: number;
      }>;

      let refreshed = 0;
      const now = Date.now();

      for (const row of rows) {
        const updatedAt = new Date(row.updated_at).getTime();
        const daysSinceAccess = (now - updatedAt) / (1000 * 60 * 60 * 24);
        const stabilityDays = CATEGORY_STABILITY_DAYS[row.category] ?? 30;
        const decayScore = Math.pow(
          1 + FSRS_FACTOR * (daysSinceAccess / stabilityDays),
          FSRS_DECAY
        );
        const accessBoost = 1 + 0.3 * Math.log(1 + (row.access_count ?? 0)) * Math.exp(-(daysSinceAccess * 24) / 168);
        const finalScore = decayScore * accessBoost;

        try {
          this.db.prepare("UPDATE memories SET relevance_score = ? WHERE key = ?").run(finalScore, row.key);
          refreshed++;
        } catch {
          // Column may not exist yet, skip silently
        }
      }

      return refreshed;
    } catch (error) {
      log.warn("recalculateAll failed", { error: error instanceof Error ? error.message : String(error) });
      return 0;
    }
  }

  /**
   * Get relevance statistics across all tracked memories.
   */
  getStats(): RelevanceStats {
    const allRows = this.stmtGetAllRelevance.all() as RelevanceRow[];

    const stats: RelevanceStats = {
      total: allRows.length,
      staleCount: 0,
      avgRelevance: 0,
      distribution: {
        high: 0,
        medium: 0,
        low: 0,
        stale: 0,
      },
    };

    if (allRows.length === 0) {
      return stats;
    }

    let totalScore = 0;

    for (const row of allRows) {
      const score = row.relevance_score;
      totalScore += score;

      if (score < this.config.staleThreshold) {
        stats.staleCount++;
        stats.distribution.stale++;
      } else if (score < 0.4) {
        stats.distribution.low++;
      } else if (score < 0.7) {
        stats.distribution.medium++;
      } else {
        stats.distribution.high++;
      }
    }

    stats.avgRelevance = totalScore / allRows.length;

    return stats;
  }

  /**
   * Find memories with low relevance scores.
   */
  findStaleMemories(options?: FindStaleOptions): StaleMemory[] {
    const maxScore = options?.maxScore ?? this.config.staleThreshold;
    const limit = options?.limit ?? 100;
    const minDaysOld = options?.minDaysOld ?? 0;

    if (minDaysOld > 0) {
      // Filter by both score and age
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - minDaysOld);
      const cutoffISO = cutoffDate.toISOString();

      const stmt = this.db.prepare(
        `SELECT memory_id, last_accessed, access_count, relevance_score
         FROM memory_relevance
         WHERE relevance_score < $maxScore
           AND (last_accessed IS NULL OR last_accessed < $cutoff)
         ORDER BY relevance_score ASC
         LIMIT $limit`
      );

      const rows = stmt.all({
        $maxScore: maxScore,
        $cutoff: cutoffISO,
        $limit: limit,
      }) as RelevanceRow[];

      return rows.map(this.rowToStaleMemory);
    }

    const rows = this.stmtGetStale.all({
      $maxScore: maxScore,
      $limit: limit,
    }) as RelevanceRow[];

    return rows.map(this.rowToStaleMemory);
  }

  /**
   * Consolidate stale memories into digests and archive originals.
   *
   * Process:
   * 1. Find stale memories (low relevance + old enough)
   * 2. Group by channel/category (from event payloads)
   * 3. Create digest entries using SemanticCompressor (LLM when available, heuristic fallback)
   * 4. Move originals to archived_memories table
   * 5. Remove from memory_relevance
   */
  async consolidate(options?: ConsolidateOptions): Promise<ConsolidationResult> {
    const maxScore = options?.maxScore ?? this.config.staleThreshold;
    const minDaysOld = options?.minDaysOld ?? this.config.minDaysForConsolidation;

    const staleMemories = this.findStaleMemories({
      maxScore,
      minDaysOld,
      limit: 1000,
    });

    if (staleMemories.length === 0) {
      return { archivedCount: 0, digestsCreated: 0 };
    }

    // Group by channel+category from event payloads
    const groups = new Map<string, Array<{ stale: StaleMemory; payload: ParsedMemoryPayload }>>();

    for (const stale of staleMemories) {
      const payload = this.getMemoryPayload(stale.memoryId);
      const channel = payload?.channel ?? "unknown";
      const category = payload?.category ?? "unknown";
      const groupKey = `${channel}::${category}`;

      const group = groups.get(groupKey);
      if (group) {
        group.push({ stale, payload: payload ?? {} });
      } else {
        groups.set(groupKey, [{ stale, payload: payload ?? {} }]);
      }
    }

    let archivedCount = 0;
    let digestsCreated = 0;

    // Attempt LLM-powered compression via SemanticCompressor
    const compressor = new SemanticCompressor();

    for (const [groupKey, members] of groups.entries()) {
      // Process in chunks of maxPerDigest
      for (let i = 0; i < members.length; i += this.config.maxPerDigest) {
        const chunk = members.slice(i, i + this.config.maxPerDigest);
        const digestKey = `digest::${groupKey}::${new Date().toISOString()}::${i}`;

        // Build Memory-like objects from payloads for the compressor
        const memoryLikes: Memory[] = chunk.map(({ stale, payload }) => {
          const mem: Memory = {
            id: stale.memoryId,
            key: payload.key ?? "unknown",
            value: payload.value ?? "",
            sessionId: payload.sessionId ?? "unknown",
            priority: (payload.priority ?? "normal") as Memory["priority"],
            privacy: "session" as Memory["privacy"],
            createdAt: new Date(),
            updatedAt: new Date(),
            metadata: {},
          };
          if (typeof payload.category === "string") {
            mem.category = payload.category;
          }
          if (payload.channel !== undefined) {
            mem.channel = payload.channel;
          }
          return mem;
        });

        let digestValue: string;

        try {
          const result = await compressor.compress(memoryLikes);
          if (result.facts.length > 0) {
            digestValue = result.facts.join("\n");
          } else {
            // Fallback to simple truncation if compressor returns no facts
            digestValue = this.buildHeuristicDigest(chunk);
          }
        } catch (compressError) {
          console.warn(
            `[RelevanceEngine] Semantic compression failed, falling back to heuristic:`,
            compressError instanceof Error ? compressError.message : String(compressError)
          );
          digestValue = this.buildHeuristicDigest(chunk);
        }

        if (digestValue.length > this.config.maxDigestLength) {
          digestValue =
            digestValue.substring(0, this.config.maxDigestLength - 3) + "...";
        }

        // Archive each memory in this chunk (synchronous SQLite transaction)
        const archiveTransaction = this.db.transaction(() => {
          for (const { stale, payload } of chunk) {
            this.stmtInsertArchive.run({
              $memoryId: stale.memoryId,
              $originalKey: payload.key ?? "unknown",
              $originalValue: payload.value ?? "",
              $originalCategory: payload.category ?? null,
              $originalSessionId: payload.sessionId ?? "unknown",
              $archivedAt: new Date().toISOString(),
              $digestKey: digestKey,
            });

            this.stmtDeleteRelevance.run({ $memoryId: stale.memoryId });
            archivedCount++;
          }
        });

        archiveTransaction();
        digestsCreated++;
      }
    }

    return { archivedCount, digestsCreated };
  }

  /**
   * Build a heuristic digest value by truncating memory payloads.
   * Used as fallback when SemanticCompressor is unavailable or fails.
   */
  private buildHeuristicDigest(
    chunk: Array<{ stale: StaleMemory; payload: ParsedMemoryPayload }>
  ): string {
    const digestParts: string[] = [];
    for (const { payload } of chunk) {
      const key = payload.key ?? "unknown";
      const value = payload.value ?? "";
      const truncatedValue =
        value.length > 200 ? value.substring(0, 200) + "..." : value;
      digestParts.push(`- ${key}: ${truncatedValue}`);
    }
    return digestParts.join("\n");
  }

  /**
   * Ensure a memory is tracked in memory_relevance.
   * Called when memories are first saved. Does nothing if already tracked.
   */
  ensureTracking(
    memoryId: string,
    priority?: string,
    category?: string
  ): void {
    const existing = this.stmtGetRelevance.get({ $memoryId: memoryId }) as
      | RelevanceRow
      | undefined;

    if (existing) {
      return; // Already tracked
    }

    const now = new Date().toISOString();

    // Compute initial relevance based on priority and category weights
    const priorityWeight = PRIORITY_WEIGHTS[priority ?? "normal"] ?? 1.0;
    const categoryWeight = CATEGORY_WEIGHTS[category ?? "note"] ?? 0.7;
    const initialScore = priorityWeight * categoryWeight;

    this.stmtUpsertRelevance.run({
      $memoryId: memoryId,
      $lastAccessed: now,
      $accessCount: 0,
      $relevanceScore: Math.min(initialScore, 2.0),
    });
  }

  /**
   * Get the current relevance score for a memory.
   * Returns 1.0 if not tracked (assumes fresh).
   */
  getRelevanceScore(memoryId: string): number {
    const row = this.stmtGetRelevance.get({ $memoryId: memoryId }) as
      | RelevanceRow
      | undefined;

    return row?.relevance_score ?? 1.0;
  }

  // ========== Internal Helpers ==========

  /**
   * Compute the relevance score for a memory.
   *
   * Formula:
   *   relevance = base_score * decay_factor^(days_since_access)
   * where:
   *   base_score = priority_weight * category_weight * access_frequency_bonus
   *   decay_factor = 0.97 (halves every ~23 days)
   *   access_frequency_bonus = min(1.0 + log2(access_count) * 0.1, 2.0)
   */
  private computeRelevance(
    memoryId: string,
    accessCount: number,
    lastAccessed: string | null
  ): number {
    // Get priority and category from the MEMORY_SAVED event
    const payload = this.getMemoryPayload(memoryId);
    const priority = payload?.priority ?? "normal";
    const category = payload?.category ?? "note";

    const priorityWeight = PRIORITY_WEIGHTS[priority] ?? 1.0;
    const categoryWeight = CATEGORY_WEIGHTS[category] ?? 0.7;

    // Access frequency bonus: min(1.0 + log2(access_count) * 0.1, 2.0)
    let accessFrequencyBonus = 1.0;
    if (accessCount > 0) {
      accessFrequencyBonus = Math.min(
        1.0 + Math.log2(accessCount) * 0.1,
        2.0
      );
    }

    const baseScore = priorityWeight * categoryWeight * accessFrequencyBonus;

    // Calculate days since last access
    let daysSinceAccess = 0;
    if (lastAccessed) {
      const lastAccessDate = new Date(lastAccessed);
      const now = new Date();
      daysSinceAccess = Math.max(
        0,
        (now.getTime() - lastAccessDate.getTime()) / (1000 * 60 * 60 * 24)
      );
    }

    // FSRS power-law decay with per-category stability
    const stabilityDays = CATEGORY_STABILITY_DAYS[category] ?? 30;
    const decayMultiplier = Math.pow(
      1 + FSRS_FACTOR * (daysSinceAccess / stabilityDays),
      FSRS_DECAY
    );

    // Access-weighted boost: frequently accessed memories decay slower
    const hoursSinceAccess = daysSinceAccess * 24;
    const accessBoost = 1 + 0.3 * Math.log(1 + accessCount) * Math.exp(-hoursSinceAccess / 168);

    const timeDecay = decayMultiplier * accessBoost;
    const relevance = baseScore * timeDecay;

    return relevance;
  }

  /**
   * Extract priority and category from a MEMORY_SAVED event payload.
   * Returns null if no matching event is found.
   */
  private getMemoryPayload(memoryId: string): ParsedMemoryPayload | null {
    const row = this.stmtGetMemoryEvent.get({ $memoryId: memoryId }) as
      | MemoryEventRow
      | undefined;

    if (!row) {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(row.payload);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }

      const payload = parsed as Record<string, unknown>;
      const result: ParsedMemoryPayload = {};

      // Extract from top-level payload
      if (typeof payload.key === "string") {
        result.key = payload.key;
      }
      if (typeof payload.sessionId === "string") {
        result.sessionId = payload.sessionId;
      }

      // Extract from nested memory object
      const memory = payload.memory;
      if (memory && typeof memory === "object") {
        const memObj = memory as Record<string, unknown>;
        if (typeof memObj.priority === "string") {
          result.priority = memObj.priority;
        }
        if (typeof memObj.category === "string") {
          result.category = memObj.category;
        }
        if (typeof memObj.value === "string") {
          result.value = memObj.value;
        }
        if (typeof memObj.channel === "string") {
          result.channel = memObj.channel;
        }
      }

      // Fallback: check event metadata for priority/category
      if (!result.priority || !result.category) {
        try {
          const metadata: unknown = JSON.parse(row.metadata);
          if (metadata && typeof metadata === "object") {
            const metaObj = metadata as Record<string, unknown>;
            if (!result.priority && typeof metaObj.priority === "string") {
              result.priority = metaObj.priority;
            }
            if (!result.category && typeof metaObj.category === "string") {
              result.category = metaObj.category;
            }
          }
        } catch (metaError: unknown) {
          const metaMsg = metaError instanceof Error ? metaError.message : String(metaError);
          log.debug("Metadata parse failure (non-fatal)", { error: metaMsg });
        }
      }

      return result;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn("Failed to build memory payload", { error: msg });
      return null;
    }
  }

  /**
   * Convert a RelevanceRow to a StaleMemory object.
   */
  private rowToStaleMemory(row: RelevanceRow): StaleMemory {
    return {
      memoryId: row.memory_id,
      lastAccessed: row.last_accessed,
      accessCount: row.access_count,
      relevanceScore: row.relevance_score,
    };
  }
}
