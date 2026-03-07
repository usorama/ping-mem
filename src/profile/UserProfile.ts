/**
 * User Profile System
 *
 * Stores user preferences and context for personalized memory operations.
 * Seeded from migrated memory-keeper data to preserve user context.
 *
 * @module profile/UserProfile
 * @version 1.0.0
 */

import { Database } from "bun:sqlite";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Types
// ============================================================================

export interface UserProfile {
  userId: string;
  name?: string;
  role?: string;
  activeProjects: string[];
  expertise: string[];
  currentFocus: string[];
  relevanceThreshold: number;
  autoCheckpointInterval: number;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

export interface UserProfileUpdate {
  name?: string;
  role?: string;
  activeProjects?: string[];
  expertise?: string[];
  currentFocus?: string[];
  relevanceThreshold?: number;
  autoCheckpointInterval?: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// User Profile Store
// ============================================================================

export class UserProfileStore {
  private db: Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(os.homedir(), ".ping-mem", "profiles.db");
    this.db = new Database(resolvedPath);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY,
        name TEXT,
        role TEXT,
        active_projects TEXT NOT NULL,
        expertise TEXT NOT NULL,
        current_focus TEXT NOT NULL,
        relevance_threshold REAL NOT NULL DEFAULT 0.5,
        auto_checkpoint_interval INTEGER NOT NULL DEFAULT 300000,
        updated_at TEXT NOT NULL,
        metadata TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_profiles_updated
        ON user_profiles(updated_at);
    `);
  }

  getProfile(userId: string): UserProfile | null {
    const stmt = this.db.prepare(
      "SELECT * FROM user_profiles WHERE user_id = ?"
    );
    const row = stmt.get(userId) as {
      user_id: string;
      name: string | null;
      role: string | null;
      active_projects: string;
      expertise: string;
      current_focus: string;
      relevance_threshold: number;
      auto_checkpoint_interval: number;
      updated_at: string;
      metadata: string;
    } | undefined;

    if (!row) {
      return null;
    }

    const profile: UserProfile = {
      userId: row.user_id,
      activeProjects: JSON.parse(row.active_projects) as string[],
      expertise: JSON.parse(row.expertise) as string[],
      currentFocus: JSON.parse(row.current_focus) as string[],
      relevanceThreshold: row.relevance_threshold,
      autoCheckpointInterval: row.auto_checkpoint_interval,
      updatedAt: new Date(row.updated_at),
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    };
    if (row.name !== null) {
      profile.name = row.name;
    }
    if (row.role !== null) {
      profile.role = row.role;
    }
    return profile;
  }

  updateProfile(userId: string, update: UserProfileUpdate): UserProfile {
    const existing = this.getProfile(userId);
    const now = new Date().toISOString();

    // Build profile with only defined optional fields
    const profile: UserProfile = {
      userId,
      activeProjects: update.activeProjects ?? existing?.activeProjects ?? [],
      expertise: update.expertise ?? existing?.expertise ?? [],
      currentFocus: update.currentFocus ?? existing?.currentFocus ?? [],
      relevanceThreshold: update.relevanceThreshold ?? existing?.relevanceThreshold ?? 0.5,
      autoCheckpointInterval: update.autoCheckpointInterval ?? existing?.autoCheckpointInterval ?? 300000,
      updatedAt: new Date(now),
      metadata: update.metadata ?? existing?.metadata ?? {},
    };

    // Add optional fields only if they're defined
    const name = update.name ?? existing?.name;
    if (name !== undefined) {
      profile.name = name;
    }

    const role = update.role ?? existing?.role;
    if (role !== undefined) {
      profile.role = role;
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO user_profiles (
        user_id, name, role, active_projects, expertise, current_focus,
        relevance_threshold, auto_checkpoint_interval, updated_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      profile.userId,
      profile.name ?? null,
      profile.role ?? null,
      JSON.stringify(profile.activeProjects),
      JSON.stringify(profile.expertise),
      JSON.stringify(profile.currentFocus),
      profile.relevanceThreshold,
      profile.autoCheckpointInterval,
      now,
      JSON.stringify(profile.metadata)
    );

    return profile;
  }

  seedFromMigrationData(userId: string, analysis: {
    projects: string[];
    keywords: string[];
    topChannels: string[];
  }): UserProfile {
    return this.updateProfile(userId, {
      activeProjects: analysis.projects,
      expertise: analysis.keywords,
      currentFocus: analysis.topChannels,
    });
  }

  close(): void {
    this.db.close();
  }
}
