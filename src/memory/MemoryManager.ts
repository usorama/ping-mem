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
} from "../types/index.js";
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
              value: payload.memory.value!,
              sessionId: payload.sessionId,
              priority: payload.memory.priority ?? "normal",
              privacy: payload.memory.privacy ?? "session",
              createdAt: new Date(payload.memory.createdAt!),
              updatedAt: new Date(payload.memory.updatedAt!),
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
    // Check if key already exists
    if (this.memories.has(key)) {
      throw new MemoryKeyExistsError(key);
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

    return memory;
  }

  /**
   * Save or update a memory (upsert)
   */
  async saveOrUpdate(key: string, value: string, options: SaveMemoryOptions = {}): Promise<Memory> {
    const existing = this.memories.get(key);
    if (existing) {
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

    return true;
  }

  // ========== Read Operations ==========

  /**
   * Get a memory by key
   */
  get(key: string): Memory | null {
    return this.memories.get(key) ?? null;
  }

  /**
   * Get a memory by ID
   */
  getById(memoryId: MemoryId): Memory | null {
    return this.memoriesById.get(memoryId) ?? null;
  }

  /**
   * Check if a memory exists
   */
  has(key: string): boolean {
    return this.memories.has(key);
  }

  /**
   * List all memories in the current session
   */
  list(options: { limit?: number; category?: MemoryCategory; channel?: string } = {}): Memory[] {
    let memories = Array.from(this.memories.values());

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
      if (memory) {
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
      const pattern = new RegExp(
        query.keyPattern.replace(/\*/g, ".*").replace(/\?/g, ".")
      );
      for (const memory of this.memories.values()) {
        if (pattern.test(memory.key)) {
          results.push({ memory, score: 1.0 });
        }
      }
    } else {
      // Get all memories for filtering
      for (const memory of this.memories.values()) {
        results.push({ memory, score: 1.0 });
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
      const memory = this.memoriesById.get(vr.memoryId);
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
