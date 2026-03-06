/**
 * Memory Manager for ping-mem
 *
 * Provides core memory operations: save, get, recall, update, delete.
 * Integrates with EventStore for audit trails and VectorIndex for semantic search.
 *
 * @module memory/MemoryManager
 * @version 1.0.0
 */

import { EventStore, createInMemoryEventStore } from "../storage/EventStore.js";
import { VectorIndex } from "../search/VectorIndex.js";
import type { WriteLockManager } from "../storage/WriteLockManager.js";
import type {
  Memory,
  MemoryId,
  MemoryCategory,
  MemoryPriority,
  MemoryPrivacy,
  MemoryQuery,
  MemoryQueryResult,
  MemoryEventData,
  SessionId,
  PingMemError,
  MemoryNotFoundError,
  AgentId,
  AgentMemoryScope,
} from "../types/index.js";
import { QuotaExhaustedError } from "../types/agent-errors.js";
import type { RelevanceEngine } from "./RelevanceEngine.js";
import type { MemoryPubSub } from "../pubsub/index.js";
import * as crypto from "crypto";

// ============================================================================
// Memory Manager Configuration
// ============================================================================

/**
 * Configuration for MemoryManager
 */
export interface MemoryManagerConfig {
  /** Event store instance (defaults to in-memory) */
  eventStore?: EventStore;
  /** Vector index instance for semantic search (optional) */
  vectorIndex?: VectorIndex;
  /** Current session ID (required) */
  sessionId: SessionId;
  /** Default channel for memories */
  defaultChannel?: string;
  /** Default priority for new memories */
  defaultPriority?: MemoryPriority;
  /** Default privacy scope */
  defaultPrivacy?: MemoryPrivacy;
  /** Optional relevance engine for automatic tracking (auto-calls ensureTracking/trackAccess) */
  relevanceEngine?: RelevanceEngine;
  /** Agent identity for multi-agent scoping (optional — omit for legacy/unscoped usage) */
  agentId?: AgentId;
  /** Agent role for role-scoped memory visibility (optional) */
  agentRole?: string;
  /** Write lock manager for multi-agent concurrency control (optional) */
  writeLockManager?: WriteLockManager;
  /** PubSub bus for broadcasting memory change events (optional) */
  pubsub?: MemoryPubSub;
}

/**
 * Options for saving a memory
 */
export interface SaveMemoryOptions {
  /** Memory category */
  category?: MemoryCategory;
  /** Priority level */
  priority?: MemoryPriority;
  /** Privacy scope */
  privacy?: MemoryPrivacy;
  /** Channel for organization */
  channel?: string;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** Pre-computed embedding vector for semantic search */
  embedding?: Float32Array;
  /** Custom createdAt timestamp (for migration, defaults to now) */
  createdAt?: Date;
  /** Custom updatedAt timestamp (for migration, defaults to now) */
  updatedAt?: Date;
  /** Agent identity for multi-agent ownership (overrides config agentId) */
  agentId?: AgentId;
  /** Visibility scope for multi-agent access control (defaults to "public") */
  agentScope?: AgentMemoryScope;
}

/**
 * Options for updating a memory
 */
export interface UpdateMemoryOptions {
  /** New value */
  value?: string;
  /** New category */
  category?: MemoryCategory;
  /** New priority */
  priority?: MemoryPriority;
  /** New channel */
  channel?: string;
  /** Metadata to merge */
  metadata?: Record<string, unknown>;
  /** Updated embedding vector */
  embedding?: Float32Array;
}

// ============================================================================
// Custom Error Classes
// ============================================================================

export class MemoryManagerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "MemoryManagerError";
  }
}

export class MemoryKeyExistsError extends MemoryManagerError {
  constructor(key: string) {
    super(`Memory with key already exists: ${key}`, "MEMORY_EXISTS", { key });
    this.name = "MemoryKeyExistsError";
  }
}

export class MemoryKeyNotFoundError extends MemoryManagerError {
  constructor(key: string) {
    super(`Memory not found: ${key}`, "MEMORY_NOT_FOUND", { key });
    this.name = "MemoryKeyNotFoundError";
  }
}

export class InvalidSessionError extends MemoryManagerError {
  constructor(sessionId: SessionId) {
    super(`Invalid or missing session: ${sessionId}`, "INVALID_SESSION", { sessionId });
    this.name = "InvalidSessionError";
  }
}

// ============================================================================
// Memory Manager Implementation
// ============================================================================

/**
 * Manages memory operations with event sourcing and optional semantic search
 */
export class MemoryManager {
  private eventStore: EventStore;
  private vectorIndex: VectorIndex | null;
  private sessionId: SessionId;
  private defaultChannel: string | undefined;
  private defaultPriority: MemoryPriority;
  private defaultPrivacy: MemoryPrivacy;

  // In-memory cache of memories by key
  private memories: Map<string, Memory>;
  // Index by ID for fast lookups
  private memoriesById: Map<MemoryId, Memory>;
  private relevanceEngine: RelevanceEngine | null;

