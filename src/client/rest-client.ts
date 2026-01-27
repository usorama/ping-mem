/**
 * REST Client for ping-mem
 *
 * Provides a REST API client for accessing ping-mem functionality
 * using standard HTTP requests.
 *
 * @module client/rest-client
 * @version 1.0.0
 */

import type {
  RESTClientConfig,
  PingMemClient,
  Session,
  SessionConfig,
  Memory,
  MemoryQuery,
  MemoryQueryResult,
  ContextSaveOptions,
  CheckpointConfig,
  SessionId,
  RESTSuccessResponse,
  RESTErrorResponse,
} from "./types.js";

import {
  PingMemClientError,
  NetworkError,
  AuthenticationError,
  NotFoundError,
  ValidationError,
  ServerError,
} from "./types.js";

// ============================================================================
// REST Client Implementation
// ============================================================================

/**
 * REST API client for ping-mem
 *
 * Uses the fetch API to communicate with the ping-mem REST server.
 * Compatible with browsers, Node.js, and other JavaScript runtimes.
 */
export class RESTPingMemClient implements PingMemClient {
  private config: Required<RESTClientConfig>;
  private currentSessionId: SessionId | undefined;

  constructor(config: RESTClientConfig = {}) {
    this.config = {
      baseUrl: config.baseUrl ?? "http://localhost:3000",
      apiKey: config.apiKey ?? "",
      timeout: config.timeout ?? 30000,
      sessionId: config.sessionId ?? "",
      headers: config.headers ?? {},
    };
    this.currentSessionId = this.config.sessionId || undefined;
  }

  // ========================================================================
  // Session Management
  // ========================================================================

  async startSession(config: SessionConfig): Promise<Session> {
    const response = await this.fetchJSON<RESTSuccessResponse<Session>>(
      "/api/v1/session/start",
      {
        method: "POST",
        body: JSON.stringify(config),
      }
    );

    this.currentSessionId = response.data.id;
    return response.data;
  }

  async endSession(): Promise<void> {
    await this.fetchJSON<RESTSuccessResponse<{ message: string }>>(
      "/api/v1/session/end",
      {
        method: "POST",
      }
    );
    this.currentSessionId = undefined;
  }

  async listSessions(limit = 10): Promise<Session[]> {
    const response = await this.fetchJSON<RESTSuccessResponse<Session[]>>(
      `/api/v1/session/list?limit=${limit}`,
      {
        method: "GET",
      }
    );
    return response.data;
  }

  // ========================================================================
  // Context Operations
  // ========================================================================

  async save(key: string, value: string, options?: ContextSaveOptions): Promise<void> {
    await this.fetchJSON<RESTSuccessResponse<{ message: string }>>("/api/v1/context", {
      method: "POST",
      body: JSON.stringify({
        key,
        value,
        ...options,
      }),
    });
  }

  async get(key: string): Promise<Memory> {
    const response = await this.fetchJSON<{ data: Memory }>(`/api/v1/context/${encodeURIComponent(key)}`, {
      method: "GET",
    });

    // Handle both wrapped and unwrapped responses
    return "data" in response ? (response as { data: Memory }).data : response as unknown as Memory;
  }

  async search(query: MemoryQuery): Promise<MemoryQueryResult[]> {
    const params = new URLSearchParams();

    if (query.query) params.append("query", query.query);
    if (query.category) params.append("category", query.category);
    if (query.channel) params.append("channel", query.channel);
    if (query.priority) params.append("priority", query.priority);
    if (query.limit) params.append("limit", query.limit.toString());
    if (query.offset) params.append("offset", query.offset.toString());
    if (query.sort) params.append("sort", query.sort);

    const response = await this.fetchJSON<RESTSuccessResponse<MemoryQueryResult[]>>(
      `/api/v1/search?${params.toString()}`,
      {
        method: "GET",
      }
    );

    return response.data;
  }

  async delete(key: string): Promise<void> {
    await this.fetchJSON<RESTSuccessResponse<{ message: string }>>(
      `/api/v1/context/${encodeURIComponent(key)}`,
      {
        method: "DELETE",
      }
    );
  }

  // ========================================================================
  // Checkpoint Operations
  // ========================================================================

  async checkpoint(config: CheckpointConfig): Promise<void> {
    await this.fetchJSON<RESTSuccessResponse<{ message: string }>>("/api/v1/checkpoint", {
      method: "POST",
      body: JSON.stringify(config),
    });
  }

