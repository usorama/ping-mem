/**
 * Session Manager for ping-mem
 *
 * Handles session lifecycle, context loading, and session state persistence.
 * Integrates with Event Store for audit trails and replay capability.
 *
 * @module session/SessionManager
 * @version 1.0.0
 */

import { EventStore, createInMemoryEventStore } from "../storage/EventStore.js";
import type {
  Session,
  SessionId,
  SessionStatus,
  SessionConfig,
  SessionEventData,
  SessionStats,
  SessionNotFoundError,
  InvalidSessionStateError,
  ContextLoadOptions,
  ContextLoadResult,
  Memory,
  MemoryCategory,
} from "../types/index.js";
import * as crypto from "crypto";
import { createLogger } from "../util/logger.js";

const log = createLogger("SessionManager");

// ============================================================================
// Session Manager Configuration
// ============================================================================

/**
 * Configuration for SessionManager
 */
export interface SessionManagerConfig {
  /** Event store instance (defaults to in-memory) */
  eventStore?: EventStore;
  /** Maximum active sessions */
  maxActiveSessions?: number;
  /** Auto-checkpoint interval (ms), 0 to disable */
  autoCheckpointInterval?: number;
  /** Session TTL in milliseconds. Sessions inactive beyond this are auto-ended.
   *  Default: 3600000 (1 hour). Set to 0 to disable. */
  sessionTtlMs?: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<Omit<SessionManagerConfig, "eventStore">> = {
  maxActiveSessions: 50,
  autoCheckpointInterval: 300000, // 5 minutes
  sessionTtlMs: 3_600_000, // 1 hour
};

const REAPER_INTERVAL_MS = 120_000;

// ============================================================================
// Session Manager Implementation
// ============================================================================

/**
 * Manages session lifecycle and state
 */
export class SessionManager {
  private eventStore: EventStore;
  private config: Required<Omit<SessionManagerConfig, "eventStore">>;
  private sessions: Map<SessionId, Session>;
  private activeSessionId: SessionId | null;
  private checkpointTimers: Map<SessionId, NodeJS.Timeout>;
  /** Promise-chain mutex to serialize startSession and prevent TOCTOU races on max-sessions check */
  private sessionMutex: Promise<void>;
  private reaperTimer: NodeJS.Timeout | null;

  constructor(config?: SessionManagerConfig) {
    this.eventStore = config?.eventStore ?? createInMemoryEventStore();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessions = new Map();
    this.activeSessionId = null;
    this.checkpointTimers = new Map();
    this.sessionMutex = Promise.resolve();
    this.reaperTimer = this.config.sessionTtlMs > 0
      ? setInterval(() => {
          this.cleanup().catch((err) => {
            log.warn("Session reaper cleanup failed", { error: String(err) });
          });
        }, REAPER_INTERVAL_MS)
      : null;
    // Allow Node to exit without waiting for the reaper
    this.reaperTimer?.unref?.();
  }

