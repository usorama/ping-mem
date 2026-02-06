/**
 * Memory Keeper Database Reader
 *
 * Reads data from memory-keeper SQLite database for migration to ping-mem.
 * Opens database in read-only mode to ensure no modifications.
 *
 * @module migration/MemoryKeeperReader
 * @version 1.0.0
 */

import { Database } from "bun:sqlite";

// ============================================================================
// Memory Keeper Schema Types
// ============================================================================

export interface MemoryKeeperSession {
  session_id: string;
  name: string;
  project_dir: string | null;
  default_channel: string | null;
  created_at: string;
  last_accessed: string;
  metadata: string; // JSON
}

export interface MemoryKeeperContextItem {
  id: number;
  session_id: string;
  key: string;
  value: string;
  category: string | null;
  priority: string | null;
  channel: string | null;
  private: number; // 0 or 1 (boolean)
  created_at: string;
  updated_at: string;
  metadata: string | null; // JSON
}

export interface MemoryKeeperCheckpoint {
  id: number;
  session_id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface MemoryKeeperCheckpointItem {
  checkpoint_id: number;
  context_item_id: number;
}

// ============================================================================
// Memory Keeper Reader
// ============================================================================

export class MemoryKeeperReader {
  private db: Database;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    // Open database
    this.db = new Database(dbPath);
    // Enable query-only mode to prevent accidental modifications
    this.db.exec("PRAGMA query_only = ON");
  }

  /**
   * Get all sessions from memory-keeper
   */
  getSessions(): MemoryKeeperSession[] {
    const stmt = this.db.prepare("SELECT * FROM sessions ORDER BY created_at ASC");
    return stmt.all() as MemoryKeeperSession[];
  }

  /**
   * Get all context items from memory-keeper
   */
  getContextItems(): MemoryKeeperContextItem[] {
    const stmt = this.db.prepare("SELECT * FROM context_items ORDER BY created_at ASC");
    return stmt.all() as MemoryKeeperContextItem[];
  }

  /**
   * Get context items for a specific session
   */
  getContextItemsBySession(sessionId: string): MemoryKeeperContextItem[] {
    const stmt = this.db.prepare(
      "SELECT * FROM context_items WHERE session_id = ? ORDER BY created_at ASC"
    );
    return stmt.all(sessionId) as MemoryKeeperContextItem[];
  }

  /**
   * Get all checkpoints from memory-keeper
   */
  getCheckpoints(): MemoryKeeperCheckpoint[] {
    const stmt = this.db.prepare("SELECT * FROM checkpoints ORDER BY created_at ASC");
    return stmt.all() as MemoryKeeperCheckpoint[];
  }

  /**
   * Get checkpoint items (associations between checkpoints and context items)
   */
  getCheckpointItems(): MemoryKeeperCheckpointItem[] {
    const stmt = this.db.prepare("SELECT * FROM checkpoint_items");
    return stmt.all() as MemoryKeeperCheckpointItem[];
  }

  /**
   * Get checkpoint items for a specific checkpoint
   */
  getCheckpointItemsByCheckpoint(checkpointId: number): MemoryKeeperCheckpointItem[] {
    const stmt = this.db.prepare(
      "SELECT * FROM checkpoint_items WHERE checkpoint_id = ?"
    );
    return stmt.all(checkpointId) as MemoryKeeperCheckpointItem[];
  }

  /**
   * Get context item by ID (for checkpoint association lookup)
   */
  getContextItemById(itemId: number): MemoryKeeperContextItem | null {
    const stmt = this.db.prepare("SELECT * FROM context_items WHERE id = ?");
    const result = stmt.get(itemId) as MemoryKeeperContextItem | undefined;
    return result ?? null;
  }

  /**
   * Get database statistics
   */
  getStats(): {
    totalSessions: number;
    totalContextItems: number;
    totalCheckpoints: number;
    totalCheckpointItems: number;
    categoryCounts: Record<string, number>;
    channelCounts: Record<string, number>;
  } {
    const sessions = this.getSessions();
    const items = this.getContextItems();
    const checkpoints = this.getCheckpoints();
    const checkpointItems = this.getCheckpointItems();

    // Count by category
    const categoryCounts: Record<string, number> = {};
    for (const item of items) {
      const category = item.category ?? "none";
      categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    }

    // Count by channel
    const channelCounts: Record<string, number> = {};
    for (const item of items) {
      const channel = item.channel ?? "none";
      channelCounts[channel] = (channelCounts[channel] ?? 0) + 1;
    }

    return {
      totalSessions: sessions.length,
      totalContextItems: items.length,
      totalCheckpoints: checkpoints.length,
      totalCheckpointItems: checkpointItems.length,
      categoryCounts,
      channelCounts,
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
