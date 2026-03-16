/**
 * SessionRegistry — Multi-client session isolation for StreamableHTTP transport
 *
 * Each MCP client (Claude Code, Codex, Cursor, etc.) gets its own session
 * keyed by Mcp-Session-Id header. Sessions are isolated: one client's context
 * does not leak into another's.
 *
 * - Session creation: on initialize request without Mcp-Session-Id header
 * - Session routing: subsequent requests match by Mcp-Session-Id
 * - Session cleanup: DELETE request or TTL expiry (default 1 hour)
 * - Max concurrent sessions: configurable (default 20)
 *
 * @module mcp/SessionRegistry
 */

import * as crypto from "crypto";
import { createLogger } from "../util/logger.js";

const log = createLogger("SessionRegistry");

export type ClientName =
  | "claude-code"
  | "codex"
  | "cursor"
  | "opencode"
  | "antigravity"
  | "unknown";

export interface ClientSession {
  sessionId: string;
  clientName: ClientName;
  projectDir?: string;
  createdAt: string;
  lastActivityAt: string;
  metadata: Map<string, unknown>;
}

export interface SessionRegistryOptions {
  /** Maximum concurrent sessions (default: 20) */
  maxSessions?: number;
  /** Session TTL in milliseconds (default: 3600000 = 1 hour) */
  ttlMs?: number;
  /** Custom session ID generator */
  sessionIdGenerator?: () => string;
  /** Callback invoked when a session is evicted by TTL cleanup */
  onEvict?: (sessionId: string) => void;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, ClientSession>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly generateId: () => string;
  private readonly onEvict: ((sessionId: string) => void) | undefined;

  constructor(options: SessionRegistryOptions = {}) {
    this.maxSessions = options.maxSessions ?? 20;
    this.ttlMs = options.ttlMs ?? 3_600_000;
    this.generateId = options.sessionIdGenerator ?? (() => crypto.randomUUID());
    this.onEvict = options.onEvict;
  }

  /**
   * Create a new session. Returns the session or null if at capacity.
   * Runs cleanup before rejecting to evict expired sessions first.
   */
  create(clientName: ClientName = "unknown"): ClientSession | null {
    // Evict expired sessions before checking capacity
    this.cleanup();

    if (this.sessions.size >= this.maxSessions) {
      log.warn("Session limit reached", {
        max: this.maxSessions,
        active: this.sessions.size,
      });
      return null;
    }

    const now = new Date().toISOString();
    const session: ClientSession = {
      sessionId: this.generateId(),
      clientName,
      createdAt: now,
      lastActivityAt: now,
      metadata: new Map(),
    };

    this.sessions.set(session.sessionId, session);
    log.info("Session created", {
      sessionId: session.sessionId,
      client: clientName,
    });

    return session;
  }

  /**
   * Get a session by ID. Updates lastActivityAt on access.
   * Returns undefined if session not found or expired.
   */
  get(sessionId: string): ClientSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    // Check TTL
    const lastActivity = new Date(session.lastActivityAt).getTime();
    if (Date.now() - lastActivity > this.ttlMs) {
      this.onEvict?.(sessionId);
      this.sessions.delete(sessionId);
      log.info("Session expired on access", { sessionId });
      return undefined;
    }

    // Touch — update activity timestamp
    session.lastActivityAt = new Date().toISOString();
    return session;
  }

  /**
   * Remove a session explicitly (e.g., on DELETE request).
   * Returns true if the session existed and was removed.
   */
  remove(sessionId: string): boolean {
    const existed = this.sessions.delete(sessionId);
    if (existed) {
      log.info("Session removed", { sessionId });
    }
    return existed;
  }

  /**
   * Remove all expired sessions. Returns the number of sessions evicted.
   */
  cleanup(): number {
    const now = Date.now();
    let evicted = 0;

    for (const [sessionId, session] of this.sessions) {
      const lastActivity = new Date(session.lastActivityAt).getTime();
      if (now - lastActivity > this.ttlMs) {
        this.onEvict?.(sessionId);
        this.sessions.delete(sessionId);
        evicted++;
      }
    }

    if (evicted > 0) {
      log.info("Sessions cleaned up", { evicted, remaining: this.sessions.size });
    }

    return evicted;
  }

  /**
   * List all active (non-expired) sessions.
   */
  list(): ClientSession[] {
    this.cleanup();
    return Array.from(this.sessions.values());
  }

  /**
   * Get count of active sessions.
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Check if a session exists and is not expired.
   */
  has(sessionId: string): boolean {
    return this.get(sessionId) !== undefined;
  }

  /**
   * Set session-scoped metadata.
   */
  setMetadata(sessionId: string, key: string, value: unknown): boolean {
    const session = this.get(sessionId);
    if (!session) {
      return false;
    }
    session.metadata.set(key, value);
    return true;
  }

  /**
   * Get session-scoped metadata.
   */
  getMetadata(sessionId: string, key: string): unknown | undefined {
    const session = this.get(sessionId);
    if (!session) {
      return undefined;
    }
    return session.metadata.get(key);
  }

  /**
   * Detect client name from User-Agent or MCP client info.
   */
  static detectClient(userAgent?: string, clientInfo?: string): ClientName {
    const combined = `${userAgent ?? ""} ${clientInfo ?? ""}`.toLowerCase();
    if (combined.includes("claude") || combined.includes("anthropic")) {
      return "claude-code";
    }
    if (combined.includes("codex") || combined.includes("openai")) {
      return "codex";
    }
    if (combined.includes("cursor")) {
      return "cursor";
    }
    if (combined.includes("opencode")) {
      return "opencode";
    }
    if (combined.includes("antigravity")) {
      return "antigravity";
    }
    return "unknown";
  }
}
