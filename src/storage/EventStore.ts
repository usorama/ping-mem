/**
 * SQLite Event Store for ping-mem
 *
 * Provides persistent, append-only event storage for session and memory events.
 * Based on rad-engineer-v3 core event store patterns.
 *
 * @module storage/EventStore
 * @version 1.0.0
 */

import { Database, Statement } from "bun:sqlite";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import type {
  EventType,
  SessionId,
  MemoryId,
  SessionEventData,
  MemoryEventData,
  WorklogEventData,
} from "../types/index.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("EventStore");

/** Module-level constant for WAL checkpoint mode validation (allocated once). */
const VALID_WAL_MODES = new Set(["PASSIVE", "TRUNCATE", "FULL", "RESTART"] as const);

// ============================================================================
// Event Store Configuration
// ============================================================================

/**
 * Configuration for the event store
 */
export interface EventStoreConfig {
  /** Path to SQLite database file */
  dbPath?: string | undefined;
  /** Enable WAL mode for better concurrency */
  walMode?: boolean | undefined;
  /** Enable foreign key constraints */
  foreignKeys?: boolean | undefined;
  /** Busy timeout in milliseconds */
  busyTimeout?: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<EventStoreConfig> = {
  dbPath: path.join(os.homedir(), ".ping-mem", "events.db"),
  walMode: true,
  foreignKeys: true,
  busyTimeout: 5000,
};

// ============================================================================
// Event Types
// ============================================================================

/**
 * A single event in the event store
 */
export interface Event {
  /** Unique event ID (UUIDv7) */
  eventId: string;
  /** Event timestamp */
  timestamp: Date;
  /** Session this event belongs to */
  sessionId: SessionId;
  /** Type of event */
  eventType: EventType;
  /** Event payload (session or memory data) */
  payload: SessionEventData | MemoryEventData | WorklogEventData | Record<string, unknown>;
  /** Event that caused this one (causality) */
  causedBy?: string;
  /** Additional metadata */
  metadata: Record<string, unknown>;
  /** Agent that produced this event (multi-agent support) */
  agent_id?: string;
}

/**
 * Database row type for events
 */
interface EventRow {
  event_id: string;
  timestamp: string;
  session_id: string;
  event_type: string;
  payload: string;
  caused_by: string | null;
  metadata: string;
  agent_id: string | null;
}

/**
 * Database row type for checkpoints
 */
interface CheckpointRow {
  checkpoint_id: string;
  session_id: string;
  timestamp: string;
  last_event_id: string;
  memory_count: number;
  description: string | null;
}

/**
 * A checkpoint represents a snapshot of session state
 */
export interface Checkpoint {
  /** Unique checkpoint ID */
  checkpointId: string;
  /** Session this checkpoint belongs to */
  sessionId: SessionId;
  /** When checkpoint was created */
  timestamp: Date;
  /** Last event ID included in checkpoint */
  lastEventId: string;
  /** Number of memories at checkpoint */
  memoryCount: number;
  /** Optional description */
  description?: string;
}

// ============================================================================
// Event Store Implementation
// ============================================================================

/**
 * SQLite-based event store for ping-mem
 */
export class EventStore {
  private db: Database;
  /** True when backed by an in-memory SQLite database (`:memory:`). Checked by clear(). */
  private readonly isInMemory: boolean;
  /** Stored promise so concurrent close() callers all await the same operation */
  private closePromise: Promise<void> | undefined;
  private config: {
    dbPath: string;
    walMode: boolean;
    foreignKeys: boolean;
    busyTimeout: number;
  };

  // UUID v7 monotonic counter — RFC 9562 §5.7 requires monotonic ordering when multiple
  // IDs are generated within the same millisecond. Counter resets on each new ms tick.
  private uuidLastMs = -1;
  private uuidSeq = 0;