  /**
   * Hydrate sessions from event store
   * Rebuilds in-memory session state from persisted events
   */
  async hydrate(): Promise<void> {
    // Clear existing in-memory state before rebuilding
    this.sessions.clear();

    // Get all session IDs (bounded by EventStore's LIMIT 10000)
    const sessionIds = await this.eventStore.listSessions();
    let restoredCount = 0;
    let skippedEndedCount = 0;
    let skippedInvalidCount = 0;

    for (const sessionId of sessionIds) {
      const events = await this.eventStore.getBySession(sessionId);
      const startEvent = events.find((e) => e.eventType === "SESSION_STARTED");

      if (!startEvent) {
        log.warn("Session has events but no SESSION_STARTED event — skipping hydration", {
          sessionId,
          eventCount: events.length,
        });
        skippedInvalidCount++;
        continue;
      }

      // Skip ended sessions — they cannot be resumed and loading them wastes memory.
      const endEvent = events.find((e) => e.eventType === "SESSION_ENDED");
      if (endEvent) {
        skippedEndedCount++;
        continue;
      }

      const rawPayload = startEvent.payload;
      if (!rawPayload || typeof rawPayload !== "object" || !("name" in rawPayload)) {
        log.warn("Session START event has invalid payload — skipping hydration", {
          sessionId,
          payloadType: typeof rawPayload,
        });
        skippedInvalidCount++;
        continue;
      }
      const payload = rawPayload as SessionEventData;
      const config = payload.config;

      const session: Session = {
        id: sessionId,
        name: payload.name ?? "unknown",
        status: "active",
        startedAt: new Date(startEvent.timestamp),
        lastActivityAt: new Date(startEvent.timestamp),
        memoryCount: 0,
        eventCount: events.length,
        metadata: config?.metadata ?? {},
      };

      if (config?.projectDir !== undefined) {
        session.projectDir = config.projectDir;
      }
      if (config?.defaultChannel !== undefined) {
        session.defaultChannel = config.defaultChannel;
      }
      if (config?.continueFrom !== undefined) {
        session.parentSessionId = config.continueFrom;
      }

      // Restore pause state (last PAUSED/RESUMED event wins)
      const lastPauseEvent = events
        .filter((e) => e.eventType === "SESSION_PAUSED" || e.eventType === "SESSION_RESUMED")
        .at(-1);
      if (lastPauseEvent?.eventType === "SESSION_PAUSED") {
        session.status = "paused";
      }

      // Update lastActivityAt from the most recent event
      const lastEvent = events.at(-1);
      if (lastEvent) {
        session.lastActivityAt = new Date(lastEvent.timestamp);
      }

      this.sessions.set(sessionId, session);

      // Restore auto-checkpoint timers for active sessions (startSession() sets these up,
      // but hydrate() must do it too or restored sessions lose their checkpoint safety net)
      if (session.status === "active" && this.config.autoCheckpointInterval > 0) {
        this.setupAutoCheckpoint(sessionId);
      }

      restoredCount++;
    }

    log.info("Session hydration complete", {
      restored: restoredCount,
      skippedEnded: skippedEndedCount,
      skippedInvalid: skippedInvalidCount,
      totalScanned: sessionIds.length,
    });
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
   * Evict sessions that have been inactive beyond the TTL.
   * Called automatically before max-sessions check in startSession().
   * @returns Number of sessions evicted
   */
  async cleanup(): Promise<number> {
    if (this.config.sessionTtlMs <= 0) return 0;

    const now = Date.now();
    let evicted = 0;

    for (const [sessionId, session] of this.sessions) {
      if (session.status !== "active") continue;
      const lastActivity = session.lastActivityAt.getTime();
      if (now - lastActivity > this.config.sessionTtlMs) {
        try {
          await this.endSession(sessionId);
          evicted++;
        } catch (err) {
          log.warn("Failed to evict stale session, force-removing", { sessionId, error: String(err) });
          this.sessions.delete(sessionId);
          this.clearAutoCheckpoint(sessionId);
          evicted++;
        }
      }
    }

    if (evicted > 0) {
      log.info("Stale sessions evicted", { evicted });
    }
    return evicted;
  }

  /**
   * Start a new session
   *
   * Uses a promise-chain mutex to serialize the max-sessions check and
   * session insertion, preventing TOCTOU race conditions when multiple
   * callers invoke startSession concurrently.
   */
  async startSession(config: SessionConfig): Promise<Session> {
    // Chain onto the mutex so that the check-and-create is atomic
    const resultPromise = this.sessionMutex.then(async () => {
      // Evict expired sessions before checking capacity
      await this.cleanup();

      // Check max sessions limit (now serialized)
      const activeSessions = Array.from(this.sessions.values()).filter(
        (s) => s.status === "active"
      );
      if (activeSessions.length >= this.config.maxActiveSessions) {
        throw new Error(`Maximum active sessions (${this.config.maxActiveSessions}) reached`);
      }

      const sessionId = this.generateUUID();
      const now = new Date();

    // Merge agentId into metadata when provided (no mutable global state)
    const metadata: Record<string, unknown> = config.metadata ? { ...config.metadata } : {};
    if (config.agentId !== undefined) {
      metadata.agentId = config.agentId;
    }

    const session: Session = {
      id: sessionId,
      name: config.name,
      status: "active",
      startedAt: now,
      memoryCount: 0,
      eventCount: 0,
      lastActivityAt: now,
      metadata,
    };
    if (config.projectDir !== undefined) {
      session.projectDir = config.projectDir;
    }
    if (config.continueFrom !== undefined) {
      session.parentSessionId = config.continueFrom;
    }
    if (config.defaultChannel !== undefined) {
      session.defaultChannel = config.defaultChannel;
    }

      // Store session (inside the mutex, so max-sessions check is consistent)
      this.sessions.set(sessionId, session);
      this.activeSessionId = sessionId;

      // Create SESSION_STARTED event
      const eventData: SessionEventData = {
        sessionId,
        name: config.name,
        config,
        reason: config.continueFrom ? "continued" : "new",
      };

      await this.eventStore.createEvent(sessionId, "SESSION_STARTED", eventData, {
        projectDir: config.projectDir,
        continueFrom: config.continueFrom,
      });

      // Auto-load context if requested
      if (config.autoLoadContext && config.continueFrom) {
        await this.loadContextFrom(sessionId, config.continueFrom);
      }

      // Setup auto-checkpoint if enabled
      if (this.config.autoCheckpointInterval > 0) {
        this.setupAutoCheckpoint(sessionId);
      }

      return session;
    });

    // Update mutex: always resolve (even if the above threw) so the chain
    // doesn't permanently block subsequent calls.
    this.sessionMutex = resultPromise.then(
      () => {},
      () => {}
    );

    return resultPromise;
  }

  /**
   * End a session
   */
  async endSession(sessionId: SessionId, reason?: string): Promise<Session> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.status !== "active") {
      throw new Error(`Cannot end session in state: ${session.status}`);
    }

