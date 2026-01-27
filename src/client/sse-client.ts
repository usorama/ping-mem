/**
 * SSE (Server-Sent Events) Client for ping-mem
 *
 * Provides an SSE client for real-time communication with ping-mem
 * using Server-Sent Events for server-to-client messages.
 *
 * @module client/sse-client
 * @version 1.0.0
 */

import type {
  SSEClientConfig,
  PingMemClient,
  Session,
  SessionConfig,
  Memory,
  MemoryQuery,
  MemoryQueryResult,
  ContextSaveOptions,
  CheckpointConfig,
  SessionId,
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
// SSE Client Implementation
// ============================================================================

/**
 * SSE client for ping-mem
 *
 * Uses Server-Sent Events for real-time updates from the server
 * and HTTP POST for sending requests to the server.
 */
export class SSEPingMemClient implements PingMemClient {
  private config: Required<Omit<SSEClientConfig, "eventHandlers">> & {
    eventHandlers?: SSEClientConfig["eventHandlers"];
  };
  private currentSessionId: SessionId | undefined;
  private eventSource: EventSource | null = null;
  private messageQueue: Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private requestIdCounter = 0;

  constructor(config: SSEClientConfig = {}) {
    this.config = {
      baseUrl: config.baseUrl ?? "http://localhost:3000",
      apiKey: config.apiKey ?? "",
      timeout: config.timeout ?? 30000,
      sessionId: config.sessionId ?? "",
      sseEndpoint: config.sseEndpoint ?? "/sse",
      headers: config.headers ?? {},
      eventHandlers: config.eventHandlers,
    };
    this.currentSessionId = this.config.sessionId || undefined;
  }

  // ========================================================================
  // Connection Management
  // ========================================================================

  /**
   * Connect to the SSE server
   * This must be called before using the client
   */
  async connect(): Promise<void> {
    if (this.eventSource) {
      return; // Already connected
    }

    return new Promise((resolve, reject) => {
      try {
        const url = new URL(this.config.sseEndpoint, this.config.baseUrl);

        // Build SSE URL with query parameters
        if (this.config.apiKey) {
          url.searchParams.set("api_key", this.config.apiKey);
        }
        if (this.currentSessionId) {
          url.searchParams.set("session_id", this.currentSessionId);
        }

        this.eventSource = new EventSource(url.toString());

        // Handle connection open
        this.eventSource.onopen = () => {
          this.config.eventHandlers?.onOpen?.();
          resolve();
        };

        // Handle incoming messages
        this.eventSource.onmessage = (event) => {
          this.handleMessage(event);
          this.config.eventHandlers?.onMessage?.(event);
        };

        // Handle errors
        this.eventSource.onerror = (error) => {
          this.config.eventHandlers?.onError?.(error);

          // EventSource will automatically try to reconnect
          // We only reject on initial connection failure
          if (this.eventSource?.readyState === EventSource.CLOSED) {
            reject(new NetworkError("Failed to connect to SSE server"));
          }
        };
      } catch (error) {
        reject(
          new NetworkError(
            `Failed to create EventSource: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    });
  }

  /**
   * Disconnect from the SSE server
   */
  async disconnect(): Promise<void> {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      this.config.eventHandlers?.onClose?.();
    }

    // Clear all pending requests
    for (const { reject, timeout } of this.messageQueue.values()) {
      clearTimeout(timeout);
      reject(new Error("Connection closed"));
    }
    this.messageQueue.clear();
  }

  // ========================================================================
  // Session Management
  // ========================================================================

  async startSession(config: SessionConfig): Promise<Session> {
    const response = await this.sendRequest<{
      sessionId: string;
      name: string;
      status: string;
      startedAt: string;
    }>("context_session_start", config as unknown as Record<string, unknown>);

    const session: Session = {
      id: response.sessionId,
      name: response.name,
      status: response.status as Session["status"],
      startedAt: response.startedAt,
      memoryCount: 0,
      eventCount: 0,
      lastActivityAt: response.startedAt,
      metadata: {},
    };

    this.currentSessionId = session.id;
    return session;
  }

  async endSession(): Promise<void> {
    await this.sendRequest<Record<string, never>>("context_session_end", {});
    this.currentSessionId = undefined;
  }

  async listSessions(limit = 10): Promise<Session[]> {
    // For SSE client, we need to use REST endpoint for listing sessions
    // since there's no an MCP tool for this
    const response = await this.fetchJSON<{ data: Session[] }>(
      `/api/v1/session/list?limit=${limit}`,
      {
        method: "GET",
      }
    );

    return "data" in response ? response.data : (response as unknown as Session[]);
  }

  // ========================================================================
  // Context Operations
  // ========================================================================

  async save(key: string, value: string, options?: ContextSaveOptions): Promise<void> {
    await this.sendRequest<Record<string, never>>("context_save", {
      key,
      value,
      ...options,
    });
  }

  async get(key: string): Promise<Memory> {
    const response = await this.sendRequest<string>("context_get", { key });
    return JSON.parse(response) as Memory;
  }

  async search(query: MemoryQuery): Promise<MemoryQueryResult[]> {
    const response = await this.sendRequest<string>("context_search", query as unknown as Record<string, unknown>);
    return JSON.parse(response) as MemoryQueryResult[];
  }

  async delete(key: string): Promise<void> {
    await this.sendRequest<Record<string, never>>("context_delete", { key });
  }

  // ========================================================================
  // Checkpoint Operations
  // ========================================================================

  async checkpoint(config: CheckpointConfig): Promise<void> {
    await this.sendRequest<Record<string, never>>("context_checkpoint", config as unknown as Record<string, unknown>);
  }

  // ========================================================================
  // Status Operations
  // ========================================================================

  async getStatus(): Promise<{
    eventStore: { totalEvents: number };
    sessions: { total: number; active: number };
    currentSession: Session | null;
  }> {
    // For SSE client, we need to use REST endpoint for status
    const response = await this.fetchJSON<{
      data: {
        eventStore: { totalEvents: number };
        sessions: { total: number; active: number };
        currentSession: Session | null;
      };
    }>("/api/v1/status", {
      method: "GET",
    });

    return "data" in response ? response.data : (response as unknown as {
      eventStore: { totalEvents: number };
      sessions: { total: number; active: number };
      currentSession: Session | null;
    });
  }

  // ========================================================================
  // Client Lifecycle
  // ========================================================================

  async close(): Promise<void> {
    await this.disconnect();
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
   * Send a request via the SSE endpoint
   * Uses HTTP POST to send, SSE to receive response
   */
  private async sendRequest<T>(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<T> {
    // Auto-connect if not connected
    if (!this.eventSource || this.eventSource.readyState !== EventSource.OPEN) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      const requestId = `req_${++this.requestIdCounter}`;

      // Set up timeout
      const timeout = setTimeout(() => {
        this.messageQueue.delete(requestId);
        reject(new NetworkError(`Request timeout after ${this.config.timeout}ms`));
      }, this.config.timeout);

      // Store pending request
      this.messageQueue.set(requestId, { resolve, reject, timeout });

      // Send request via HTTP POST
      const messageUrl = new URL("/messages", this.config.baseUrl);

      fetch(messageUrl.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.apiKey && { "X-API-Key": this.config.apiKey }),
          ...(this.currentSessionId && { "X-Session-ID": this.currentSessionId }),
          ...this.config.headers,
        },
        body: JSON.stringify({
          requestId,
          toolName,
          arguments: args,
        }),
      }).catch((error) => {
        clearTimeout(timeout);
        this.messageQueue.delete(requestId);
        reject(new NetworkError(`Failed to send request: ${error.message}`));
      });
    });
  }

  /**
   * Handle incoming SSE message
   */
  private handleMessage(event: MessageEvent): void {
    try {
      const data = JSON.parse(event.data);

      // Check if this is a response to a pending request
      if (data.requestId && this.messageQueue.has(data.requestId)) {
        const { resolve, timeout } = this.messageQueue.get(data.requestId)!;
        clearTimeout(timeout);
        this.messageQueue.delete(data.requestId);

        // Check for errors
        if (data.isError || data.error) {
          const error = this.createErrorFromResponse(data);
          resolve(Promise.reject(error));
        } else {
          // Extract content from MCP response
          if (data.content && Array.isArray(data.content) && data.content[0]) {
            resolve(data.content[0].text);
          } else {
            resolve(data);
          }
        }
      }
    } catch (error) {
      console.error("[SSE Client] Failed to parse message:", error);
    }
  }

  /**
   * Create an error from an MCP error response
   */
  private createErrorFromResponse(response: any): Error {
    const message =
      response.content?.[0]?.text ||
      response.error?.message ||
      "Unknown error";

    if (response.error?.code === "AUTHENTICATION_ERROR" || response.status === 401) {
      return new AuthenticationError(message);
    }
    if (response.error?.code === "NOT_FOUND" || response.status === 404) {
      return new NotFoundError(message);
    }
    if (response.error?.code === "VALIDATION_ERROR" || response.status === 400) {
      return new ValidationError(message, response.error?.details);
    }

    return new ServerError(message, response.status);
  }

  /**
   * Fetch JSON from REST API (for operations not available via SSE)
   */
  private async fetchJSON<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;

    const headers = new Headers({
      "Content-Type": "application/json",
      ...this.config.headers,
    });

    if (this.config.apiKey) {
      headers.append("X-API-Key", this.config.apiKey);
    }

    if (this.currentSessionId) {
      headers.append("X-Session-ID", this.currentSessionId);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        await this.handleErrorResponse(response);
      }

      const data = await response.json();
      return data as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        throw new NetworkError(
          `Request timeout after ${this.config.timeout}ms`,
          { url, timeout: this.config.timeout }
        );
      }

      if (error instanceof PingMemClientError) {
        throw error;
      }

      throw new NetworkError(`Network error: ${error instanceof Error ? error.message : String(error)}`, {
        url,
        originalError: error,
      });
    }
  }

  /**
   * Handle error responses from the API
   */
  private async handleErrorResponse(response: Response): Promise<never> {
    let errorData: { error?: string; message?: string; details?: Record<string, unknown> } | null = null;

    try {
      errorData = await response.json();
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
 * Create an SSE client with default configuration
 *
 * @param config - Client configuration
 * @returns SSE client instance
 *
 * @example
 * ```ts
 * const client = createSSEClient({
 *   baseUrl: "https://ping-mem.example.com",
 *   apiKey: "your-api-key",
 *   eventHandlers: {
 *     onOpen: () => console.log("Connected"),
 *     onError: (error) => console.error(error),
 *   }
 * });
 *
 * await client.connect();
 * await client.startSession({ name: "my-session" });
 * ```
 */
export function createSSEClient(config?: SSEClientConfig): SSEPingMemClient {
  return new SSEPingMemClient(config);
}

/**
 * Create an SSE client for local development
 *
 * @param config - Optional client configuration
 * @returns SSE client instance
 *
 * @example
 * ```ts
 * const client = createLocalSSEClient();
 * await client.connect();
 * await client.startSession({ name: "my-session" });
 * ```
 */
export function createLocalSSEClient(
  config?: Omit<SSEClientConfig, "baseUrl">
): SSEPingMemClient {
  return new SSEPingMemClient({
    ...config,
    baseUrl: "http://localhost:3000",
  });
}
