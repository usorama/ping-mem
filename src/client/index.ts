/**
 * ping-mem Client SDK
 *
 * Universal client SDK for accessing ping-mem functionality
 * from TypeScript/JavaScript applications.
 *
 * @module client
 * @version 1.0.0
 *
 * @example
 * ```ts
 * import { createRESTClient } from "ping-mem/client";
 *
 * const client = createRESTClient({
 *   baseUrl: "https://ping-mem.example.com",
 *   apiKey: "your-api-key"
 * });
 *
 * await client.startSession({ name: "my-session" });
 * await client.save("user-preferences", JSON.stringify({ theme: "dark" }));
 * const memory = await client.get("user-preferences");
 * await client.close();
 * ```
 */

// ============================================================================
// Type Exports
// ============================================================================

export type {
  // Core Types
  SessionId,
  SessionStatus,
  MemoryCategory,
  MemoryPriority,
  MemoryPrivacy,
  MemoryId,
  // Session Types
  SessionConfig,
  Session,
  // Memory Types
  Memory,
  MemoryQuery,
  MemoryQueryResult,
  // Context Operations
  ContextSaveOptions,
  CheckpointConfig,
  // Client Configuration
  ClientConfig,
  SSEClientConfig,
  RESTClientConfig,
  // API Responses
  RESTErrorResponse,
  RESTSuccessResponse,
  // Client Interface
  PingMemClient,
} from "./types.js";

// ============================================================================
// Error Classes (from types)
// ============================================================================

export {
  PingMemClientError,
  NetworkError,
  AuthenticationError,
  NotFoundError,
  ValidationError,
  ServerError,
} from "./types.js";

// ============================================================================
// REST Client Exports
// ============================================================================

export {
  RESTPingMemClient,
  createRESTClient,
  createLocalRESTClient,
} from "./rest-client.js";

// ============================================================================
// SSE Client Exports
// ============================================================================

export {
  SSEPingMemClient,
  createSSEClient,
  createLocalSSEClient,
} from "./sse-client.js";

// ============================================================================
// Convenience Re-exports
// ============================================================================

/**
 * Create a ping-mem client
 *
 * This is a convenience function that automatically chooses
 * between REST and SSE clients based on the configuration.
 *
 * @param config - Client configuration
 * @returns Client instance
 *
 * @example
 * ```ts
 * // Create REST client (default)
 * const restClient = createClient({
 *   baseUrl: "https://ping-mem.example.com"
 * });
 *
 * // Create SSE client
 * const sseClient = createClient({
 *   baseUrl: "https://ping-mem.example.com",
 *   transport: "sse",
 *   eventHandlers: {
 *     onOpen: () => console.log("Connected")
 *   }
 * });
 * ```
 */
export function createClient(config: (import("./types.js").RESTClientConfig & { transport?: "rest" }) |
                               (import("./types.js").SSEClientConfig & { transport: "sse" })) {
  if (config.transport === "sse") {
    const { createSSEClient } = require("./sse-client.js");
    return createSSEClient(config);
  }

  const { createRESTClient } = require("./rest-client.js");
  return createRESTClient(config);
}
