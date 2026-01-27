/**
 * Client SDK Type Definitions for ping-mem
 *
 * Provides TypeScript types for the ping-mem client SDK,
 * mirroring the server-side types for type safety.
 *
 * @module client/types
 * @version 1.0.0
 */

// ============================================================================
// Core Types
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
 * Memory categories for organization
 */
export type MemoryCategory =
  | "task"
  | "decision"
  | "progress"
  | "note"
  | "error"
  | "warning";

/**
 * Priority levels for memories
 */
export type MemoryPriority = "high" | "normal" | "low";

/**
 * Privacy scope for memories
 */
export type MemoryPrivacy = "session" | "project" | "global";

/**
 * Unique memory identifier
 */
export type MemoryId = string;

// ============================================================================
// Session Types
// ============================================================================

/**
 * Configuration for starting a new session
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
  startedAt: string;
  /** When the session ended (if applicable) */
  endedAt?: string;
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
  lastActivityAt: string;
  /** Custom metadata */
  metadata: Record<string, unknown>;
}

// ============================================================================
// Memory Types
// ============================================================================

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
  createdAt: string;
  /** When last updated */
  updatedAt: string;
  /** Custom metadata */
  metadata: Record<string, unknown>;
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
  query?: string;
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
// Context Operations Types
// ============================================================================

/**
 * Options for saving context
 */
export interface ContextSaveOptions {
  /** Memory category (optional) */
  category?: MemoryCategory;
  /** Priority level (optional) */
  priority?: MemoryPriority;
  /** Channel for organization (optional) */
  channel?: string;
  /** Custom metadata (optional) */
  metadata?: Record<string, unknown>;
  /** Private flag (optional) */
  private?: boolean;
}

/**
 * Checkpoint configuration
 */
export interface CheckpointConfig {
  /** Checkpoint name */
  name: string;
  /** Checkpoint description (optional) */
  description?: string;
  /** Include cached files (optional) */
  includeFiles?: boolean;
  /** Include git status (optional) */
  includeGitStatus?: boolean;
}

// ============================================================================
// Client Configuration Types
// ============================================================================

/**
 * Base client configuration
 */
export interface ClientConfig {
  /** Server base URL (default: http://localhost:3000) */
  baseUrl?: string;
  /** API key for authentication (optional) */
  apiKey?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Default session ID (optional) */
  sessionId?: SessionId;
  /** Additional headers to include in requests */
  headers?: Record<string, string>;
}

/**
 * SSE client configuration
 */
export interface SSEClientConfig extends ClientConfig {
  /** SSE endpoint path (default: /sse) */
  sseEndpoint?: string;
  /** Event handlers for SSE connection */
  eventHandlers?: {
    onOpen?: () => void;
    onMessage?: (event: MessageEvent) => void;
    onError?: (error: Event) => void;
    onClose?: () => void;
  };
}

/**
 * REST client configuration (same as base)
 */
export type RESTClientConfig = ClientConfig;

// ============================================================================
// API Response Types
// ============================================================================

/**
 * REST API error response
 */
export interface RESTErrorResponse {
  /** Error code */
  error: string;
  /** Human-readable error message */
  message: string;
  /** Additional details */
  details?: Record<string, unknown>;
  /** Request ID for tracing */
  requestId?: string;
}

/**
 * REST API success response wrapper
 */
export interface RESTSuccessResponse<T> {
  /** Response data */
  data: T;
  /** Request ID for tracing */
  requestId?: string;
}

// ============================================================================
// Client Interface
// ============================================================================

/**
 * Base interface for ping-mem clients
 * Both SSE and REST clients must implement this interface
 */
export interface PingMemClient {
  /**
   * Start a new session
   */
  startSession(config: SessionConfig): Promise<Session>;

  /**
   * End the current session
   */
  endSession(): Promise<void>;

  /**
   * List sessions
   */
  listSessions(limit?: number): Promise<Session[]>;

  /**
   * Save a memory
   */
  save(key: string, value: string, options?: ContextSaveOptions): Promise<void>;

  /**
   * Get a memory by key
   */
  get(key: string): Promise<Memory>;

  /**
   * Search memories
   */
  search(query: MemoryQuery): Promise<MemoryQueryResult[]>;

  /**
   * Delete a memory
   */
  delete(key: string): Promise<void>;

  /**
   * Create a checkpoint
   */
  checkpoint(config: CheckpointConfig): Promise<void>;

  /**
   * Get current status
   */
  getStatus(): Promise<{
    eventStore: { totalEvents: number };
    sessions: { total: number; active: number };
    currentSession: Session | null;
  }>;

  /**
   * Close the client connection
   */
  close(): Promise<void>;

  /**
   * Get the current session ID
   */
  getSessionId(): SessionId | undefined;

  /**
   * Set the current session ID
   */
  setSessionId(sessionId: SessionId): void;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Base error for ping-mem client operations
 */
export class PingMemClientError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "PingMemClientError";
  }
}

/**
 * Network error
 */
export class NetworkError extends PingMemClientError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "NETWORK_ERROR", undefined, context);
    this.name = "NetworkError";
  }
}

/**
 * Authentication error
 */
export class AuthenticationError extends PingMemClientError {
  constructor(message: string) {
    super(message, "AUTHENTICATION_ERROR", 401);
    this.name = "AuthenticationError";
  }
}

/**
 * Not found error
 */
export class NotFoundError extends PingMemClientError {
  constructor(message: string) {
    super(message, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

/**
 * Validation error
 */
export class ValidationError extends PingMemClientError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", 400, details);
    this.name = "ValidationError";
  }
}

/**
 * Server error
 */
export class ServerError extends PingMemClientError {
  constructor(message: string, statusCode?: number) {
    super(message, "SERVER_ERROR", statusCode ?? 500);
    this.name = "ServerError";
  }
}