  // Prepared statements
  private stmtInsertEvent: Statement;
  private stmtGetEventById: Statement;
  private stmtGetEventsBySession: Statement;
  private stmtGetEventsByTimeRange: Statement;
  private stmtInsertCheckpoint: Statement;
  private stmtGetCheckpoint: Statement;
  private stmtGetCheckpointsBySession: Statement;
  private stmtListSessionStarts: Statement;
  // Prepared statements for deleteSessions() — hoisted to avoid per-call compilation overhead
  private stmtDeleteCheckpointItems: Statement;
  private stmtDeleteCheckpointsBySession: Statement;
  private stmtDeleteEventsBySession: Statement;
  private stmtGetEventIdsBySession: Statement;
  private stmtForeignKeyCheck: Statement;
  // Prepared statements for checkpoint item operations — hoisted for consistent hot-path performance
  private stmtInsertCheckpointItem: Statement;
  private stmtGetCheckpointItems: Statement;
  // Remaining hot-path statements — hoisted to avoid per-call SQL compilation overhead
  private stmtGetLastEventBySession: Statement;
  private stmtGetRecentEvents: Statement;
  // ping() uses a hoisted statement to avoid per-call SQL compilation overhead
  private stmtPing: Statement;
  private stmtListSessions: Statement;
  private stmtIsAgentActive: Statement;
  private stmtGetEventCount: Statement;
  private stmtGetCheckpointCount: Statement;
  private stmtGetPageCount: Statement;
  private stmtGetFreelistCount: Statement;
  private stmtQuickCheck: Statement;

  constructor(config?: EventStoreConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config } as typeof this.config;
    // Set at construction so clear() does not re-evaluate the path string at call time.
    this.isInMemory = this.config.dbPath === ":memory:";