  // Multi-agent fields
  private agentId: AgentId | undefined;
  private agentRole: string | undefined;
  private writeLockManager: WriteLockManager | undefined;
  private pubsub: MemoryPubSub | undefined;

  constructor(config: MemoryManagerConfig) {
    if (!config.sessionId) {
      throw new InvalidSessionError("undefined");
    }

    this.eventStore = config.eventStore ?? createInMemoryEventStore();
    this.vectorIndex = config.vectorIndex ?? null;
    this.sessionId = config.sessionId;
    this.defaultChannel = config.defaultChannel;
    this.defaultPriority = config.defaultPriority ?? "normal";
    this.defaultPrivacy = config.defaultPrivacy ?? "session";
    this.memories = new Map();
    this.memoriesById = new Map();
    this.relevanceEngine = config.relevanceEngine ?? null;
    this.agentId = config.agentId;
    this.agentRole = config.agentRole;
    this.writeLockManager = config.writeLockManager;
    this.pubsub = config.pubsub;
  }

  // ========== Multi-Agent Scope Helpers ==========

  /**
   * Check whether the current agent (identified by this.agentId and this.agentRole)
   * is allowed to read a memory based on its agentScope.
   *
   * Scope rules:
   * - "public" or undefined (no scope): visible to everyone (backward compat)
   * - "shared": visible to all registered agents (requires this.agentId to be set, or legacy = pass)
   * - "role": visible to agents with the same role as the memory owner
   * - "private": visible only to the owning agentId
   */
  private isVisibleToCurrentAgent(memory: Memory): boolean {
    const scope = memory.agentScope;

    // No scope or "public" — visible to everyone (backward compat)
    if (!scope || scope === "public") {
      return true;
    }

    // If the current manager has no agentId (legacy usage), only see public/unscoped
    if (!this.agentId) {
      return false;
    }

    // Owner always sees their own memories regardless of scope
    if (memory.agentId === this.agentId) {
      return true;
    }

    switch (scope) {
      case "shared":
        // All registered agents can see shared memories (agentId is set = registered)
        return true;

      case "role": {
        // Visible to agents with the same role. The memory's owner role is
        // stored in metadata (set during save) or looked up from agent_quotas.
        const memoryOwnerRole = memory.metadata?.agentRole as string | undefined;
        return !!this.agentRole && !!memoryOwnerRole && this.agentRole === memoryOwnerRole;
      }

      case "private":
        // Only the owning agent (already checked above)
        return false;

      default:
        return false;
    }
  }

