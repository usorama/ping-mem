/**
 * REST API Server for ping-mem
 *
 * Provides a simple REST API for accessing ping-mem functionality
 * without requiring MCP protocol overhead.
 *
 * @module http/rest-server
 * @version 1.0.0
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { SessionManager } from "../session/SessionManager.js";
import { MemoryManager, type MemoryManagerConfig } from "../memory/MemoryManager.js";
import { EventStore } from "../storage/EventStore.js";
import { VectorIndex, createInMemoryVectorIndex } from "../search/VectorIndex.js";
import type { GraphManager } from "../graph/GraphManager.js";
import type { HybridSearchEngine } from "../search/HybridSearchEngine.js";
import type {
  SessionId,
  MemoryCategory,
  MemoryPriority,
  MemoryPrivacy,
} from "../types/index.js";

import type {
  HTTPServerConfig,
  RESTErrorResponse,
  RESTSuccessResponse,
  ContextSaveRequest,
  ContextSearchParams,
  CheckpointRequest,
} from "./types.js";
import type { PingMemServerConfig } from "../mcp/PingMemServer.js";

// ============================================================================
// REST Server Class
// ============================================================================

/**
 * REST API server for ping-mem
 *
 * Provides HTTP endpoints for memory operations without requiring
 * full MCP protocol implementation.
 */
export class RESTPingMemServer {
  private app: Hono;
  private config: HTTPServerConfig & PingMemServerConfig;

  // Core components (same as PingMemServer)
  private eventStore: EventStore;
  private sessionManager: SessionManager;
  private vectorIndex: VectorIndex | null = null;
  private memoryManagers: Map<SessionId, MemoryManager> = new Map();
  private currentSessionId: SessionId | null = null;
  private graphManager: GraphManager | null = null;
  private hybridSearchEngine: HybridSearchEngine | null = null;

  constructor(config: HTTPServerConfig & PingMemServerConfig) {
    this.config = {
      dbPath: ":memory:",
      enableVectorSearch: false,
      vectorDimensions: 768,
      ...config,
    };

    // Initialize core components
    this.eventStore = new EventStore({ dbPath: this.config.dbPath ?? ":memory:" });
    this.sessionManager = new SessionManager({ eventStore: this.eventStore });

    // Initialize vector index if enabled
    if (this.config.enableVectorSearch && this.config.vectorDimensions !== undefined) {
      this.vectorIndex = createInMemoryVectorIndex({
        vectorDimensions: this.config.vectorDimensions,
      });
    } else if (this.config.enableVectorSearch) {
      this.vectorIndex = createInMemoryVectorIndex();
    }

    // Initialize optional graph and search components
    if (config.graphManager) {
      this.graphManager = config.graphManager;
    }
    if (config.hybridSearchEngine) {
      this.hybridSearchEngine = config.hybridSearchEngine;
    }

    // Initialize Hono app
    this.app = new Hono();

    // Set up middleware
    this.setupMiddleware();

    // Set up routes
    this.setupRoutes();
  }

  /**
   * Set up Hono middleware
   */
  private setupMiddleware(): void {
    // CORS
    const corsConfig = this.config.cors ?? { origin: "*" };
    this.app.use(
      "*",
      cors({
        origin: corsConfig.origin ?? "*",
        allowMethods: corsConfig.methods ?? ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: corsConfig.headers ?? ["Content-Type", "X-API-Key", "X-Session-ID"],
        credentials: true,
      })
    );

    // Logger
    this.app.use("*", logger());

    // API Key authentication (if configured)
    if (this.config.apiKey) {
      this.app.use("/api/*", async (c, next) => {
        const apiKey = c.req.header("x-api-key");
        if (apiKey !== this.config.apiKey) {
          return c.json(
            {
              error: "Unauthorized",
              message: "Invalid API key",
            },
            401
          );
        }
        return next();
      });
    }
  }