    // Ensure directory exists (skip for in-memory)
    if (!this.isInMemory) {
      const dbDir = path.dirname(this.config.dbPath);
      if (!fs.existsSync(dbDir)) {
        try {
          fs.mkdirSync(dbDir, { recursive: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`EventStore: cannot create database directory '${dbDir}': ${msg}`);
        }
      }
    }

    // Open database
    this.db = new Database(this.config.dbPath);

    // Configure database
    if (this.config.walMode && this.config.dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.db.exec("PRAGMA wal_autocheckpoint = 1000");
    }
    if (this.config.foreignKeys) {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
    const rawTimeout = Number(this.config.busyTimeout);
    const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(rawTimeout, 60000) : 5000;
    // Math.trunc ensures an integer string (no "5000.0") — value is already validated/clamped above
    // so numeric injection is not possible, but integer form is canonical for PRAGMA.
    this.db.exec(`PRAGMA busy_timeout = ${Math.trunc(timeout)}`);

    // Initialize schema
    this.initializeSchema();

    // WAL recovery: if WAL file is oversized from a prior crash, force a TRUNCATE checkpoint.
    // On startup there are no concurrent writers, so TRUNCATE is safe and effective.
    if (this.config.walMode && this.config.dbPath !== ":memory:") {
      const walSize = this.getWalSizeBytes();
      if (walSize > 1_048_576) {
        log.info("WAL file oversized, running TRUNCATE checkpoint", { walSize });
        try {
          this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          log.info("WAL recovery complete", { newWalSize: this.getWalSizeBytes() });
        } catch (err) {
          log.error("WAL recovery failed — HealthMonitor will attempt PASSIVE checkpoints at runtime", {
            error: err instanceof Error ? err.message : String(err),
            walSize,
          });
        }
      }
    }

    // Prepare statements (bun:sqlite uses $name for parameters)
    this.stmtInsertEvent = this.db.prepare(`
      INSERT INTO events (
        event_id, timestamp, session_id, event_type,
        payload, caused_by, metadata, agent_id
      ) VALUES (
        $event_id, $timestamp, $session_id, $event_type,
        $payload, $caused_by, $metadata, $agent_id
      )
    `);

    this.stmtGetEventById = this.db.prepare(`
      SELECT * FROM events WHERE event_id = $event_id
    `);

    this.stmtGetEventsBySession = this.db.prepare(`
      SELECT * FROM events WHERE session_id = $session_id ORDER BY timestamp ASC
    `);

    this.stmtGetEventsByTimeRange = this.db.prepare(`
      SELECT * FROM events
      WHERE timestamp >= $start AND timestamp <= $end
      ORDER BY timestamp ASC
    `);

    this.stmtInsertCheckpoint = this.db.prepare(`
      INSERT INTO checkpoints (
        checkpoint_id, session_id, timestamp,
        last_event_id, memory_count, description
      ) VALUES (
        $checkpoint_id, $session_id, $timestamp,
        $last_event_id, $memory_count, $description
      )
    `);

    this.stmtGetCheckpoint = this.db.prepare(`
      SELECT * FROM checkpoints WHERE checkpoint_id = $checkpoint_id
    `);

    this.stmtGetCheckpointsBySession = this.db.prepare(`
      SELECT * FROM checkpoints
      WHERE session_id = $session_id
      ORDER BY timestamp DESC
    `);

    // LIMIT 10000: prevents a full-table scan from loading unbounded rows into memory
    // when findSessionIdsByProjectDir() is called during project deletion.
    // ORDER BY timestamp ASC: stable ordering for consistent project-dir filtering results.
    this.stmtListSessionStarts = this.db.prepare(`
      SELECT session_id, metadata
      FROM events
      WHERE event_type = 'SESSION_STARTED'
      ORDER BY timestamp ASC
      LIMIT 10000
    `);

    // Statements for deleteSessions() — compiled once to avoid per-call overhead
    this.stmtDeleteCheckpointItems = this.db.prepare(
      "DELETE FROM checkpoint_items WHERE checkpoint_id IN (SELECT checkpoint_id FROM checkpoints WHERE session_id = $sessionId)"
    );
    this.stmtDeleteCheckpointsBySession = this.db.prepare(
      "DELETE FROM checkpoints WHERE session_id = $sessionId"
    );
    this.stmtDeleteEventsBySession = this.db.prepare(
      "DELETE FROM events WHERE session_id = $sessionId"
    );
    this.stmtGetEventIdsBySession = this.db.prepare(
      "SELECT event_id FROM events WHERE session_id = ?"
    );
    this.stmtForeignKeyCheck = this.db.prepare("PRAGMA foreign_keys");
    this.stmtInsertCheckpointItem = this.db.prepare(
      "INSERT INTO checkpoint_items (checkpoint_id, memory_key) VALUES (?, ?)"
    );
    this.stmtGetCheckpointItems = this.db.prepare(
      "SELECT memory_key FROM checkpoint_items WHERE checkpoint_id = ?"
    );
    // Fetch only the latest event for a session — used by createCheckpoint() to avoid
    // loading the full event history when all we need is the last event ID.
    // ORDER BY event_id DESC (not timestamp): UUIDv7 event IDs encode millisecond timestamp
    // + a 12-bit monotonic sequence counter, guaranteeing total order even for same-millisecond
    // events. Ordering by the ISO-8601 timestamp string is non-deterministic when two events
    // share the same millisecond.
    this.stmtGetLastEventBySession = this.db.prepare(
      "SELECT event_id FROM events WHERE session_id = $session_id ORDER BY event_id DESC LIMIT 1"
    );
    // GROUP BY + MIN(timestamp): correct way to get distinct sessions ordered by first appearance.
    // DISTINCT + ORDER BY on a non-projected column forces a full-table scan without benefiting
    // from the idx_events_session index. LIMIT 10000: prevent unbounded memory load.
    this.stmtListSessions = this.db.prepare(
      "SELECT session_id FROM events GROUP BY session_id ORDER BY MIN(timestamp) ASC LIMIT 10000"
    );
    // $limit is a bind parameter so we can reuse this statement for all limit values.
    this.stmtGetRecentEvents = this.db.prepare(
      "SELECT * FROM events ORDER BY timestamp DESC LIMIT $limit"
    );
    // Hoisted so ping() avoids per-call SQL compilation overhead on the hot liveness path.
    this.stmtPing = this.db.prepare("SELECT 1");
    this.stmtIsAgentActive = this.db.prepare(
      "SELECT 1 FROM agent_quotas WHERE agent_id = $agent_id AND (expires_at IS NULL OR expires_at >= $now)"
    );
    this.stmtGetEventCount = this.db.prepare("SELECT COUNT(*) as count FROM events");
    this.stmtGetCheckpointCount = this.db.prepare("SELECT COUNT(*) as count FROM checkpoints");
    this.stmtGetPageCount = this.db.prepare("PRAGMA page_count");
    this.stmtGetFreelistCount = this.db.prepare("PRAGMA freelist_count");
    this.stmtQuickCheck = this.db.prepare("PRAGMA quick_check");
  }

  /**
   * Initialize database schema
   */
  private initializeSchema(): void {
    // Temporarily disable foreign keys during schema creation
    // (events table has self-referencing foreign key that would fail validation)
    this.db.exec("PRAGMA foreign_keys = OFF");

    this.db.exec(`
      -- Events table (append-only)
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        caused_by TEXT,
        metadata TEXT NOT NULL,
        FOREIGN KEY (caused_by) REFERENCES events(event_id)
      );

      -- Checkpoints table
      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        last_event_id TEXT NOT NULL,
        memory_count INTEGER NOT NULL,
        description TEXT,
        FOREIGN KEY (last_event_id) REFERENCES events(event_id)
      );

      -- Checkpoint items table (stores which memories are part of each checkpoint)
      CREATE TABLE IF NOT EXISTS checkpoint_items (
        checkpoint_id TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        PRIMARY KEY (checkpoint_id, memory_key),
        FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(checkpoint_id) ON DELETE CASCADE
      );

      -- Migrations tracking table
      CREATE TABLE IF NOT EXISTS migrations (
        migration_id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_events_session
        ON events(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp
        ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_type
        ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session
        ON checkpoints(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_checkpoint_items_checkpoint
        ON checkpoint_items(checkpoint_id);
    `);

    // Re-enable foreign keys if configured
    if (this.config.foreignKeys) {
      this.db.exec("PRAGMA foreign_keys = ON");
    }

    // Run schema migrations
    this.runMigrations();
  }

  /**
   * Run a single migration if it hasn't been applied yet.
   * Uses a transaction to atomically apply the migration and record it.
   */
  private runMigration(id: string, sql: string): void {
    const existing = this.db
      .prepare("SELECT migration_id FROM migrations WHERE migration_id = $id")
      .get({ $id: id }) as { migration_id: string } | undefined;

    if (existing) {
      return; // Already applied
    }

    const applyMigration = this.db.transaction(() => {
      this.db.exec(sql);
      this.db.prepare(
        "INSERT INTO migrations (migration_id, applied_at) VALUES ($id, $applied_at)"
      ).run({
        $id: id,
        $applied_at: new Date().toISOString(),
      });
    });
    applyMigration();
  }

  /**
   * Run all pending schema migrations in order.
   */
  private runMigrations(): void {
    // v2_agent_id_column: Add agent_id column to events table
    // SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN,
    // so we check table_info first.
    const columns = this.db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    const hasAgentId = columns.some((col) => col.name === "agent_id");
    if (!hasAgentId) {
      this.runMigration(
        "v2_agent_id_column",
        "ALTER TABLE events ADD COLUMN agent_id TEXT"
      );
    } else {
      // Record migration as applied if column already exists (e.g., from manual ALTER).
      // Wrapped in a transaction (same as runMigration) so a crash between check and insert
      // does not leave migrations table in an inconsistent state.
      const existing = this.db
        .prepare("SELECT migration_id FROM migrations WHERE migration_id = $id")
        .get({ $id: "v2_agent_id_column" }) as { migration_id: string } | undefined;
      if (!existing) {
        this.db.transaction(() => {
          this.db.prepare(
            "INSERT INTO migrations (migration_id, applied_at) VALUES ($id, $applied_at)"
          ).run({
            $id: "v2_agent_id_column",
            $applied_at: new Date().toISOString(),
          });
        })();
      }
    }

    // v2_agent_quotas: Create agent_quotas table
    this.runMigration(
      "v2_agent_quotas",
      `CREATE TABLE IF NOT EXISTS agent_quotas (
        agent_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        admin INTEGER NOT NULL DEFAULT 0,
        ttl_ms INTEGER NOT NULL DEFAULT 86400000,
        expires_at TEXT,
        current_bytes INTEGER NOT NULL DEFAULT 0,
        current_count INTEGER NOT NULL DEFAULT 0,
        quota_bytes INTEGER NOT NULL DEFAULT 10485760,
        quota_count INTEGER NOT NULL DEFAULT 10000,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      )`
    );

    // v2_write_locks: Create write_locks table
    this.runMigration(
      "v2_write_locks",
      `CREATE TABLE IF NOT EXISTS write_locks (
        lock_key TEXT PRIMARY KEY,
        holder_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      )`
    );
  }

  /**
   * Generate UUID v7 (time-sortable) with RFC 9562 §5.7 monotonic counter.
   *
   * Within the same millisecond tick the 12-bit sequence field increments so that
   * IDs remain sortable even when multiple are generated in rapid succession.
   * The sequence resets to 0 on each new millisecond tick.
   */
  private generateUUID(): string {
    let timestamp = Date.now();

    if (timestamp === this.uuidLastMs) {
      this.uuidSeq++;
      // If sequence overflows 12 bits, advance the timestamp by 1 ms to guarantee uniqueness.
      if (this.uuidSeq > 0xfff) {
        timestamp++;
        this.uuidLastMs = timestamp;
        this.uuidSeq = 0;
      }
    } else {
      this.uuidLastMs = timestamp;
      this.uuidSeq = 0;
    }

    const timestampHex = timestamp.toString(16).padStart(12, "0");
    const seqHex = this.uuidSeq.toString(16).padStart(3, "0");

    const randomBytes = crypto.randomBytes(8);
    const randomHex = randomBytes.toString("hex");

    // UUID v7 format: tttttttt-tttt-7sss-yxxx-xxxxxxxxxxxx
    // Where sss = 12-bit monotonic sequence for sub-ms ordering
    const uuid =
      timestampHex.slice(0, 8) +
      "-" +
      timestampHex.slice(8, 12) +
      "-7" +
      seqHex +
      "-" +
      ((parseInt(randomHex.slice(0, 1), 16) & 0x3) | 0x8).toString(16) +
      randomHex.slice(1, 4) +
      "-" +
      randomHex.slice(4, 16);

    return uuid;
  }

  /**
   * Convert event to database row
   */
  private eventToRow(event: Event): Record<string, string | null> {
    return {
      $event_id: event.eventId,
      $timestamp: event.timestamp.toISOString(),
      $session_id: event.sessionId,
      $event_type: event.eventType,
      $payload: JSON.stringify(event.payload),
      $caused_by: event.causedBy ?? null,
      $metadata: JSON.stringify(event.metadata),
      $agent_id: event.agent_id ?? null,
    };
  }

  /**
   * Convert database row to event
   */
  private rowToEvent(row: EventRow): Event {
    let payload: unknown;
    let metadata: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      throw new Error(`EventStore: corrupted payload JSON for event ${row.event_id}`);
    }
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      throw new Error(`EventStore: corrupted metadata JSON for event ${row.event_id}`);
    }
    const event: Event = {
      eventId: row.event_id,
      timestamp: new Date(row.timestamp),
      sessionId: row.session_id,
      eventType: row.event_type as EventType,
      payload: payload as Event["payload"],
      metadata: metadata as Event["metadata"],
    };
    if (row.caused_by !== null) {
      event.causedBy = row.caused_by;
    }
    if (row.agent_id !== null && row.agent_id !== undefined) {
      event.agent_id = row.agent_id;
    }
    return event;
  }

