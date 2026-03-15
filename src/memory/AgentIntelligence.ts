/**
 * AgentIntelligence — Agent identity persistence, cross-session continuity,
 * contradiction detection, and memory compression.
 *
 * Provides:
 * 1. Agent identity persistence — store agent name, role, capabilities, learnings
 * 2. Cross-session continuity — query what other agents did in prior sessions
 * 3. Contradiction detection — flag when a new memory contradicts an existing one
 * 4. Memory compression — summarize memories older than 30 days
 *
 * Uses bun:sqlite directly. Self-contained SQLite database.
 *
 * @module memory/AgentIntelligence
 * @version 1.0.0
 */

import { Database } from "bun:sqlite";
import { createLogger } from "../util/logger.js";

const log = createLogger("AgentIntelligence");

// ============================================================================
// Types
// ============================================================================

/** Stored agent identity record. */
export interface AgentIdentityRecord {
  agentId: string;
  role: string;
  capabilities: string[];
  learnings: string[];
  firstSeen: string;
  lastSeen: string;
  sessionCount: number;
}

/** A single entry in an agent's history log. */
export interface AgentHistoryEntry {
  agentId: string;
  sessionId: string;
  action: string;
  detail: string;
  timestamp: string;
}

/** Result of contradiction detection. */
export interface ContradictionResult {
  found: boolean;
  existingKey: string | null;
  existingValue: string | null;
  newValue: string | null;
}

/** Summary entry produced by memory compression. */
export interface CompressionSummary {
  category: string;
  entryCount: number;
  summary: string;
  compressedAt: string;
}

// ============================================================================
// DDL
// ============================================================================