  /**
   * Set up REST API routes
   */
  private setupRoutes(): void {
    // Health check
    this.app.get("/health", (c) => {
      return c.json({ status: "ok", timestamp: new Date().toISOString() });
    });

    // ============================================================================
    // Session Management
    // ============================================================================

    this.app.post("/api/v1/session/start", async (c) => {
      try {
        const body = await c.req.json();
        const session = await this.sessionManager.startSession({
          name: body.name,
          projectDir: body.projectDir,
          continueFrom: body.continueFrom,
          defaultChannel: body.defaultChannel,
        });

        this.currentSessionId = session.id;

        // Create MemoryManager for this session
        const memoryConfig: MemoryManagerConfig = {
          eventStore: this.eventStore,
          sessionId: session.id,
        };

        if (this.vectorIndex) {
          memoryConfig.vectorIndex = this.vectorIndex;
        }

        const memoryManager = new MemoryManager(memoryConfig);
        this.memoryManagers.set(session.id, memoryManager);

        return c.json<RESTSuccessResponse<typeof session>>({
          data: session,
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.post("/api/v1/session/end", async (c) => {
      try {
        if (!this.currentSessionId) {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "No active session",
            },
            400
          );
        }

        await this.sessionManager.endSession(this.currentSessionId);
        this.currentSessionId = null;

        return c.json<RESTSuccessResponse<{ message: string }>>({
          data: { message: "Session ended" },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/session/list", async (c) => {
      try {
        const limit = parseInt(c.req.query("limit") ?? "10");
        const sessions = this.sessionManager.listSessions().slice(0, limit);

        return c.json<RESTSuccessResponse<typeof sessions>>({
          data: sessions,
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Context Operations
    // ============================================================================

    this.app.post("/api/v1/context", async (c) => {
      try {
        const body = await c.req.json() as ContextSaveRequest;
        const sessionId = this.currentSessionId ?? c.req.header("x-session-id");

        if (!sessionId) {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "No active session. Call /api/v1/session/start first.",
            },
            400
          );
        }

        const memoryManager = this.getMemoryManager(sessionId);

        // Build options, excluding undefined values
        const options: Record<string, unknown> = {};
        if (body.category !== undefined) options.category = body.category;
        if (body.priority !== undefined) options.priority = body.priority;
        if (body.channel !== undefined) options.channel = body.channel;
        if (body.metadata !== undefined) options.metadata = body.metadata;

        await memoryManager.save(body.key, body.value, options);

        return c.json<RESTSuccessResponse<{ message: string }>>({
          data: { message: "Memory saved successfully" },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/context/:key", async (c) => {
      try {
        const key = c.req.param("key");
        const sessionId = this.currentSessionId ?? c.req.header("x-session-id");

        if (!sessionId) {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "No active session",
            },
            400
          );
        }

        const memoryManager = this.getMemoryManager(sessionId);

        // Use recall to get memory by key
        const results = await memoryManager.recall({ key });

        if (results.length === 0) {
          return c.json(
            {
              error: "Not Found",
              message: `Memory with key "${key}" not found`,
            },
            404
          );
        }

        const memory = results[0]?.memory;
        if (!memory) {
          return c.json(
            {
              error: "Not Found",
              message: `Memory with key "${key}" not found`,
            },
            404
          );
        }

        return c.json({
          data: memory,
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.delete("/api/v1/context/:key", async (c) => {
      try {
        const key = c.req.param("key");
        const sessionId = this.currentSessionId ?? c.req.header("x-session-id");

        if (!sessionId) {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "No active session",
            },
            400
          );
        }

        const memoryManager = this.getMemoryManager(sessionId);
        await memoryManager.delete(key);

        return c.json<RESTSuccessResponse<{ message: string }>>({
          data: { message: "Memory deleted successfully" },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Search Operations
    // ============================================================================

    this.app.get("/api/v1/search", async (c) => {
      try {
        const query = c.req.query("query");
        if (!query) {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "Missing 'query' parameter",
            },
            400
          );
        }

        const sessionId = this.currentSessionId ?? c.req.header("x-session-id");
        if (!sessionId) {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "No active session",
            },
            400
          );
        }

        const memoryManager = this.getMemoryManager(sessionId);

        // Build query params
        const queryParams: Record<string, unknown> = { query };

        if (c.req.query("category")) {
          queryParams.category = c.req.query("category") as MemoryCategory;
        }
        if (c.req.query("channel")) {
          queryParams.channel = c.req.query("channel");
        }
        if (c.req.query("priority")) {
          queryParams.priority = c.req.query("priority") as MemoryPriority;
        }
        if (c.req.query("limit")) {
          queryParams.limit = parseInt(c.req.query("limit")!);
        }
        if (c.req.query("offset")) {
          queryParams.offset = parseInt(c.req.query("offset")!);
        }

        const results = await memoryManager.recall(queryParams);

        return c.json<RESTSuccessResponse<typeof results>>({
          data: results,
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Checkpoint Operations
    // ============================================================================

    this.app.post("/api/v1/checkpoint", async (c) => {
      try {
        const body = await c.req.json() as CheckpointRequest;
        const sessionId = this.currentSessionId ?? c.req.header("x-session-id");

        if (!sessionId) {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "No active session",
            },
            400
          );
        }

        // Create checkpoint using event store
        // Get memory count for the session
        const session = await this.sessionManager.getSession(sessionId);
        if (!session) {
          throw new Error("Session not found");
        }

        await this.eventStore.createCheckpoint(
          sessionId,
          session.memoryCount,
          body.description
        );

        return c.json<RESTSuccessResponse<{ message: string }>>({
          data: { message: "Checkpoint created" },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Status and Statistics
    // ============================================================================

    this.app.get("/api/v1/status", async (c) => {
      try {
        const currentSession = this.currentSessionId
          ? await this.sessionManager.getSession(this.currentSessionId)
          : null;

        const stats = {
          eventStore: {
            totalEvents: 0, // EventStore doesn't expose getEventCount publicly
          },
          sessions: {
            total: this.sessionManager.listSessions().length,
            active: this.sessionManager.listSessions({ status: "active" }).length,
          },
          currentSession: currentSession
            ? {
                id: currentSession.id,
                name: currentSession.name,
                status: currentSession.status,
                memoryCount: currentSession.memoryCount,
              }
            : null,
        };

        return c.json<RESTSuccessResponse<typeof stats>>({
          data: stats,
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/stats", async (c) => {
      return c.redirect("/api/v1/status");
    });
  }

  /**
   * Handle errors and return consistent error responses
   */
  private handleError(c: any, error: unknown): Response {
    console.error("[REST Server] Error:", error);

    const message = error instanceof Error ? error.message : "Unknown error";
    const statusCode = this.getStatusCode(error);

    return c.json(
      {
        error: this.getErrorName(statusCode),
        message,
      },
      statusCode
    );
  }

  /**
   * Map error to HTTP status code
   */
  private getStatusCode(error: unknown): number {
    if (error instanceof Error) {
      if (error.message.includes("not found")) {
        return 404;
      }
      if (error.message.includes("unauthorized") || error.message.includes("authentication")) {
        return 401;
      }
      if (error.message.includes("forbidden")) {
        return 403;
      }
      if (error.message.includes("invalid") || error.message.includes("validation")) {
        return 400;
      }
    }
    return 500;
  }

  /**
   * Map status code to error name
   */
  private getErrorName(statusCode: number): string {
    const names: Record<number, string> = {
      400: "Bad Request",
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not Found",
      500: "Internal Server Error",
      503: "Service Unavailable",
    };
    return names[statusCode] ?? "Error";
  }

  /**
   * Get MemoryManager for session, creating if needed
   */
  private getMemoryManager(sessionId: SessionId): MemoryManager {
    let manager = this.memoryManagers.get(sessionId);
    if (!manager) {
      const config: MemoryManagerConfig = {
        eventStore: this.eventStore,
        sessionId,
      };

      if (this.vectorIndex) {
        config.vectorIndex = this.vectorIndex;
      }

      manager = new MemoryManager(config);
      this.memoryManagers.set(sessionId, manager);
    }
    return manager;
  }

  /**
   * Handle incoming HTTP request
   *
   * This method should be called from your HTTP server's request handler.
   *
   * @param req - Node.js IncomingMessage
   * @param res - Node.js ServerResponse
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Convert Node.js HTTP request to Web Standard Request
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);

    // Build request headers
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers.set(key, value);
      } else if (Array.isArray(value)) {
        headers.set(key, value.join(", "));
      }
    }

    // Build request body
    let body: string | null = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await this.readRequestBody(req);
    }

    // Create Web Standard Request
    const webRequest = new Request(url.toString(), {
      method: req.method ?? "GET",
      headers,
      body,
    });

    // Process request through Hono
    const webResponse = await this.app.fetch(webRequest);

    // Convert Web Standard Response to Node.js HTTP Response
    res.statusCode = webResponse.status;
    webResponse.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    const responseBody = await webResponse.text();
    res.end(responseBody);
  }

  /**
   * Read request body as string
   */
  private async readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => {
        resolve(data);
      });
      req.on("error", (error) => {
        reject(error);
      });
    });
  }

  /**
   * Start the REST server
   */
  async start(): Promise<void> {
    console.log("[REST Server] Started (ready to handle requests)");
  }

  /**
   * Stop the REST server
   */
  async stop(): Promise<void> {
    await this.eventStore.close();
    console.log("[REST Server] Stopped");
  }

  /**
   * Get the Hono app instance (for advanced use cases)
   */
  getApp(): Hono {
    return this.app;
  }

  /**
   * Get the session manager
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Get the event store
   */
  getEventStore(): EventStore {
    return this.eventStore;
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Create a default REST server configuration
 */
export function createDefaultRESTConfig(
  overrides?: Partial<HTTPServerConfig>
): HTTPServerConfig {
  return {
    port: 3000,
    host: "0.0.0.0",
    transport: "rest",
    cors: {
      origin: "*",
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      headers: ["Content-Type", "X-API-Key", "X-Session-ID"],
    },
    ...overrides,
  };
}
