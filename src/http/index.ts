/**
 * HTTP Transport Module for ping-mem
 *
 * Exports HTTP server implementations for accessing ping-mem
 * over HTTP using SSE (Server-Sent Events) or REST API.
 *
 * @module http
 * @version 1.0.0
 */

// ============================================================================
// Exports
// ============================================================================

export * from "./types.js";
export * from "./sse-server.js";
export * from "./rest-server.js";

// ============================================================================
// Convenience Exports
// ============================================================================

export type {
  // Types
  HTTPTransportType,
  HTTPServerConfig,
  RESTContext,
  RESTErrorResponse,
  RESTSuccessResponse,
  SSEServerConfig,
  ContextSaveRequest,
  ContextSearchParams,
  CheckpointRequest,
} from "./types.js";

export {
  // SSE Server
  SSEPingMemServer,
  createDefaultSSEConfig,
} from "./sse-server.js";

export {
  // REST Server
  RESTPingMemServer,
  createDefaultRESTConfig,
} from "./rest-server.js";