  /**
   * Hydrate in-memory state from event store
   * Replays MEMORY_SAVED, MEMORY_UPDATED, MEMORY_DELETED events to rebuild memory cache
   * This MUST be called after construction to restore state from persistent storage
   */
  async hydrate(): Promise<void> {
    // Clear existing in-memory state
    this.memories.clear();
    this.memoriesById.clear();

    // Get all events for this session
    const events = await this.eventStore.getBySession(this.sessionId);

    // Replay events in chronological order
    for (const event of events) {
      const payload = event.payload as MemoryEventData;

      switch (event.eventType) {
        case "MEMORY_SAVED": {
          // Reconstruct memory from MEMORY_SAVED event
          if (payload.memory) {
            const memory: Memory = {
              id: payload.memoryId,
              key: payload.key,
              value: payload.memory.value ?? "",
              sessionId: payload.sessionId,
              priority: payload.memory.priority ?? "normal",
              privacy: payload.memory.privacy ?? "session",
              createdAt: payload.memory.createdAt
                ? new Date(payload.memory.createdAt)
                : new Date(event.timestamp),
              updatedAt: payload.memory.updatedAt
                ? new Date(payload.memory.updatedAt)
                : new Date(event.timestamp),
              metadata: payload.memory.metadata ?? {},
            };

            // Set optional properties
            if (payload.memory.category !== undefined) {
              memory.category = payload.memory.category;
            }
            if (payload.memory.channel !== undefined) {
              memory.channel = payload.memory.channel;
            }
            if (payload.memory.embedding !== undefined) {
              memory.embedding = payload.memory.embedding;
            }
            if (payload.memory.agentId !== undefined) {
              memory.agentId = payload.memory.agentId;
            }
            if (payload.memory.agentScope !== undefined) {
              memory.agentScope = payload.memory.agentScope;
            }

            // Store in cache
            this.memories.set(memory.key, memory);
            this.memoriesById.set(memory.id, memory);
          }
          break;
        }

        case "MEMORY_UPDATED": {
          // Update memory if it exists
          const memory = this.memoriesById.get(payload.memoryId);
          if (memory && payload.memory) {
            // Apply updates from event
            if (payload.memory.value !== undefined) {
              memory.value = payload.memory.value;
            }
            if (payload.memory.category !== undefined) {
              memory.category = payload.memory.category;
            }
            if (payload.memory.priority !== undefined) {
              memory.priority = payload.memory.priority;
            }
            if (payload.memory.channel !== undefined) {
              memory.channel = payload.memory.channel;
            }
            if (payload.memory.metadata !== undefined) {
              memory.metadata = { ...memory.metadata, ...payload.memory.metadata };
            }
            if (payload.memory.updatedAt !== undefined) {
              memory.updatedAt = new Date(payload.memory.updatedAt);
            }
            if (payload.memory.embedding !== undefined) {
              memory.embedding = payload.memory.embedding;
            }
          }
          break;
        }

        case "MEMORY_DELETED": {
          // Remove memory from cache
          if (payload.memoryId) {
            const memory = this.memoriesById.get(payload.memoryId);
            if (memory) {
              this.memories.delete(memory.key);
              this.memoriesById.delete(payload.memoryId);
            }
          }
          break;
        }

        default:
          // Skip other event types
          break;
      }
    }
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

  // ========== Write Operations ==========

  /**
   * Save a new memory
   */
  async save(key: string, value: string, options: SaveMemoryOptions = {}): Promise<Memory> {
    const effectiveAgentId = options.agentId ?? this.agentId;

    // Acquire write lock if WriteLockManager is available
    if (this.writeLockManager && effectiveAgentId) {
      this.writeLockManager.acquireLock(key, effectiveAgentId);
    }

    try {
      // Check if key already exists
      if (this.memories.has(key)) {
        throw new MemoryKeyExistsError(key);
      }

      // Quota fast-fail check: read current usage to reject obviously over-quota requests early.
      // The actual enforcement happens atomically after event creation (see atomic UPDATE below).
      // hasQuotaRow tracks whether the agent is registered — unregistered agents bypass quotas.
      let hasQuotaRow = false;
      if (effectiveAgentId) {
        const db = this.eventStore.getDatabase();
        const quotaRow = db
          .prepare(
            "SELECT current_bytes, current_count, quota_bytes, quota_count FROM agent_quotas WHERE agent_id = $agent_id AND (expires_at IS NULL OR expires_at >= $now)"
          )
          .get({ $agent_id: effectiveAgentId, $now: new Date().toISOString() }) as
          | { current_bytes: number; current_count: number; quota_bytes: number; quota_count: number }
          | undefined;

        // If no quota row found and an agent was specified, the agent is expired or unregistered
        if (!quotaRow) {
          // Check if the agent exists but is expired (vs never registered — which has no quota row)
          const expiredRow = db
            .prepare(
              "SELECT agent_id FROM agent_quotas WHERE agent_id = $agent_id"
            )
            .get({ $agent_id: effectiveAgentId }) as { agent_id: string } | undefined;
          if (expiredRow) {
            throw new MemoryManagerError(
              `Agent "${effectiveAgentId}" registration has expired`,
              "AGENT_EXPIRED",
              { agentId: effectiveAgentId }
            );
          }
          // Agent is not registered — no quota enforcement
        }

        if (quotaRow) {
          hasQuotaRow = true;
          const valueBytes = new TextEncoder().encode(value).byteLength;
          if (quotaRow.current_bytes + valueBytes > quotaRow.quota_bytes) {
            throw new QuotaExhaustedError(
              effectiveAgentId,
              "bytes",
              quotaRow.current_bytes + valueBytes,
              quotaRow.quota_bytes
            );
          }
          if (quotaRow.current_count + 1 > quotaRow.quota_count) {
            throw new QuotaExhaustedError(
              effectiveAgentId,
              "count",
              quotaRow.current_count + 1,
              quotaRow.quota_count
            );
          }
        }
      }

      const now = new Date();
      const memoryId = this.generateUUID();

      const memory: Memory = {
        id: memoryId,
        key,
        value,
        sessionId: this.sessionId,
        priority: options.priority ?? this.defaultPriority,
        privacy: options.privacy ?? this.defaultPrivacy,
        createdAt: options.createdAt ?? now,
        updatedAt: options.updatedAt ?? now,
        metadata: options.metadata ?? {},
      };

      // Set agent identity on the memory
      if (effectiveAgentId !== undefined) {
        memory.agentId = effectiveAgentId;
      }
      memory.agentScope = options.agentScope ?? "public";

      // Store the agent role in metadata for role-scoped visibility checks
      if (this.agentRole && effectiveAgentId) {
        memory.metadata = { ...memory.metadata, agentRole: this.agentRole };
      }

      // Set optional properties only if defined
      if (options.category !== undefined) {
        memory.category = options.category;
      }
      if (options.channel !== undefined) {
        memory.channel = options.channel;
      } else if (this.defaultChannel !== undefined) {
        memory.channel = this.defaultChannel;
      }

      if (options.embedding) {
        memory.embedding = options.embedding;
      }

      // Store in cache
      this.memories.set(key, memory);
      this.memoriesById.set(memoryId, memory);

      // Create event for audit trail with full memory data for hydration
      const memoryData: Partial<Omit<Memory, "id">> = {
        key,
        value,
        sessionId: this.sessionId,
        priority: memory.priority,
        privacy: memory.privacy,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
        metadata: memory.metadata,
      };

      // Only include optional properties if they're defined
      if (memory.category !== undefined) {
        memoryData.category = memory.category;
      }
      if (memory.channel !== undefined) {
        memoryData.channel = memory.channel;
      }
      if (memory.agentId !== undefined) {
        memoryData.agentId = memory.agentId;
      }
      if (memory.agentScope !== undefined) {
        memoryData.agentScope = memory.agentScope;
      }

      const eventData: MemoryEventData = {
        memoryId,
        key,
        sessionId: this.sessionId,
        operation: "save",
        memory: memoryData,
      };

      await this.eventStore.createEvent(this.sessionId, "MEMORY_SAVED", eventData, {
        category: options.category,
        priority: memory.priority,
        channel: memory.channel,
      });

      // Atomic quota increment with WHERE guard to prevent TOCTOU race.
      // The WHERE clause ensures the update only succeeds if limits are not exceeded.
      // If result.changes === 0, another concurrent save pushed us over quota.
      // Only run when the agent has a registered quota row (unregistered agents bypass quotas).
      if (effectiveAgentId && hasQuotaRow) {
        const db = this.eventStore.getDatabase();
        const valueBytes = new TextEncoder().encode(value).byteLength;
        const result = db.prepare(
          `UPDATE agent_quotas
           SET current_bytes = current_bytes + $bytes, current_count = current_count + 1
           WHERE agent_id = $agent_id
             AND current_bytes + $bytes <= quota_bytes
             AND current_count + 1 <= quota_count`
        ).run({ $bytes: valueBytes, $agent_id: effectiveAgentId });

        if (result.changes === 0) {
          // Quota exceeded between fast-fail check and here — rollback in-memory state
          this.memories.delete(key);
          this.memoriesById.delete(memoryId);
          // Re-read actual limits for the error message
          const row = db.prepare(
            "SELECT current_bytes, current_count, quota_bytes, quota_count FROM agent_quotas WHERE agent_id = $agent_id"
          ).get({ $agent_id: effectiveAgentId }) as
            | { current_bytes: number; current_count: number; quota_bytes: number; quota_count: number }
            | undefined;
          throw new QuotaExhaustedError(
            effectiveAgentId,
            "bytes",
            (row?.current_bytes ?? 0) + valueBytes,
            row?.quota_bytes ?? 0
          );
        }
      }

      // Auto-track relevance if engine is available
      if (this.relevanceEngine) {
        try {
          this.relevanceEngine.ensureTracking(memoryId, memory.priority, memory.category);
        } catch (error) {
          console.warn("[MemoryManager] Relevance tracking failed:", error instanceof Error ? error.message : String(error));
        }
      }

      // Store in vector index if embedding provided
      if (this.vectorIndex && options.embedding) {
        const vectorData: Parameters<typeof this.vectorIndex.storeVector>[0] = {
          memoryId,
          sessionId: this.sessionId,
          embedding: options.embedding,
          content: value,
        };
        if (options.category !== undefined) {
          vectorData.category = options.category;
        }
        if (options.metadata !== undefined) {
          vectorData.metadata = options.metadata;
        }
        await this.vectorIndex.storeVector(vectorData);
      }

      // Publish memory save event via PubSub
      if (this.pubsub) {
        const pubsubEvent: import("../pubsub/index.js").MemoryEvent = {
          type: "save",
          key,
          timestamp: new Date().toISOString(),
          value,
        };
        if (options.category !== undefined) pubsubEvent.category = options.category;
        const effectiveChannel = options.channel ?? this.defaultChannel;
        if (effectiveChannel !== undefined) pubsubEvent.channel = effectiveChannel;
        if (effectiveAgentId !== undefined) pubsubEvent.agentId = effectiveAgentId;
        if (options.agentScope !== undefined) pubsubEvent.agentScope = options.agentScope;
        this.pubsub.publish(pubsubEvent);
      }

      return memory;
    } finally {
      // Release write lock if acquired
      if (this.writeLockManager && effectiveAgentId) {
        this.writeLockManager.releaseLock(key, effectiveAgentId);
      }
    }
  }

  /**
   * Save or update a memory (upsert)
   *
   * Note: If the memory already exists, `createdAt` and `updatedAt` from options
   * are ignored, and `updatedAt` is set to current time. This means re-running
   * migration with --force will not preserve original timestamps on updates.
   */
  async saveOrUpdate(key: string, value: string, options: SaveMemoryOptions = {}): Promise<Memory> {
    if (this.has(key)) {  // scope-aware check
      return this.update(key, { value, ...options });
    }
    return this.save(key, value, options);
  }

  /**
   * Update an existing memory
   */
  async update(key: string, options: UpdateMemoryOptions): Promise<Memory> {
    const existing = this.memories.get(key);
    if (!existing) {
      throw new MemoryKeyNotFoundError(key);
    }

    // Enforce write authorization: only owner or public memories can be updated
    if (!this.isVisibleToCurrentAgent(existing)) {
      throw new MemoryKeyNotFoundError(key);
    }
    if (existing.agentId && this.agentId && existing.agentId !== this.agentId) {
      throw new MemoryKeyNotFoundError(key); // Don't reveal existence to non-owner
    }

    // Quota delta check: if value is changing, verify byte quota allows growth
    const encoder = new TextEncoder();
    const oldBytes = encoder.encode(existing.value).byteLength;
    const newBytes = options.value !== undefined ? encoder.encode(options.value).byteLength : oldBytes;
    const bytesDelta = newBytes - oldBytes;

    if (bytesDelta > 0 && existing.agentId) {
      const db = this.eventStore.getDatabase();
      const quotaRow = db
        .prepare(
          "SELECT current_bytes, quota_bytes FROM agent_quotas WHERE agent_id = $agent_id"
        )
        .get({ $agent_id: existing.agentId }) as
        | { current_bytes: number; quota_bytes: number }
        | undefined;
      if (quotaRow && quotaRow.current_bytes + bytesDelta > quotaRow.quota_bytes) {
        throw new QuotaExhaustedError(
          existing.agentId,
          "bytes",
          quotaRow.current_bytes + bytesDelta,
          quotaRow.quota_bytes
        );
      }
    }

    const now = new Date();

    // Update fields
    if (options.value !== undefined) {
      existing.value = options.value;
    }
    if (options.category !== undefined) {
      existing.category = options.category;
    }
    if (options.priority !== undefined) {
      existing.priority = options.priority;
    }
    if (options.channel !== undefined) {
      existing.channel = options.channel;
    }
    if (options.metadata !== undefined) {
      existing.metadata = { ...existing.metadata, ...options.metadata };
    }
    if (options.embedding !== undefined) {
      existing.embedding = options.embedding;
    }
    existing.updatedAt = now;

    // Create event for audit trail with updated memory data for hydration
    const memoryData: Partial<Omit<Memory, "id">> = {
      value: existing.value,
      priority: existing.priority,
      updatedAt: existing.updatedAt,
      metadata: existing.metadata,
    };

    // Only include optional properties if they're defined
    if (existing.category !== undefined) {
      memoryData.category = existing.category;
    }
    if (existing.channel !== undefined) {
      memoryData.channel = existing.channel;
    }
    if (existing.embedding !== undefined) {
      memoryData.embedding = existing.embedding;
    }

    const eventData: MemoryEventData = {
      memoryId: existing.id,
      key,
      sessionId: this.sessionId,
      operation: "update",
      memory: memoryData,
    };

    await this.eventStore.createEvent(this.sessionId, "MEMORY_UPDATED", eventData, {
      category: existing.category,
      priority: existing.priority,
    });

    // Adjust byte quota if value size changed
    if (bytesDelta !== 0 && existing.agentId) {
      const db = this.eventStore.getDatabase();
      db.prepare(
        "UPDATE agent_quotas SET current_bytes = MAX(0, current_bytes + $delta) WHERE agent_id = $agent_id"
      ).run({ $delta: bytesDelta, $agent_id: existing.agentId });
    }

    // Update vector index if embedding changed
    if (this.vectorIndex && options.embedding) {
      const vectorData: Parameters<typeof this.vectorIndex.storeVector>[0] = {
        memoryId: existing.id,
        sessionId: this.sessionId,
        embedding: options.embedding,
        content: existing.value,
      };
      if (existing.category !== undefined) {
        vectorData.category = existing.category;
      }
      if (existing.metadata !== undefined) {
        vectorData.metadata = existing.metadata;
      }
      await this.vectorIndex.storeVector(vectorData);
    }

    return existing;
  }

  /**
   * Delete a memory by key
   */
  async delete(key: string): Promise<boolean> {
    const existing = this.memories.get(key);
    if (!existing) {
      return false;
    }

    // Enforce write authorization: only owner or public memories can be deleted
    if (!this.isVisibleToCurrentAgent(existing)) {
      return false;
    }
    if (existing.agentId && this.agentId && existing.agentId !== this.agentId) {
      return false; // Don't reveal existence to non-owner
    }

    // Remove from caches
    this.memories.delete(key);
    this.memoriesById.delete(existing.id);

    // Create event for audit trail
    const eventData: MemoryEventData = {
      memoryId: existing.id,
      key,
      sessionId: this.sessionId,
      operation: "delete",
    };

    await this.eventStore.createEvent(this.sessionId, "MEMORY_DELETED", eventData, {
      category: existing.category,
      priority: existing.priority,
    });

    // Remove from vector index
    if (this.vectorIndex) {
      await this.vectorIndex.deleteVector(existing.id);
    }

    // Decrement agent quota usage
    if (existing.agentId) {
      const db = this.eventStore.getDatabase();
      const valueBytes = new TextEncoder().encode(existing.value).byteLength;
      db.prepare(
        "UPDATE agent_quotas SET current_bytes = MAX(0, current_bytes - $bytes), current_count = MAX(0, current_count - 1) WHERE agent_id = $agent_id"
      ).run({ $bytes: valueBytes, $agent_id: existing.agentId });
    }

    // Publish memory delete event via PubSub
    if (this.pubsub) {
      const pubsubEvent: import("../pubsub/index.js").MemoryEvent = {
        type: "delete",
        key,
        timestamp: new Date().toISOString(),
      };
      if (existing.category !== undefined) pubsubEvent.category = existing.category;
      if (existing.channel !== undefined) pubsubEvent.channel = existing.channel;
      if (existing.agentId !== undefined) pubsubEvent.agentId = existing.agentId;
      if (existing.agentScope !== undefined) pubsubEvent.agentScope = existing.agentScope;
      this.pubsub.publish(pubsubEvent);
    }

    return true;
  }

  // ========== Read Operations ==========

  /**
   * Get a memory by key
   */
  get(key: string): Memory | null {
    const memory = this.memories.get(key) ?? null;

    // Scope enforcement: filter out memories not visible to the current agent
    if (memory && !this.isVisibleToCurrentAgent(memory)) {
      return null;
    }

    // Auto-track access for relevance
    if (memory && this.relevanceEngine) {
      try {
        this.relevanceEngine.trackAccess(memory.id);
      } catch (error) {
        console.warn("[MemoryManager] Relevance tracking failed:", error instanceof Error ? error.message : String(error));
      }
    }
    return memory;
  }

  /**
   * Get a memory by ID
   */
  getById(memoryId: MemoryId): Memory | null {
    const memory = this.memoriesById.get(memoryId) ?? null;
    if (memory && !this.isVisibleToCurrentAgent(memory)) {
      return null;
    }
    return memory;
  }

  /**
   * Check if a memory exists
   */
  has(key: string): boolean {
    const memory = this.memories.get(key);
    if (!memory) return false;
    return this.isVisibleToCurrentAgent(memory);
  }

  /**
   * List all memories in the current session
   */
  list(options: { limit?: number; category?: MemoryCategory; channel?: string } = {}): Memory[] {
    let memories = Array.from(this.memories.values());

    // Scope enforcement: filter to only visible memories
    memories = memories.filter((m) => this.isVisibleToCurrentAgent(m));

    // Filter by category
    if (options.category) {
      memories = memories.filter((m) => m.category === options.category);
    }

    // Filter by channel
    if (options.channel) {
      memories = memories.filter((m) => m.channel === options.channel);
    }

    // Sort by creation date (newest first)
    memories.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Apply limit
    if (options.limit !== undefined && options.limit > 0) {
      memories = memories.slice(0, options.limit);
    }

    return memories;
  }

  // ========== Search Operations ==========

  /**
   * Recall memories using various search methods
   */
  async recall(query: MemoryQuery): Promise<MemoryQueryResult[]> {
    const results: MemoryQueryResult[] = [];

    // Exact key match
    if (query.key) {
      const memory = this.memories.get(query.key);
      if (memory && this.isVisibleToCurrentAgent(memory)) {
        results.push({ memory, score: 1.0 });
      }

      // Record recall event for exact key match
      await this.eventStore.createEvent(this.sessionId, "MEMORY_RECALLED", {
        sessionId: this.sessionId,
        memoryId: memory?.id ?? "not-found",
        key: query.key,
        operation: "recall",
        affectedCount: results.length,
      } as MemoryEventData);

      return results;
    }

    // Pattern matching
    if (query.keyPattern) {
      const escaped = query.keyPattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      const pattern = new RegExp(`^${escaped}$`);
      for (const memory of this.memories.values()) {
        if (pattern.test(memory.key) && this.isVisibleToCurrentAgent(memory)) {
          results.push({ memory, score: 1.0 });
        }
      }
    } else {
      // Get all memories for filtering — apply scope enforcement
      for (const memory of this.memories.values()) {
        if (this.isVisibleToCurrentAgent(memory)) {
          results.push({ memory, score: 1.0 });
        }
      }
    }

    // Apply filters
    let filtered = results;

    if (query.category) {
      filtered = filtered.filter((r) => r.memory.category === query.category);
    }

    if (query.channel) {
      filtered = filtered.filter((r) => r.memory.channel === query.channel);
    }

    if (query.priority) {
      filtered = filtered.filter((r) => r.memory.priority === query.priority);
    }

    if (query.sessionId) {
      filtered = filtered.filter((r) => r.memory.sessionId === query.sessionId);
    }

    // Sort
    switch (query.sort) {
      case "created_asc":
        filtered.sort((a, b) => a.memory.createdAt.getTime() - b.memory.createdAt.getTime());
        break;
      case "created_desc":
        filtered.sort((a, b) => b.memory.createdAt.getTime() - a.memory.createdAt.getTime());
        break;
      case "updated_asc":
        filtered.sort((a, b) => a.memory.updatedAt.getTime() - b.memory.updatedAt.getTime());
        break;
      case "updated_desc":
        filtered.sort((a, b) => b.memory.updatedAt.getTime() - a.memory.updatedAt.getTime());
        break;
      default:
        // Default: newest first
        filtered.sort((a, b) => b.memory.createdAt.getTime() - a.memory.createdAt.getTime());
    }

    // Apply pagination
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    filtered = filtered.slice(offset, offset + limit);

    // Record recall event
    await this.eventStore.createEvent(this.sessionId, "MEMORY_RECALLED", {
      sessionId: this.sessionId,
      memoryId: "query",
      key: query.keyPattern ?? "all",
      operation: "recall",
      affectedCount: filtered.length,
    } as MemoryEventData);

    return filtered;
  }

  /**
   * Semantic search using vector embeddings
   */
  async semanticSearch(
    queryEmbedding: Float32Array,
    options: {
      limit?: number;
      threshold?: number;
      category?: string;
    } = {}
  ): Promise<MemoryQueryResult[]> {
    if (!this.vectorIndex) {
      throw new MemoryManagerError(
        "Vector index not configured for semantic search",
        "VECTOR_INDEX_NOT_CONFIGURED"
      );
    }

    const searchOptions: {
      limit?: number;
      threshold?: number;
      sessionId?: string;
      category?: string;
    } = {
      sessionId: this.sessionId,
    };
    if (options.limit !== undefined) {
      searchOptions.limit = options.limit;
    }
    if (options.threshold !== undefined) {
      searchOptions.threshold = options.threshold;
    }
    if (options.category !== undefined) {
      searchOptions.category = options.category;
    }

    const vectorResults = await this.vectorIndex.semanticSearch(queryEmbedding, searchOptions);

    // Map vector results to memory query results
    const results: MemoryQueryResult[] = [];
    for (const vr of vectorResults) {
      const memory = this.getById(vr.memoryId);
      if (memory) {
        results.push({
          memory,
          score: vr.similarity,
          highlights: [vr.content],
        });
      }
    }

    // Record recall event
    await this.eventStore.createEvent(this.sessionId, "MEMORY_RECALLED", {
      sessionId: this.sessionId,
      memoryId: "semantic-query",
      key: "semantic-search",
      operation: "recall",
      affectedCount: results.length,
    } as MemoryEventData);

    return results;
  }

  // ========== Proactive Recall ==========

  /**
   * Find memories related to the given text by keyword overlap.
   * Used for proactive recall on save — surfaces relevant existing memories.
   * Excludes memories from the current session by default.
   */
  findRelated(
    text: string,
    options: {
      excludeSessionId?: string;
      limit?: number;
      excludeKeys?: string[];
    } = {}
  ): Array<{ memory: Memory; score: number }> {
    const limit = options.limit ?? 5;
    const excludeKeys = new Set(options.excludeKeys ?? []);

    // Extract keywords (words >= 3 chars, lowercase, deduplicated)
    const keywords = [
      ...new Set(
        text
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length >= 3)
      ),
    ];

    if (keywords.length === 0) return [];

    const scored: Array<{ memory: Memory; score: number }> = [];

    for (const memory of this.memories.values()) {
      // Skip same-session memories
      if (options.excludeSessionId && memory.sessionId === options.excludeSessionId) {
        continue;
      }
      // Skip excluded keys
      if (excludeKeys.has(memory.key)) continue;
      // Scope enforcement: skip memories not visible to current agent
      if (!this.isVisibleToCurrentAgent(memory)) continue;

      // Score by keyword overlap
      const memoryText = `${memory.key} ${memory.value}`.toLowerCase();
      let matchCount = 0;
      for (const keyword of keywords) {
        if (memoryText.includes(keyword)) {
          matchCount++;
        }
      }

      if (matchCount > 0) {
        const score = matchCount / keywords.length;
        scored.push({ memory, score });
      }
    }

    // Sort by score descending, take top N
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Find memories related to the given text across ALL sessions by querying the
   * EventStore's SQLite database directly. This surfaces memories from other
   * sessions (e.g., Telegram session memories visible in Claude Code session).
   *
   * The current session's memories are excluded since they are already covered
   * by the in-memory `findRelated()` method.
   */
  findRelatedAcrossSessions(
    text: string,
    options: {
      excludeSessionId?: string;
      limit?: number;
      excludeKeys?: string[];
    } = {}
  ): Array<{ memory: Memory; score: number }> {
    const limit = options.limit ?? 5;
    const excludeKeys = new Set(options.excludeKeys ?? []);

    // Extract keywords (same logic as findRelated)
    const keywords = [
      ...new Set(
        text
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length >= 3)
      ),
    ];

    if (keywords.length === 0) return [];

    // Query EventStore directly for MEMORY_SAVED events from OTHER sessions
    const db = this.eventStore.getDatabase();
    const stmt = db.prepare(`
      SELECT payload FROM events
      WHERE event_type = 'MEMORY_SAVED'
      AND session_id != $excludeSession
      ORDER BY timestamp DESC
      LIMIT 500
    `);
    const excludeSession = options.excludeSessionId ?? this.sessionId;
    const rows = stmt.all({ $excludeSession: excludeSession }) as Array<{ payload: string }>;

    const scored: Array<{ memory: Memory; score: number }> = [];
    // Track keys we've already seen to avoid duplicates (keep most recent)
    const seenKeys = new Set<string>();

    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload) as MemoryEventData;
        const memData = payload.memory;
        if (!memData) continue;

