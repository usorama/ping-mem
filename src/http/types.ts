/**
 * HTTP Server Type Definitions for ping-mem
 *
 * Provides type definitions for HTTP transport layers,
 * including SSE, REST, and MCP over HTTP.
 *
 * @module http/types
 * @version 1.0.0
 */

import type { PingMemServerConfig } from "../mcp/PingMemServer.js";

// ============================================================================
// HTTP Server Types
// ============================================================================

/**
 * Transport type for HTTP server
 */
export type HTTPTransportType = "sse" | "rest" | "streamable-http";

/**
 * HTTP server configuration
 */
export interface HTTPServerConfig {
  /** Port to listen on (default: 3000) */
  port?: number;
  /** Host to bind to (default: 0.0.0.0) */
  host?: string;
  /** Transport type (default: streamable-http) */
  transport?: HTTPTransportType;
  /** Enable CORS (default: true) */
  cors?: {
    origin?: string | string[];
    methods?: string[];
    headers?: string[];
  };
  /** API key for authentication (optional) */
  apiKey?: string;
  /** Session ID generator for stateful transport (optional) */
  sessionIdGenerator?: () => string;
}

// Re-export PingMemServerConfig for convenience
export type { PingMemServerConfig };

/**
 * REST API request context
 */
export interface RESTContext {
  /** Session ID from header or query parameter */
  sessionId?: string;
  /** API key from header (if authentication enabled) */
  apiKey?: string;
  /** Request timestamp */
  timestamp: number;
}

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
// SSE Server Types
// ============================================================================

/**
 * SSE server configuration extending HTTP server config
 */
export interface SSEServerConfig extends HTTPServerConfig {
  /** Endpoint for SSE connection (default: /sse) */
  sseEndpoint?: string;
  /** Endpoint for POST messages (default: /messages) */
  messageEndpoint?: string;
}

// ============================================================================
// REST API Types
// ============================================================================

/**
 * Context save request body
 */
export interface ContextSaveRequest {
  /** Unique key for the memory */
  key: string;
  /** Memory content */
  value: string;
  /** Memory category (optional) */
  category?: "task" | "decision" | "progress" | "note" | "error" | "warning";
  /** Priority level (optional) */
  priority?: "high" | "normal" | "low";
  /** Channel for organization (optional) */
  channel?: string;
  /** Custom metadata (optional) */
  metadata?: Record<string, unknown>;
  /** Private flag (optional) */
  private?: boolean;
}

/**
 * Context search query parameters
 */
export interface ContextSearchParams {
  /** Search query */
  query: string;
  /** Filter by category (optional) */
  category?: string;
  /** Filter by channel (optional) */
  channel?: string;
  /** Filter by priority (optional) */
  priority?: string;
  /** Maximum results (optional) */
  limit?: number;
  /** Offset for pagination (optional) */
  offset?: number;
}

/**
 * Checkpoint request body
 */
export interface CheckpointRequest {
  /** Checkpoint name */
  name: string;
  /** Checkpoint description (optional) */
  description?: string;
  /** Include cached files (optional) */
  includeFiles?: boolean;
  /** Include git status (optional) */
  includeGitStatus?: boolean;
}
