/**
 * Core Type Definitions for ping-mem
 *
 * These types provide the foundation for the universal memory layer,
 * supporting session management, memory operations, and event tracking.
 *
 * @module types
 * @version 1.0.0
 */

// ============================================================================
// Agent Identity Types (Multi-Agent Memory)
// ============================================================================

/**
 * Branded AgentId — security boundary type.
 * Prevents accidental string assignment; all agent IDs must go through createAgentId().
 */
declare const AgentIdBrand: unique symbol;
export type AgentId = string & { readonly [AgentIdBrand]: typeof AgentIdBrand };

/**
 * Validate and create a branded AgentId from a raw string.
 * @throws {Error} if raw is empty or exceeds 256 characters
 */
export function createAgentId(raw: string): AgentId {
  if (!raw || !raw.trim()) throw new Error("Agent ID must be a non-empty string");
  if (raw.length > 256) throw new Error(`Agent ID exceeds 256 character limit (got ${raw.length})`);
  if (!/^[a-zA-Z0-9_\-.:@]+$/.test(raw)) throw new Error(`Agent ID contains invalid characters: only alphanumeric, underscore, hyphen, dot, colon, @ allowed`);
  return raw as AgentId;
}

/**
 * Free-form agent role string (e.g. "researcher", "coder", "reviewer").
 * Not an enum — consumers define their own roles.
 */
export type AgentRole = string;

/**
 * Visibility scope for agent memories.
 * - "private": only the owning agent can read/write
 * - "role": agents with the same role can read
 * - "shared": all agents in the same session can read
 * - "public": any agent in any session can read
 */
export type AgentMemoryScope = "private" | "role" | "shared" | "public";

/**
 * Registered agent identity with quota and TTL information.
 */
export interface AgentIdentity {
  /** Branded agent identifier */
  agentId: AgentId;
  /** Free-form role string */
  role: AgentRole;
  /** Whether this agent has admin privileges */
  admin: boolean;
  /** Time-to-live for the agent registration in milliseconds */
  ttlMs: number;
  /** ISO 8601 expiration timestamp */
  expiresAt: string;
  /** Maximum memory storage in bytes */
  quotaBytes: number;
  /** Maximum number of memory entries */
  quotaCount: number;
  /** Arbitrary metadata attached to this agent */
  metadata: Record<string, unknown>;
}

/**
 * Current quota usage for an agent.
 */
export interface AgentQuotaUsage {
  /** Branded agent identifier */
  agentId: AgentId;
  /** Agent role */
  role: AgentRole;
  /** Current bytes consumed */
  currentBytes: number;
  /** Current number of memory entries */
  currentCount: number;
  /** Maximum bytes allowed */
  quotaBytes: number;
  /** Maximum entries allowed */
  quotaCount: number;
  /** Percentage of quota used (0-100, based on the higher of bytes/count ratios) */
  percentUsed: number;
}

// ============================================================================
// Session Types
// ============================================================================

/**
 * Unique session identifier (UUIDv7)
 */
export type SessionId = string;

/**
 * Session lifecycle status
 */
export type SessionStatus = "active" | "paused" | "ended" | "archived";

/**
 * Configuration for a memory session
 */
