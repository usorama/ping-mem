/**
 * Tests for MemoryKeeperReader
 *
 * @module migration/__tests__/MemoryKeeperReader.test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { MemoryKeeperReader } from "../MemoryKeeperReader.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Create a temporary SQLite DB that mimics the memory-keeper schema,
 * seed it with test data, and return the file path.
 */
function createTestDb(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mk-reader-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  const db = new Database(dbPath);

  db.run(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      working_directory TEXT,
      default_channel TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      description TEXT,
      branch TEXT,
      parent_id TEXT
    )
  `);

  db.run(`
    CREATE TABLE context_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      category TEXT,
      priority TEXT,
      channel TEXT,
      is_private INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      sequence_number INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  db.run(`
    CREATE TABLE checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  db.run(`
    CREATE TABLE checkpoint_items (
      checkpoint_id INTEGER NOT NULL,
      context_item_id INTEGER NOT NULL,
      PRIMARY KEY (checkpoint_id, context_item_id)
    )
  `);

  // Seed test data — sessions
  const insertSession = db.prepare(
    "INSERT INTO sessions (id, name, working_directory, default_channel, created_at, updated_at, description, branch, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  insertSession.run("sess-1", "Session Alpha", "/projects/alpha", "main", "2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z", "First session", "main", null);
  insertSession.run("sess-2", "Session Beta", "/projects/beta", "dev", "2026-01-02T00:00:00Z", "2026-01-02T02:00:00Z", null, "feature", "sess-1");

  // Seed test data — context items
  const insertItem = db.prepare(
    "INSERT INTO context_items (id, session_id, key, value, category, priority, channel, is_private, created_at, updated_at, metadata, size, sequence_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  insertItem.run("ctx-1", "sess-1", "decision-1", "Use TypeScript", "decision", "high", "main", 0, "2026-01-01T00:10:00Z", "2026-01-01T00:10:00Z", '{"source":"manual"}', 14, 1);
  insertItem.run("ctx-2", "sess-1", "note-1", "Architecture review done", "note", "medium", "main", 0, "2026-01-01T00:20:00Z", "2026-01-01T00:20:00Z", null, 23, 2);
  insertItem.run("ctx-3", "sess-2", "todo-1", "Fix auth module", "task", "high", "dev", 1, "2026-01-02T00:10:00Z", "2026-01-02T00:10:00Z", null, 15, 1);

  // Seed test data — checkpoints
  const insertCheckpoint = db.prepare(
    "INSERT INTO checkpoints (id, session_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  insertCheckpoint.run(1, "sess-1", "milestone-1", "First milestone", "2026-01-01T01:00:00Z");

  // Seed test data — checkpoint items
  const insertCpItem = db.prepare(
    "INSERT INTO checkpoint_items (checkpoint_id, context_item_id) VALUES (?, ?)"
  );
  insertCpItem.run(1, 1);
  insertCpItem.run(1, 2);

  db.close();
  return dbPath;
}

describe("MemoryKeeperReader", () => {
  let dbPath: string;
  let reader: MemoryKeeperReader;

  beforeEach(() => {
    dbPath = createTestDb();
    reader = new MemoryKeeperReader(dbPath);
  });

  afterEach(() => {
    reader.close();
    // Clean up temp files
    try {
      fs.unlinkSync(dbPath);
      fs.rmdirSync(path.dirname(dbPath));
    } catch {
      // ignore cleanup errors
    }
  });

  describe("getSessions", () => {
    test("should return all sessions ordered by created_at ASC", () => {
      const sessions = reader.getSessions();
      expect(sessions.length).toBe(2);
      expect(sessions[0].id).toBe("sess-1");
      expect(sessions[0].name).toBe("Session Alpha");
      expect(sessions[1].id).toBe("sess-2");
      expect(sessions[1].name).toBe("Session Beta");
    });

    test("should include all session fields", () => {
      const sessions = reader.getSessions();
      const first = sessions[0];
      expect(first.working_directory).toBe("/projects/alpha");
      expect(first.default_channel).toBe("main");
      expect(first.description).toBe("First session");
      expect(first.branch).toBe("main");
      expect(first.parent_id).toBeNull();
    });
  });

  describe("getContextItemsBySession", () => {
    test("should return context items for a specific session", () => {
      const items = reader.getContextItemsBySession("sess-1");
      expect(items.length).toBe(2);
      expect(items[0].key).toBe("decision-1");
      expect(items[1].key).toBe("note-1");
    });

    test("should return empty array for session with no items", () => {
      const items = reader.getContextItemsBySession("nonexistent-session");
      expect(items.length).toBe(0);
    });

    test("should return only items for the specified session", () => {
      const items = reader.getContextItemsBySession("sess-2");
      expect(items.length).toBe(1);
      expect(items[0].key).toBe("todo-1");
      expect(items[0].is_private).toBe(1);
    });
  });

  describe("getStats", () => {
    test("should return correct aggregate statistics", () => {
      const stats = reader.getStats();
      expect(stats.totalSessions).toBe(2);
      expect(stats.totalContextItems).toBe(3);
      expect(stats.totalCheckpoints).toBe(1);
      expect(stats.totalCheckpointItems).toBe(2);
    });

    test("should count items by category", () => {
      const stats = reader.getStats();
      expect(stats.categoryCounts.decision).toBe(1);
      expect(stats.categoryCounts.note).toBe(1);
      expect(stats.categoryCounts.task).toBe(1);
    });

    test("should count items by channel", () => {
      const stats = reader.getStats();
      expect(stats.channelCounts.main).toBe(2);
      expect(stats.channelCounts.dev).toBe(1);
    });
  });

  describe("read-only enforcement", () => {
    test("should open database in query_only mode (prevents writes)", () => {
      // Attempt a write operation — should throw because PRAGMA query_only = ON
      expect(() => {
        const db = (reader as unknown as { db: Database }).db;
        db.run("INSERT INTO sessions (id, name, created_at, updated_at) VALUES ('bad', 'bad', '2026-01-01', '2026-01-01')");
      }).toThrow();
    });
  });

  describe("getContextItems (all)", () => {
    test("should return all context items across all sessions", () => {
      const items = reader.getContextItems();
      expect(items.length).toBe(3);
    });
  });

  describe("getCheckpoints", () => {
    test("should return all checkpoints", () => {
      const checkpoints = reader.getCheckpoints();
      expect(checkpoints.length).toBe(1);
      expect(checkpoints[0].name).toBe("milestone-1");
      expect(checkpoints[0].session_id).toBe("sess-1");
    });
  });

  describe("getCheckpointItemsByCheckpoint", () => {
    test("should return checkpoint items for a checkpoint", () => {
      const items = reader.getCheckpointItemsByCheckpoint(1);
      expect(items.length).toBe(2);
    });

    test("should return empty for non-existent checkpoint", () => {
      const items = reader.getCheckpointItemsByCheckpoint(999);
      expect(items.length).toBe(0);
    });
  });
});