        const key = payload.key;
        const value = memData.value ?? "";

        if (!key || !value) continue;
        if (excludeKeys.has(key)) continue;
        // Skip duplicate keys (rows are ordered DESC so first seen = most recent)
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        // Score by keyword overlap
        const memoryText = `${key} ${value}`.toLowerCase();
        let matchCount = 0;
        for (const keyword of keywords) {
          if (memoryText.includes(keyword)) {
            matchCount++;
          }
        }

        if (matchCount > 0) {
          const score = matchCount / keywords.length;
          // Reconstruct Memory object from event payload
          // Use the same pattern as hydrate() to handle exactOptionalPropertyTypes
          const reconstructed: Memory = {
            id: payload.memoryId as MemoryId,
            key,
            value,
            sessionId: payload.sessionId as SessionId,
            priority: memData.priority ?? "normal",
            privacy: memData.privacy ?? "session",
            createdAt: memData.createdAt ? new Date(memData.createdAt as unknown as string) : new Date(),
            updatedAt: memData.updatedAt ? new Date(memData.updatedAt as unknown as string) : new Date(),
            metadata: memData.metadata ?? {},
          };
          if (memData.category !== undefined) {
            reconstructed.category = memData.category;
          }
          if (memData.channel !== undefined) {
            reconstructed.channel = memData.channel;
          }
          if (memData.agentId !== undefined) {
            reconstructed.agentId = memData.agentId;
          }
          if (memData.agentScope !== undefined) {
            reconstructed.agentScope = memData.agentScope;
          }

          // Scope enforcement: skip memories not visible to current agent
          if (!this.isVisibleToCurrentAgent(reconstructed)) continue;

          scored.push({ memory: reconstructed, score });
        }
      } catch (error) {
        console.warn("[MemoryManager] findRelatedAcrossSessions: skipping malformed event:", error instanceof Error ? error.message : String(error));
        continue;
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // ========== Utility Operations ==========

  /**
   * Get total number of memories
   */
  count(): number {
    return this.memories.size;
  }

  /**
   * Get statistics about memories
   */
  getStats(): {
    totalMemories: number;
    byCategory: Record<string, number>;
    byPriority: Record<MemoryPriority, number>;
    byChannel: Record<string, number>;
  } {
    const stats = {
      totalMemories: this.memories.size,
      byCategory: {} as Record<string, number>,
      byPriority: { high: 0, normal: 0, low: 0 } as Record<MemoryPriority, number>,
      byChannel: {} as Record<string, number>,
    };

    for (const memory of this.memories.values()) {
      // Count by category
      if (memory.category) {
        stats.byCategory[memory.category] = (stats.byCategory[memory.category] ?? 0) + 1;
      }

      // Count by priority
      stats.byPriority[memory.priority]++;

      // Count by channel
      if (memory.channel) {
        stats.byChannel[memory.channel] = (stats.byChannel[memory.channel] ?? 0) + 1;
      }
    }

    return stats;
  }

  /**
   * Clear all memories (for testing)
   */
  clear(): void {
    this.memories.clear();
    this.memoriesById.clear();
  }

  /**
   * Get current session ID
   */
  getSessionId(): SessionId {
    return this.sessionId;
  }

  /**
   * Get event store instance (for testing)
   */
  getEventStore(): EventStore {
    return this.eventStore;
  }

  /** Get the agent ID configured for this manager */
  getAgentId(): AgentId | undefined {
    return this.agentId;
  }

  /**
   * Close resources
   */
  async close(): Promise<void> {
    await this.eventStore.close();
    if (this.vectorIndex) {
      await this.vectorIndex.close();
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a memory manager with default in-memory storage
 */
export function createMemoryManager(config: MemoryManagerConfig): MemoryManager {
  return new MemoryManager(config);
}

/**
 * Create a memory manager for testing (in-memory everything)
 */
export function createTestMemoryManager(sessionId: SessionId): MemoryManager {
  return new MemoryManager({
    sessionId,
    eventStore: createInMemoryEventStore(),
  });
}
