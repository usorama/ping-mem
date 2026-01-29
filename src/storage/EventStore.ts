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
  private config: {
    dbPath: string;
    walMode: boolean;
    foreignKeys: boolean;
    busyTimeout: number;
  };

  // Prepared statements
  private stmtInsertEvent: Statement;
  private stmtGetEventById: Statement;
  private stmtGetEventsBySession: Statement;
  private stmtGetEventsByTimeRange: Statement;
  private stmtInsertCheckpoint: Statement;
  private stmtGetCheckpoint: Statement;
  private stmtGetCheckpointsBySession: Statement;

  constructor(config?: EventStoreConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config } as typeof this.config;

    // Ensure directory exists (skip for in-memory)
    if (this.config.dbPath !== ":memory:") {
      const dbDir = path.dirname(this.config.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
    }

    // Open database
    this.db = new Database(this.config.dbPath);

    // Configure database
    if (this.config.walMode && this.config.dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL");
    }
    if (this.config.foreignKeys) {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
    this.db.exec(`PRAGMA busy_timeout = ${this.config.busyTimeout}`);

    // Initialize schema
    this.initializeSchema();

    // Prepare statements (bun:sqlite uses $name for parameters)
    this.stmtInsertEvent = this.db.prepare(`
      INSERT INTO events (
        event_id, timestamp, session_id, event_type,
        payload, caused_by, metadata
      ) VALUES (
        $event_id, $timestamp, $session_id, $event_type,
        $payload, $caused_by, $metadata
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
  }

  /**
   * Initialize database schema
   */
  private initializeSchema(): void {
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

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_events_session
        ON events(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp
        ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_type
        ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session
        ON checkpoints(session_id, timestamp);
    `);
  }

  /**
   * Generate UUID v7 (time-sortable)
   */
  private generateUUID(): string {
    const timestamp = Date.now();
    const timestampHex = timestamp.toString(16).padStart(12, "0");

    const randomBytes = crypto.randomBytes(10);
    const randomHex = randomBytes.toString("hex");

    // UUID v7 format: tttttttt-tttt-7xxx-yxxx-xxxxxxxxxxxx
    const uuid =
      timestampHex.slice(0, 8) +
      "-" +
      timestampHex.slice(8, 12) +
      "-7" +
      randomHex.slice(0, 3) +
      "-" +
      ((parseInt(randomHex.slice(3, 4), 16) & 0x3) | 0x8).toString(16) +
      randomHex.slice(4, 7) +
      "-" +
      randomHex.slice(7, 19);

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
    };
  }

  /**
   * Convert database row to event
   */
  private rowToEvent(row: EventRow): Event {
    const event: Event = {
      eventId: row.event_id,
      timestamp: new Date(row.timestamp),
      sessionId: row.session_id,
      eventType: row.event_type as EventType,
      payload: JSON.parse(row.payload),
      metadata: JSON.parse(row.metadata),
    };
    if (row.caused_by !== null) {
      event.causedBy = row.caused_by;
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
    this.stmtInsertEvent.run(row);
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
    insertMany();
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
    description?: string
  ): Promise<Checkpoint> {
    // Get latest event for this session
    const events = await this.getBySession(sessionId);
    if (events.length === 0) {
      throw new Error(`No events found for session: ${sessionId}`);
    }

    const lastEvent = events[events.length - 1];
    if (!lastEvent) {
      throw new Error(`No events found for session: ${sessionId}`);
    }

    const checkpoint: Checkpoint = {
      checkpointId: this.generateUUID(),
      sessionId,
      timestamp: new Date(),
      lastEventId: lastEvent.eventId,
      memoryCount,
    };
    if (description !== undefined) {
      checkpoint.description = description;
    }

    this.stmtInsertCheckpoint.run({
      $checkpoint_id: checkpoint.checkpointId,
      $session_id: checkpoint.sessionId,
      $timestamp: checkpoint.timestamp.toISOString(),
      $last_event_id: checkpoint.lastEventId,
      $memory_count: checkpoint.memoryCount,
      $description: description ?? null,
    });

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

  // ========== Utility Operations ==========

  /**
   * Test database connectivity
   */
  async ping(): Promise<boolean> {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get database statistics
   */
  getStats(): { eventCount: number; checkpointCount: number; dbSize: number } {
    const eventCount = (
      this.db.prepare("SELECT COUNT(*) as count FROM events").get() as { count: number }
    ).count;
    const checkpointCount = (
      this.db.prepare("SELECT COUNT(*) as count FROM checkpoints").get() as { count: number }
    ).count;

    let dbSize = 0;
    if (this.config.dbPath !== ":memory:") {
      const stats = fs.statSync(this.config.dbPath);
      dbSize = stats.size;
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
   * Close database connection
   */
  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * Clear all data (for testing only)
   */
  clear(): void {
    this.db.exec("DELETE FROM checkpoints");
    this.db.exec("DELETE FROM events");
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