  // ========================================================================
  // Status Operations
  // ========================================================================

  async getStatus(): Promise<{
    eventStore: { totalEvents: number };
    sessions: { total: number; active: number };
    currentSession: Session | null;
  }> {
    const response = await this.fetchJSON<
      RESTSuccessResponse<{
        eventStore: { totalEvents: number };
        sessions: { total: number; active: number };
        currentSession: Session | null;
      }>
    >("/api/v1/status", {
      method: "GET",
    });

    return response.data;
  }

  // ========================================================================
  // Client Lifecycle
  // ========================================================================

  async close(): Promise<void> {
    // REST client doesn't maintain persistent connections
    // Just clear the session ID
    this.currentSessionId = undefined;
  }

  getSessionId(): SessionId | undefined {
    return this.currentSessionId;
  }

  setSessionId(sessionId: SessionId): void {
    this.currentSessionId = sessionId;
  }

  // ========================================================================
  // Private Helper Methods
  // ========================================================================

  /**
   * Fetch JSON from the API with error handling
   */
  private async fetchJSON<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;

    // Build headers
    const headers = new Headers({
      "Content-Type": "application/json",
      ...this.config.headers,
    });

    // Add API key if configured
    if (this.config.apiKey) {
      headers.append("X-API-Key", this.config.apiKey);
    }

    // Add session ID if available
    if (this.currentSessionId) {
      headers.append("X-Session-ID", this.currentSessionId);
    }

    // Merge with options headers
    if (options.headers) {
      const optionsHeaders = new Headers(options.headers);
      optionsHeaders.forEach((value, key) => {
        headers.set(key, value);
      });
    }

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle non-OK responses
      if (!response.ok) {
        await this.handleErrorResponse(response);
      }

      // Parse JSON response
      const data = await response.json();
      return data as T;
    } catch (error) {
      clearTimeout(timeoutId);

      // Handle AbortError (timeout)
      if (error instanceof Error && error.name === "AbortError") {
        throw new NetworkError(
          `Request timeout after ${this.config.timeout}ms`,
          { url, timeout: this.config.timeout }
        );
      }

      // Re-throw network errors
      if (error instanceof TypeError) {
        throw new NetworkError(`Network error: ${error.message}`, { url, originalError: error });
      }

      // Re-throw PingMemClientError instances
      if (error instanceof PingMemClientError) {
        throw error;
      }

      // Unknown error
      throw new NetworkError(
        `Unknown error: ${error instanceof Error ? error.message : String(error)}`,
        { url, originalError: error }
      );
    }
  }

  /**
   * Handle error responses from the API
   */
  private async handleErrorResponse(response: Response): Promise<never> {
    let errorData: RESTErrorResponse | null = null;

    try {
      errorData = await response.json() as RESTErrorResponse;
    } catch {
      // If parsing fails, use default error
    }

    const message = errorData?.message ?? response.statusText ?? "Unknown error";

    switch (response.status) {
      case 400:
        throw new ValidationError(message, errorData?.details);
      case 401:
        throw new AuthenticationError(message);
      case 403:
        throw new AuthenticationError(`Forbidden: ${message}`);
      case 404:
        throw new NotFoundError(message);
      case 500:
      case 502:
      case 503:
        throw new ServerError(message, response.status);
      default:
        throw new ServerError(message, response.status);
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a REST client with default configuration
 *
 * @param config - Client configuration
 * @returns REST client instance
 *
 * @example
 * ```ts
 * const client = createRESTClient({
 *   baseUrl: "https://ping-mem.example.com",
 *   apiKey: "your-api-key"
 * });
 *
 * await client.startSession({ name: "my-session" });
 * await client.save("key", "value");
 * ```
 */
export function createRESTClient(config?: RESTClientConfig): RESTPingMemClient {
  return new RESTPingMemClient(config);
}

/**
 * Create a REST client for local development
 *
 * @param config - Optional client configuration
 * @returns REST client instance
 *
 * @example
 * ```ts
 * const client = createLocalRESTClient();
 * await client.startSession({ name: "my-session" });
 * ```
 */
export function createLocalRESTClient(config?: Omit<RESTClientConfig, "baseUrl">): RESTPingMemClient {
  return new RESTPingMemClient({
    ...config,
    baseUrl: "http://localhost:3000",
  });
}