const DDL = `
CREATE TABLE IF NOT EXISTS agent_identities (
  agent_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  learnings TEXT NOT NULL DEFAULT '[]',
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  session_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS agent_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agent_identities(agent_id)
);

CREATE INDEX IF NOT EXISTS idx_ah_agent_id ON agent_history(agent_id);
CREATE INDEX IF NOT EXISTS idx_ah_session_id ON agent_history(session_id);
CREATE INDEX IF NOT EXISTS idx_ah_timestamp ON agent_history(timestamp);

CREATE TABLE IF NOT EXISTS agent_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'note',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  compressed INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (agent_id) REFERENCES agent_identities(agent_id)
);

CREATE INDEX IF NOT EXISTS idx_am_agent_key ON agent_memories(agent_id, key);
CREATE INDEX IF NOT EXISTS idx_am_created ON agent_memories(created_at);
CREATE INDEX IF NOT EXISTS idx_am_compressed ON agent_memories(compressed);

CREATE TABLE IF NOT EXISTS compression_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  summary TEXT NOT NULL,
  compressed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// ============================================================================
// SQL Statements
// ============================================================================

const SQL_UPSERT_IDENTITY = `
INSERT INTO agent_identities (agent_id, role, capabilities, learnings, first_seen, last_seen, session_count)
VALUES ($agent_id, $role, $capabilities, $learnings, $now, $now, 1)
ON CONFLICT(agent_id) DO UPDATE SET
  role = $role,
  capabilities = $capabilities,
  learnings = $learnings,
  last_seen = $now,
  session_count = session_count + 1`;

const SQL_GET_IDENTITY = "SELECT * FROM agent_identities WHERE agent_id = $agent_id";

const SQL_LIST_IDENTITIES = "SELECT * FROM agent_identities ORDER BY last_seen DESC";

const SQL_INSERT_HISTORY = `
INSERT INTO agent_history (agent_id, session_id, action, detail, timestamp)
VALUES ($agent_id, $session_id, $action, $detail, $timestamp)`;

const SQL_GET_HISTORY = `
SELECT * FROM agent_history WHERE agent_id = $agent_id ORDER BY timestamp DESC LIMIT $limit`;

const SQL_GET_SESSION_HISTORY = `
SELECT * FROM agent_history WHERE session_id = $session_id ORDER BY timestamp ASC`;

const SQL_INSERT_MEMORY = `
INSERT INTO agent_memories (agent_id, key, value, category, created_at)
VALUES ($agent_id, $key, $value, $category, $created_at)`;

const SQL_FIND_BY_KEY = `
SELECT id, agent_id, key, value, category, created_at FROM agent_memories
WHERE agent_id = $agent_id AND key = $key AND compressed = 0
ORDER BY created_at DESC LIMIT 1`;

const SQL_OLD_UNCOMPRESSED = `
SELECT id, agent_id, key, value, category, created_at FROM agent_memories
WHERE compressed = 0 AND created_at < $cutoff
ORDER BY category, created_at`;

const SQL_MARK_COMPRESSED = "UPDATE agent_memories SET compressed = 1 WHERE id = $id";

const SQL_INSERT_COMPRESSION = `
INSERT INTO compression_log (category, entry_count, summary, compressed_at)
VALUES ($category, $entry_count, $summary, $compressed_at)`;

const SQL_GET_COMPRESSIONS = "SELECT * FROM compression_log ORDER BY compressed_at DESC LIMIT $limit";

// ============================================================================
// AgentIntelligence
// ============================================================================

/**
 * AgentIntelligence provides agent identity persistence, cross-session
 * continuity, contradiction detection, and memory compression.
 */
export class AgentIntelligence {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(DDL);
    log.info(`initialized db=${dbPath}`);
  }

  // --------------------------------------------------------------------------
  // 1. Agent Identity Persistence
  // --------------------------------------------------------------------------

  /**
   * Register or update an agent identity.
   * Increments session_count on subsequent calls.
   */
  registerAgent(
    agentId: string,
    role: string,
    capabilities: string[] = [],
    learnings: string[] = [],
  ): AgentIdentityRecord {
    const now = new Date().toISOString();
    this.db.prepare(SQL_UPSERT_IDENTITY).run({
      $agent_id: agentId,
      $role: role,
      $capabilities: JSON.stringify(capabilities),
      $learnings: JSON.stringify(learnings),
      $now: now,
    });

    const result = this.getAgent(agentId);
    if (!result) throw new Error(`Failed to register agent ${agentId}`);
    return result;
  }

  /**
   * Get an agent identity by ID.
   */
  getAgent(agentId: string): AgentIdentityRecord | null {
    const row = this.db.prepare(SQL_GET_IDENTITY).get({ $agent_id: agentId }) as {
      agent_id: string;
      role: string;
      capabilities: string;
      learnings: string;
      first_seen: string;
      last_seen: string;
      session_count: number;
    } | null;

    if (!row) return null;

    return {
      agentId: row.agent_id,
      role: row.role,
      capabilities: JSON.parse(row.capabilities) as string[],
      learnings: JSON.parse(row.learnings) as string[],
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      sessionCount: row.session_count,
    };
  }

  /**
   * List all registered agents, most recently seen first.
   */
  listAgents(): AgentIdentityRecord[] {
    const rows = this.db.prepare(SQL_LIST_IDENTITIES).all() as Array<{
      agent_id: string;
      role: string;
      capabilities: string;
      learnings: string;
      first_seen: string;
      last_seen: string;
      session_count: number;
    }>;

    return rows.map((row) => ({
      agentId: row.agent_id,
      role: row.role,
      capabilities: JSON.parse(row.capabilities) as string[],
      learnings: JSON.parse(row.learnings) as string[],
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      sessionCount: row.session_count,
    }));
  }

  // --------------------------------------------------------------------------
  // 2. Cross-Session Continuity
  // --------------------------------------------------------------------------

  /**
   * Record an action in the agent's history log.
   */
  recordAction(agentId: string, sessionId: string, action: string, detail: string = ""): void {
    const now = new Date().toISOString();
    this.db.prepare(SQL_INSERT_HISTORY).run({
      $agent_id: agentId,
      $session_id: sessionId,
      $action: action,
      $detail: detail,
      $timestamp: now,
    });
  }

  /**
   * Query what an agent did across all sessions.
   */
  getAgentHistory(agentId: string, limit: number = 50): AgentHistoryEntry[] {
    const rows = this.db.prepare(SQL_GET_HISTORY).all({
      $agent_id: agentId,
      $limit: limit,
    }) as Array<{
      agent_id: string;
      session_id: string;
      action: string;
      detail: string;
      timestamp: string;
    }>;

    return rows.map((row) => ({
      agentId: row.agent_id,
      sessionId: row.session_id,
      action: row.action,
      detail: row.detail,
      timestamp: row.timestamp,
    }));
  }

  /**
   * Query what happened in a specific session across all agents.
   */
  getSessionHistory(sessionId: string): AgentHistoryEntry[] {
    const rows = this.db.prepare(SQL_GET_SESSION_HISTORY).all({
      $session_id: sessionId,
    }) as Array<{
      agent_id: string;
      session_id: string;
      action: string;
      detail: string;
      timestamp: string;
    }>;

    return rows.map((row) => ({
      agentId: row.agent_id,
      sessionId: row.session_id,
      action: row.action,
      detail: row.detail,
      timestamp: row.timestamp,
    }));
  }

  // --------------------------------------------------------------------------
  // 3. Contradiction Detection
  // --------------------------------------------------------------------------

  /**
   * Save a memory and check for contradictions.
   *
   * Contradiction = same agent + same key but different value.
   * Returns the contradiction result (observational only, never blocks).
   */
  saveMemory(
    agentId: string,
    key: string,
    value: string,
    category: string = "note",
  ): ContradictionResult {
    const now = new Date().toISOString();

    // Check for existing memory with same key
    const existing = this.db.prepare(SQL_FIND_BY_KEY).get({
      $agent_id: agentId,
      $key: key,
    }) as { value: string } | null;

    const contradiction: ContradictionResult = {
      found: false,
      existingKey: null,
      existingValue: null,
      newValue: null,
    };

    if (existing && existing.value !== value) {
      contradiction.found = true;
      contradiction.existingKey = key;
      contradiction.existingValue = existing.value;
      contradiction.newValue = value;
      log.warn(`contradiction detected agent=${agentId} key=${key}`);
    }

    // Always save the new memory
    this.db.prepare(SQL_INSERT_MEMORY).run({
      $agent_id: agentId,
      $key: key,
      $value: value,
      $category: category,
      $created_at: now,
    });

    return contradiction;
  }

  // --------------------------------------------------------------------------
  // 4. Memory Compression
  // --------------------------------------------------------------------------

  /**
   * Compress memories older than `daysOld` days.
   *
   * Groups uncompressed memories by category, merges into summary entries,
   * marks originals as compressed.
   *
   * @param daysOld - Age threshold in days (default: 30).
   * @returns Array of compression summaries produced.
   */
  compressOldMemories(daysOld: number = 30): CompressionSummary[] {
    const cutoff = new Date(Date.now() - daysOld * 86_400_000).toISOString();

    const rows = this.db.prepare(SQL_OLD_UNCOMPRESSED).all({
      $cutoff: cutoff,
    }) as Array<{
      id: number;
      agent_id: string;
      key: string;
      value: string;
      category: string;
      created_at: string;
    }>;

    if (rows.length === 0) return [];

    // Group by category
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const existing = groups.get(row.category);
      if (existing) {
        existing.push(row);
      } else {
        groups.set(row.category, [row]);
      }
    }

    const summaries: CompressionSummary[] = [];
    const now = new Date().toISOString();

    for (const [category, entries] of groups) {
      // Build summary: concatenate key=value pairs
      const summaryParts = entries.map((e) => `${e.key}: ${e.value}`);
      const summaryText = `[${category}] ${entries.length} entries compressed: ${summaryParts.join("; ")}`;

      // Mark originals as compressed
      for (const entry of entries) {
        this.db.prepare(SQL_MARK_COMPRESSED).run({ $id: entry.id });
      }

      // Record compression
      this.db.prepare(SQL_INSERT_COMPRESSION).run({
        $category: category,
        $entry_count: entries.length,
        $summary: summaryText,
        $compressed_at: now,
      });

      summaries.push({
        category,
        entryCount: entries.length,
        summary: summaryText,
        compressedAt: now,
      });
    }

    log.info(`compression complete categories=${summaries.length} totalEntries=${rows.length}`);

    return summaries;
  }

  /**
   * Get compression log entries.
   */
  getCompressionLog(limit: number = 20): CompressionSummary[] {
    const rows = this.db.prepare(SQL_GET_COMPRESSIONS).all({
      $limit: limit,
    }) as Array<{
      category: string;
      entry_count: number;
      summary: string;
      compressed_at: string;
    }>;

    return rows.map((row) => ({
      category: row.category,
      entryCount: row.entry_count,
      summary: row.summary,
      compressedAt: row.compressed_at,
    }));
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
    log.info("closed agent-intelligence db");
  }
}