export interface SessionConfig {
  /** Unique session name/identifier */
  name: string;
  /** Optional project directory for context isolation */
  projectDir?: string;
  /** Session to continue from (loads previous context) */
  continueFrom?: SessionId;
  /** Default channel for memories */
  defaultChannel?: string;
  /** Auto-load context from previous sessions */
  autoLoadContext?: boolean;
  /** Optional agent identity binding for multi-agent sessions */
  agentId?: AgentId;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

/**
 * A memory session with lifecycle tracking
 */
export interface Session {
  /** Unique session ID (UUIDv7 - time-sortable) */
  id: SessionId;
  /** Human-readable session name */
  name: string;
  /** Current session status */
  status: SessionStatus;
  /** When the session started */
  startedAt: Date;
  /** When the session ended (if applicable) */
  endedAt?: Date;
  /** Project directory for isolation */
  projectDir?: string;
  /** Parent session ID if this continues from another */
  parentSessionId?: SessionId;
  /** Default channel for this session */
  defaultChannel?: string;
  /** Number of memories stored in this session */
  memoryCount: number;
  /** Total events in this session */
  eventCount: number;
  /** Last activity timestamp */
  lastActivityAt: Date;
  /** Custom metadata */
  metadata: Record<string, unknown>;
}

// ============================================================================
// Memory Types
// ============================================================================

/**
 * Unique memory identifier
 */
export type MemoryId = string;

/**
 * Built-in memory categories shipped with ping-mem.
 */
export type BuiltInCategory =
  | "task"
  | "decision"
  | "progress"
  | "note"
  | "error"
  | "warning"
  | "fact"
  | "observation"
  | "knowledge_entry"
  | "digest";

/**
 * Memory categories for organization.
 * Includes all built-in categories plus any custom string.
 * The `(string & {})` pattern preserves autocomplete for built-in values
 * while allowing arbitrary strings at runtime.
 */
export type MemoryCategory = BuiltInCategory | (string & {});

/**
 * Priority levels for memories
 */
export type MemoryPriority = "high" | "normal" | "low";

/**
 * Privacy scope for memories
 */
export type MemoryPrivacy = "session" | "project" | "global";

/**
 * A single memory item
 */
export interface Memory {
  /** Unique memory ID */
  id: MemoryId;
  /** Unique key for retrieval */
  key: string;
  /** Memory content/value */
  value: string;
  /** Session this memory belongs to */
  sessionId: SessionId;
  /** Optional category */
  category?: MemoryCategory;
  /** Priority level */
  priority: MemoryPriority;
  /** Privacy scope */
  privacy: MemoryPrivacy;
  /** Channel for organization (e.g., git branch, feature name) */
  channel?: string;
  /** When created */
  createdAt: Date;
  /** When last updated */
  updatedAt: Date;
  /** Semantic embedding vector (768 dimensions) */
  embedding?: Float32Array;
  /** Custom metadata */
  metadata: Record<string, unknown>;
  /** Agent that owns this memory (multi-agent support) */
  agentId?: AgentId;
  /** Visibility scope for multi-agent access control */
  agentScope?: AgentMemoryScope;
}

/**
 * Query options for memory retrieval
 */
export interface MemoryQuery {
  /** Filter by key (exact match) */
  key?: string;
  /** Filter by key pattern (wildcard) */
  keyPattern?: string;
  /** Filter by category */
  category?: MemoryCategory;
  /** Filter by channel */
  channel?: string;
  /** Filter by priority */
  priority?: MemoryPriority;
  /** Filter by session ID */
  sessionId?: SessionId;
  /** Semantic search query */
  semanticQuery?: string;
  /** Minimum similarity score for semantic search (0-1) */
  minSimilarity?: number;
  /** Maximum results to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Sort order */
  sort?: "created_asc" | "created_desc" | "updated_asc" | "updated_desc" | "relevance";
}

/**
 * Result from memory query with relevance scoring
 */
export interface MemoryQueryResult {
  /** The memory item */
  memory: Memory;
  /** Relevance score (0-1) for semantic search */
  score?: number;
  /** Matching highlights */
  highlights?: string[];
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Event types for session and memory operations
 */
export type EventType =
  | "SESSION_STARTED"
  | "SESSION_ENDED"
  | "SESSION_PAUSED"
  | "SESSION_RESUMED"
  | "MEMORY_SAVED"
  | "MEMORY_UPDATED"
  | "MEMORY_DELETED"
  | "MEMORY_RECALLED"
  | "CHECKPOINT_CREATED"
  | "CONTEXT_LOADED"
  | "TOOL_RUN_RECORDED"
  | "DIAGNOSTICS_INGESTED"
  | "GIT_OPERATION_RECORDED"
  | "AGENT_TASK_STARTED"
  | "AGENT_TASK_SUMMARY"
  | "AGENT_TASK_COMPLETED";

/**
 * Event payload for session events
 */
export interface SessionEventData {
  /** Session ID */
  sessionId: SessionId;
  /** Session name */
  name: string;
  /** Configuration used */
  config?: SessionConfig;
  /** Reason for event (e.g., user action, timeout) */
  reason?: string;
}

/**
 * Event payload for memory operations
 */
export interface MemoryEventData {
  /** Memory ID */
  memoryId: MemoryId;
  /** Memory key */
  key: string;
  /** Session ID */
  sessionId: SessionId;
  /** Operation performed */
  operation: "save" | "update" | "delete" | "recall";
  /** Number of memories affected */
  affectedCount?: number;
  /** Full memory data for hydration (included in MEMORY_SAVED events) */
  memory?: Partial<Omit<Memory, "id">>;
}

export interface WorklogEventData {
  sessionId: SessionId;
  kind: "tool" | "diagnostics" | "git" | "task";
  title: string;
  status?: "success" | "failed" | "partial" | undefined;
  toolName?: string | undefined;
  toolVersion?: string | undefined;
  configHash?: string | undefined;
  environmentHash?: string | undefined;
  projectId?: string | undefined;
  treeHash?: string | undefined;
  commitHash?: string | undefined;
  runId?: string | undefined;
  command?: string | undefined;
  durationMs?: number | undefined;
  summary?: string | undefined;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Context Loading Types
// ============================================================================

/**
 * Options for context loading
 */
export interface ContextLoadOptions {
  /** Maximum memories to load */
  maxMemories?: number;
  /** Only load high-priority memories */
  highPriorityOnly?: boolean;
  /** Categories to include */
  categories?: MemoryCategory[];
  /** Channels to include */
  channels?: string[];
  /** Time window (load memories from last N days) */
  timeWindowDays?: number;
}

/**
 * Result from context loading
 */
export interface ContextLoadResult {
  /** Memories loaded */
  memories: Memory[];
  /** Number of memories loaded */
  count: number;
  /** Session IDs context was loaded from */
  sourceSessions: SessionId[];
  /** Time taken to load (ms) */
  durationMs: number;
}

// ============================================================================
// Metrics Types
// ============================================================================

/**
 * Session statistics
 */
export interface SessionStats {
  /** Session ID */
  sessionId: SessionId;
  /** Total memories in session */
  totalMemories: number;
  /** Memories by category */
  memoriesByCategory: Record<MemoryCategory, number>;
  /** Memories by priority */
  memoriesByPriority: Record<MemoryPriority, number>;
  /** Total events */
  totalEvents: number;
  /** Session duration (ms) */
  durationMs?: number;
  /** Average memory size (bytes) */
  avgMemorySize: number;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Base error for ping-mem operations
 */
export class PingMemError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "PingMemError";
  }
}

/**
 * Session not found error
 */
export class SessionNotFoundError extends PingMemError {
  constructor(sessionId: SessionId) {
    super(`Session not found: ${sessionId}`, "SESSION_NOT_FOUND", { sessionId });
    this.name = "SessionNotFoundError";
  }
}

/**
 * Memory not found error
 */
export class MemoryNotFoundError extends PingMemError {
  constructor(key: string) {
    super(`Memory not found: ${key}`, "MEMORY_NOT_FOUND", { key });
    this.name = "MemoryNotFoundError";
  }
}

/**
 * Invalid session state error
 */
export class InvalidSessionStateError extends PingMemError {
  constructor(sessionId: SessionId, expectedState: SessionStatus, actualState: SessionStatus) {
    super(
      `Invalid session state: expected ${expectedState}, got ${actualState}`,
      "INVALID_SESSION_STATE",
      { sessionId, expectedState, actualState }
    );
    this.name = "InvalidSessionStateError";
  }
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * UUID v7 generator function type
 */
export type UUIDv7Generator = () => string;

/**
 * SHA-256 hash string (64 hex characters)
 */
export type SHA256Hash = string;

/**
 * ISO 8601 timestamp string
 */
export type ISOTimestamp = string;

// ============================================================================
// Graph Types (Graphiti Integration)
// ============================================================================

export {
  EntityType,
  RelationshipType,
  type Entity,
  type Relationship,
  type EntityExtractResult,
  type RelationshipInferResult,
} from "./graph.js";