  /**
   * Convert database row to checkpoint
   */
  private rowToCheckpoint(row: CheckpointRow): Checkpoint {
    const checkpoint: Checkpoint = {
      checkpointId: row.checkpoint_id,
      sessionId: row.session_id,
      timestamp: new Date(row.timestamp),
      lastEventId: row.last_event_id,
      memoryCount: row.memory_count,
    };
    if (row.description !== null) {
      checkpoint.description = row.description;
    }
    return checkpoint;
  }

  // ========== Write Operations ==========

  /**
   * Append a single event to the store
   */
  async append(event: Event): Promise<void> {
    const row = this.eventToRow(event);
    try {
      this.stmtInsertEvent.run(row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`EventStore: failed to append event ${event.eventId}: ${msg}`);
    }
  }

  /**
   * Append multiple events atomically
   */
  async appendBatch(events: Event[]): Promise<void> {
    const insertMany = this.db.transaction(() => {
      for (const event of events) {
        const row = this.eventToRow(event);
        this.stmtInsertEvent.run(row);
      }
    });
    try {
      insertMany();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`EventStore: failed to append batch of ${events.length} events: ${msg}`);
    }
  }

  /**
   * Create a new event with generated ID
   */
  async createEvent(
    sessionId: SessionId,
    eventType: EventType,
    payload: SessionEventData | MemoryEventData | WorklogEventData | Record<string, unknown>,
    metadata: Record<string, unknown> = {},
    causedBy?: string
  ): Promise<Event> {
    const event: Event = {
      eventId: this.generateUUID(),
      timestamp: new Date(),
      sessionId,
      eventType,
      payload,
      metadata,
    };
    if (causedBy !== undefined) {
      event.causedBy = causedBy;
    }

    await this.append(event);
    return event;
  }

  // ========== Read Operations ==========

  /**
   * Get event by ID
   */
  async getById(eventId: string): Promise<Event | null> {
    const row = this.stmtGetEventById.get({ $event_id: eventId }) as EventRow | undefined;
    return row ? this.rowToEvent(row) : null;
  }

  /**
   * Get all events for a session
   */
  async getBySession(sessionId: SessionId): Promise<Event[]> {
    const rows = this.stmtGetEventsBySession.all({ $session_id: sessionId }) as EventRow[];
    return rows.map((row) => this.rowToEvent(row));
  }

  /**
   * Find session IDs for a specific projectDir.
   */
  findSessionIdsByProjectDir(projectDir: string): SessionId[] {
    const rows = this.stmtListSessionStarts.all() as Array<{
      session_id: string;
      metadata: string;
    }>;

    const matching: SessionId[] = [];
    for (const row of rows) {
      try {
        const metadata = JSON.parse(row.metadata) as { projectDir?: string };
        if (metadata.projectDir === projectDir) {
          matching.push(row.session_id as SessionId);
        }
      } catch (error) {
        log.warn("findSessionIdsByProjectDir: failed to parse metadata for session", { sessionId: row.session_id, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }

    return Array.from(new Set(matching));
  }

  /**
   * Delete events and checkpoints for the provided session IDs.
   *
   * Security: Uses parameterized queries to prevent SQL injection.
   * Each session ID is deleted individually within a transaction.
   */
  deleteSessions(sessionIds: SessionId[]): void {
    if (sessionIds.length === 0) {
      return;
    }

    // Use individual parameterized deletes instead of IN clause interpolation
    // This prevents SQL injection even if sessionIds contains malicious values
    const deleteMany = this.db.transaction(() => {
      // Verify foreign key constraints are enabled before deletion
      const fkCheck = this.stmtForeignKeyCheck.get() as { foreign_keys: number } | undefined;
      if (!fkCheck || fkCheck.foreign_keys !== 1) {
        throw new Error("Foreign key constraints must be enabled for safe session deletion");
      }

      // Collect event IDs before deletion for the post-delete integrity check.
      const eventIds: string[] = [];
      for (const sessionId of sessionIds) {
        const rows = this.stmtGetEventIdsBySession.all(sessionId) as Array<{ event_id: string }>;
        for (const row of rows) { eventIds.push(row.event_id); }
      }

      for (const sessionId of sessionIds) {
        this.stmtDeleteCheckpointItems.run({ $sessionId: sessionId });
        this.stmtDeleteCheckpointsBySession.run({ $sessionId: sessionId });
        this.stmtDeleteEventsBySession.run({ $sessionId: sessionId });
      }

      // Safety-net orphan check: by design, last_event_id only references same-session
      // events, so this check should always return 0 after correctly deleting both
      // checkpoints and events for the target sessions. It guards against future schema
      // changes that might introduce cross-session checkpoint references.
      if (eventIds.length > 0) {
        const placeholders = eventIds.map((_, i) => `$e${i}`).join(", ");
        const params: Record<string, string> = {};
        eventIds.forEach((id, i) => { params[`$e${i}`] = id; });
        const orphans = (this.db.prepare(
          `SELECT COUNT(*) as orphans FROM checkpoints WHERE last_event_id IN (${placeholders})`
        ).get(params) as { orphans: number }).orphans;
        if (orphans > 0) {
          throw new Error(`Session deletion created ${orphans} orphaned checkpoint references`);
        }
      }
    });
    deleteMany();
  }

  /**
   * Get events in a time range
   */
  async getByTimeRange(start: Date, end: Date): Promise<Event[]> {
    const rows = this.stmtGetEventsByTimeRange.all({
      $start: start.toISOString(),
      $end: end.toISOString(),
    }) as EventRow[];
    return rows.map((row) => this.rowToEvent(row));
  }

  // ========== Checkpoint Operations ==========

  /**
   * Create a checkpoint for a session
   */
  async createCheckpoint(
    sessionId: SessionId,
    memoryCount: number,
    description?: string,
    memoryKeys?: string[]
  ): Promise<Checkpoint> {
    // Fetch only the latest event ID — avoids loading the full event history into memory
    // (getBySession() has no LIMIT and would materialize every event for a long-lived session).
    const lastRow = this.stmtGetLastEventBySession.get({ $session_id: sessionId }) as { event_id: string } | undefined;
    if (!lastRow) {
      throw new Error(`No events found for session: ${sessionId}`);
    }

    const checkpoint: Checkpoint = {
      checkpointId: this.generateUUID(),
      sessionId,
      timestamp: new Date(),
      lastEventId: lastRow.event_id,
      memoryCount,
    };
    if (description !== undefined) {
      checkpoint.description = description;
    }

    // Insert checkpoint and items in a transaction
    const insertCheckpoint = this.db.transaction(() => {
      this.stmtInsertCheckpoint.run({
        $checkpoint_id: checkpoint.checkpointId,
        $session_id: checkpoint.sessionId,
        $timestamp: checkpoint.timestamp.toISOString(),
        $last_event_id: checkpoint.lastEventId,
        $memory_count: checkpoint.memoryCount,
        $description: description ?? null,
      });

      // Insert checkpoint items if provided
      if (memoryKeys && memoryKeys.length > 0) {
        for (const memoryKey of memoryKeys) {
          this.stmtInsertCheckpointItem.run(checkpoint.checkpointId, memoryKey);
        }
      }
    });
    insertCheckpoint();

    return checkpoint;
  }

  /**
   * Get checkpoint by ID
   */
  async getCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
    const row = this.stmtGetCheckpoint.get({ $checkpoint_id: checkpointId }) as
      | CheckpointRow
      | undefined;
    return row ? this.rowToCheckpoint(row) : null;
  }

  /**
   * Get all checkpoints for a session
   */
  async getCheckpointsBySession(sessionId: SessionId): Promise<Checkpoint[]> {
    const rows = this.stmtGetCheckpointsBySession.all({ $session_id: sessionId }) as CheckpointRow[];
    return rows.map((row) => this.rowToCheckpoint(row));
  }

  /**
   * Get memory keys associated with a checkpoint
   */
  async getCheckpointItems(checkpointId: string): Promise<string[]> {
    const rows = this.stmtGetCheckpointItems.all(checkpointId) as Array<{ memory_key: string }>;
    return rows.map((row) => row.memory_key);
  }

  // ========== Recent Events ==========

  /**
   * Get the most recent events across all sessions, ordered by timestamp DESC.
   */
  getRecentEvents(limit: number = 20): Event[] {
    // Clamp limit to prevent loading the entire events table into memory on a bad caller.
    const safeLimit = Math.min(Math.max(limit, 1), 1000);
    const rows = this.stmtGetRecentEvents.all({ $limit: safeLimit }) as EventRow[];
    return rows.map((row) => this.rowToEvent(row));
  }

  // ========== Utility Operations ==========

  /**
   * List all unique session IDs in the event store
   */
  async listSessions(): Promise<SessionId[]> {
    const rows = this.stmtListSessions.all() as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
  }

  /**
   * Test database connectivity
   */
  async ping(): Promise<boolean> {
    try {
      this.stmtPing.get();
      return true;
    } catch (error) {
      log.warn("ping failed", { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * Get database statistics
   */
  getStats(): { eventCount: number | null; checkpointCount: number | null; dbSize: number | null } {
    // Wrap count queries individually: a lock or transient corruption on one table
    // should not prevent reporting stats for the other table.
    let eventCount: number | null = null;
    try {
      eventCount = (this.stmtGetEventCount.get() as { count: number }).count;
    } catch (err) {
      log.warn("getStats: failed to read event count", { error: err instanceof Error ? err.message : String(err) });
    }
    let checkpointCount: number | null = null;
    try {
      checkpointCount = (this.stmtGetCheckpointCount.get() as { count: number }).count;
    } catch (err) {
      log.warn("getStats: failed to read checkpoint count", { error: err instanceof Error ? err.message : String(err) });
    }

    let dbSize: number | null = null;
    if (this.config.dbPath !== ":memory:") {
      try {
        const stats = fs.statSync(this.config.dbPath);
        dbSize = stats.size;
      } catch (err) {
        log.warn("getStats: failed to stat db file", { error: err instanceof Error ? err.message : String(err) });
      }
    } else {
      dbSize = 0;
    }

    return { eventCount, checkpointCount, dbSize };
  }

  /**
   * Get database path
   */
  getDbPath(): string {
    return this.config.dbPath;
  }

  /**
   * Get the underlying database instance
   */
  getDatabase(): Database {
    return this.db;
  }

  /**
   * Get WAL file size in bytes. Returns 0 for in-memory DBs or when WAL file absent.
   */
  getWalSizeBytes(): number {
    if (this.config.dbPath === ":memory:") {
      return 0;
    }
    try {
      return fs.statSync(`${this.config.dbPath}-wal`).size;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.warn("Cannot read WAL file", { path: `${this.config.dbPath}-wal`, code });
      }
      return 0;
    }
  }

  /**
   * Get ratio of free pages to total pages (fragmentation indicator).
   */
  getFreelistRatio(): number {
    const pageCountRow = this.stmtGetPageCount.get() as { page_count?: number } | undefined;
    const freelistRow = this.stmtGetFreelistCount.get() as { freelist_count?: number } | undefined;
    const pageCount = pageCountRow?.page_count ?? 0;
    const freelistCount = freelistRow?.freelist_count ?? 0;
    if (pageCount <= 0) {
      return 0;
    }
    return freelistCount / pageCount;
  }

  /**
   * Run PRAGMA quick_check; returns 1 if ok, 0 if corrupted.
   * Note: SQLite `PRAGMA quick_check` always returns exactly one row containing the
   * string "ok" for a healthy database. Any other value (or a missing row) means
   * corruption. This method uses `.get()` which returns only the first row, which is
   * always the only row for this PRAGMA — so no records are silently discarded.
   */
  getIntegrityOk(): number {
    const row = this.stmtQuickCheck.get() as { quick_check?: string } | undefined;
    return row?.quick_check === "ok" ? 1 : 0;
  }

  /**
   * Execute a WAL checkpoint. Mode: PASSIVE (default) never blocks writers.
   */
  walCheckpoint(mode: "PASSIVE" | "TRUNCATE" | "FULL" | "RESTART" = "PASSIVE"): void {
    // Runtime allowlist guards against injection if called outside TypeScript type system
    if (!VALID_WAL_MODES.has(mode)) {
      throw new Error(`Invalid WAL checkpoint mode: ${mode}`);
    }
    if (this.config.dbPath === ":memory:") {
      return; // no WAL for in-memory
    }

    // Use parameterized approach to prevent SQL injection even if type system is bypassed
    const PRAGMA_STATEMENTS = {
      "PASSIVE": "PRAGMA wal_checkpoint(PASSIVE)",
      "TRUNCATE": "PRAGMA wal_checkpoint(TRUNCATE)",
      "FULL": "PRAGMA wal_checkpoint(FULL)",
      "RESTART": "PRAGMA wal_checkpoint(RESTART)"
    } as const;

    this.db.exec(PRAGMA_STATEMENTS[mode]);
  }

  /**
   * Close database connection.
   *
   * Idempotent and safe to call concurrently: all callers receive the same
   * Promise so db.close() executes exactly once even if two async callers race.
   */
  async close(): Promise<void> {
    if (!this.closePromise) {
      // Assignment is synchronous — any concurrent caller that reaches here before
      // the microtask runs will find closePromise already set and return the same promise.
      this.closePromise = Promise.resolve().then(() => {
        this.db.close();
      }).catch((err: unknown) => {
        // Clear the stuck promise so a retry is possible after a failed close attempt.
        this.closePromise = undefined;
        throw err;
      });
    }
    return this.closePromise;
  }

  /**
   * Check if an agent is registered and not expired.
   */
  isAgentActive(agentId: string): boolean {
    const row = this.stmtIsAgentActive.get({ $agent_id: agentId, $now: new Date().toISOString() });
    return row !== null && row !== undefined;
  }

  /**
   * Prune events older than retentionDays.
   * OBSERVATION_CAPTURED events are pruned more aggressively (retentionDays / 4)
   * since they are high-frequency and low-value after a short window.
   * Returns the number of rows deleted.
   */
  pruneOldEvents(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const obsRetentionDays = Math.max(1, Math.floor(retentionDays / 4));
    const obsCutoff = new Date(Date.now() - obsRetentionDays * 86_400_000).toISOString();

    const r1 = this.db
      .prepare("DELETE FROM events WHERE event_type = 'OBSERVATION_CAPTURED' AND timestamp < ?")
      .run(obsCutoff);
    const r2 = this.db
      .prepare("DELETE FROM events WHERE event_type != 'OBSERVATION_CAPTURED' AND timestamp < ?")
      .run(cutoff);

    return (r1.changes ?? 0) + (r2.changes ?? 0);
  }

  /**
   * Clear all data (for testing only — in-memory databases only)
   */
  clear(): void {
    if (!this.isInMemory) {
      throw new Error("EventStore.clear() is only permitted on in-memory databases");
    }
    this.db.exec("DELETE FROM checkpoint_items");
    this.db.exec("DELETE FROM checkpoints");
    this.db.exec("DELETE FROM events");
    // Clear agent and lock tables to prevent test isolation leaks between test cases.
    this.db.exec("DELETE FROM agent_quotas");
    this.db.exec("DELETE FROM write_locks");
  }
}

/**
 * Create a new event store with default configuration
 */
export function createEventStore(config?: EventStoreConfig): EventStore {
  return new EventStore(config);
}

/**
 * Create an in-memory event store (for testing)
 */
export function createInMemoryEventStore(): EventStore {
  return new EventStore({ dbPath: ":memory:", walMode: false });
}