    // Update session state
    session.status = "ended";
    session.endedAt = new Date();

    // Create SESSION_ENDED event
    const eventData: SessionEventData = {
      sessionId,
      name: session.name,
    };
    if (reason !== undefined) {
      eventData.reason = reason;
    }

    await this.eventStore.createEvent(sessionId, "SESSION_ENDED", eventData, {
      memoryCount: session.memoryCount,
      duration: session.endedAt.getTime() - session.startedAt.getTime(),
    });

    // Create final checkpoint
    await this.eventStore.createCheckpoint(sessionId, session.memoryCount, "Session ended");

    // Clear auto-checkpoint timer
    this.clearAutoCheckpoint(sessionId);

    // Clear active session if this was it
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }

    return session;
  }

  /**
   * Pause a session
   */
  async pauseSession(sessionId: SessionId): Promise<Session> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.status !== "active") {
      throw new Error(`Cannot pause session in state: ${session.status}`);
    }

    session.status = "paused";

    const eventData: SessionEventData = {
      sessionId,
      name: session.name,
      reason: "paused",
    };

    await this.eventStore.createEvent(sessionId, "SESSION_PAUSED", eventData);

    // Clear auto-checkpoint timer
    this.clearAutoCheckpoint(sessionId);

    return session;
  }

  /**
   * Resume a paused session
   */
  async resumeSession(sessionId: SessionId): Promise<Session> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.status !== "paused") {
      throw new Error(`Cannot resume session in state: ${session.status}`);
    }

    session.status = "active";
    session.lastActivityAt = new Date();
    this.activeSessionId = sessionId;

    const eventData: SessionEventData = {
      sessionId,
      name: session.name,
      reason: "resumed",
    };

    await this.eventStore.createEvent(sessionId, "SESSION_RESUMED", eventData);

    // Re-setup auto-checkpoint
    if (this.config.autoCheckpointInterval > 0) {
      this.setupAutoCheckpoint(sessionId);
    }

    return session;
  }

  /**
   * Continue from a previous session
   */
  async continueSession(sessionId: SessionId, newName: string): Promise<Session> {
    const parentSession = this.sessions.get(sessionId);
    if (!parentSession) {
      throw new Error(`Parent session not found: ${sessionId}`);
    }

    // Create new session with parent reference
    const config: SessionConfig = {
      name: newName,
      continueFrom: sessionId,
      autoLoadContext: true,
      metadata: { ...parentSession.metadata, continuedFrom: sessionId },
    };
    if (parentSession.projectDir !== undefined) {
      config.projectDir = parentSession.projectDir;
    }
    if (parentSession.defaultChannel !== undefined) {
      config.defaultChannel = parentSession.defaultChannel;
    }

    const newSession = await this.startSession(config);

    return newSession;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: SessionId): Session | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Get active session
   */
  getActiveSession(): Session | null {
    return this.activeSessionId ? this.sessions.get(this.activeSessionId) ?? null : null;
  }

  /**
   * List all sessions
   */
  listSessions(filter?: { status?: SessionStatus; projectDir?: string }): Session[] {
    let sessions = Array.from(this.sessions.values());

    if (filter?.status) {
      sessions = sessions.filter((s) => s.status === filter.status);
    }

    if (filter?.projectDir) {
      sessions = sessions.filter((s) => s.projectDir === filter.projectDir);
    }

    return sessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }

  /**
   * Update session activity timestamp
   */
  async updateActivity(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = new Date();
    }
  }

  /**
   * Increment memory count for session
   */
  async incrementMemoryCount(sessionId: SessionId, delta: number = 1): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.memoryCount += delta;
      await this.updateActivity(sessionId);
    }
  }

  /**
   * Load context from a previous session
   */
  private async loadContextFrom(
    targetSessionId: SessionId,
    sourceSessionId: SessionId,
    options?: ContextLoadOptions
  ): Promise<ContextLoadResult> {
    const startTime = Date.now();

    // Get events from source session to find memory operations
    const events = await this.eventStore.getBySession(sourceSessionId);

    // Filter for memory events
    const memoryEvents = events.filter((e) => e.eventType === "MEMORY_SAVED");

    // Create CONTEXT_LOADED event
    await this.eventStore.createEvent(targetSessionId, "CONTEXT_LOADED", {
      sessionId: targetSessionId,
      name: this.sessions.get(targetSessionId)?.name ?? "unknown",
      reason: "auto-load",
    }, {
      sourceSessionId,
      memoriesLoaded: memoryEvents.length,
    });

    return {
      memories: [], // Placeholder - will be populated by MemoryManager
      count: memoryEvents.length,
      sourceSessions: [sourceSessionId],
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Get session statistics
   */
  async getSessionStats(sessionId: SessionId): Promise<SessionStats | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    const events = await this.eventStore.getBySession(sessionId);
    const memoryEvents = events.filter((e) =>
      ["MEMORY_SAVED", "MEMORY_UPDATED", "MEMORY_DELETED"].includes(e.eventType)
    );

    // Calculate stats
    const stats: SessionStats = {
      sessionId,
      totalMemories: session.memoryCount,
      memoriesByCategory: {} as Record<MemoryCategory, number>,
      memoriesByPriority: { high: 0, normal: 0, low: 0 },
      totalEvents: events.length,
      durationMs: session.endedAt
        ? session.endedAt.getTime() - session.startedAt.getTime()
        : Date.now() - session.startedAt.getTime(),
      avgMemorySize: 0,
    };

    return stats;
  }

  /**
   * Setup automatic checkpointing
   */
  private setupAutoCheckpoint(sessionId: SessionId): void {
    const timer = setInterval(async () => {
      const session = this.sessions.get(sessionId);
      if (session && session.status === "active") {
        try {
          await this.eventStore.createCheckpoint(
            sessionId,
            session.memoryCount,
            "Auto-checkpoint"
          );
        } catch (error) {
          // Ignore errors in auto-checkpoint
          log.error("Auto-checkpoint failed", { sessionId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }, this.config.autoCheckpointInterval);

    timer.unref();
    this.checkpointTimers.set(sessionId, timer);
  }

  /**
   * Clear automatic checkpointing
   */
  private clearAutoCheckpoint(sessionId: SessionId): void {
    const timer = this.checkpointTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.checkpointTimers.delete(sessionId);
    }
  }

  /**
   * Cleanup resources.
   * Does NOT close the EventStore — the caller that created it owns its lifecycle.
   * SessionManager receives EventStore via constructor injection, so closing it here
   * would violate the ownership contract when the store is shared (e.g., between
   * PingMemServer and RESTPingMemServer).
   */
  async close(): Promise<void> {
    for (const timer of this.checkpointTimers.values()) {
      clearInterval(timer);
    }
    this.checkpointTimers.clear();
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    // Does NOT close EventStore — caller that created it owns its lifecycle.
  }

  /**
   * Get event store instance (for testing)
   */
  getEventStore(): EventStore {
    return this.eventStore;
  }
}

/**
 * Create a new session manager
 */
export function createSessionManager(config?: SessionManagerConfig): SessionManager {
  return new SessionManager(config);
}
