/**
 * SSE (Server-Sent Events) Transport for ping-mem
 *
 * Provides MCP protocol over HTTP using SSE for server-to-client
 * messages and HTTP POST for client-to-server messages.
 *
 * @module http/sse-server
 * @version 1.0.0
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";

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

import type { SSEServerConfig } from "./types.js";
import type { PingMemServerConfig } from "../mcp/PingMemServer.js";
import { TOOLS } from "../mcp/PingMemServer.js";

// ============================================================================
// SSE Server Class
// ============================================================================

/**
 * SSE-based MCP server for ping-mem
 *
 * Uses StreamableHTTPServerTransport to provide MCP protocol over HTTP
 * with SSE streaming support.
 */
export class SSEPingMemServer {
  private server: Server;
  private transport: StreamableHTTPServerTransport;
  private config: SSEServerConfig & PingMemServerConfig;

  // Core components (same as PingMemServer)
  private eventStore: EventStore;
  private sessionManager: SessionManager;
  private vectorIndex: VectorIndex | null = null;
  private memoryManagers: Map<SessionId, MemoryManager> = new Map();
  private currentSessionId: SessionId | null = null;
  private graphManager: GraphManager | null = null;
  private hybridSearchEngine: HybridSearchEngine | null = null;

  constructor(config: SSEServerConfig & PingMemServerConfig) {
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

    // Initialize MCP server
    this.server = new Server(
      {
        name: "ping-mem-sse-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize StreamableHTTP transport
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: this.config.sessionIdGenerator ?? (() => crypto.randomUUID()),
    });

    // Set up MCP tool handlers first
    this.setupHandlers();

    // Connect server to transport
    // Note: Type assertion needed due to optional onclose/onerror in StreamableHTTPServerTransport
    this.server.connect(this.transport as any);
  }

  /**
   * Set up MCP request handlers
   */
  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: TOOLS,
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "context_session_start":
            return await this.handleSessionStart(args ?? {});
          case "context_session_end":
            return await this.handleSessionEnd(args ?? {});
          case "context_save":
            return await this.handleSave(args ?? {});
          case "context_get":
            return await this.handleGet(args ?? {});
          case "context_search":
            return await this.handleSearch(args ?? {});
          case "context_delete":
            return await this.handleDelete(args ?? {});
          case "context_checkpoint":
            return await this.handleCheckpoint(args ?? {});
          case "ping":
            return { content: [{ type: "text", text: "pong" }] };
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Unknown error",
            },
          ],
          isError: true,
        };
      }
    });
  }

  // ============================================================================
  // Tool Handlers (simplified versions from PingMemServer)
  // ============================================================================

  private async handleSessionStart(args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
  }> {
    const session = await this.sessionManager.startSession({
      name: args.name as string,
      projectDir: args.projectDir as string,
      continueFrom: args.continueFrom as SessionId,
      defaultChannel: args.defaultChannel as string,
    });

    this.currentSessionId = session.id;

    // Create MemoryManager for this session if vector search enabled
    if (this.vectorIndex) {
      const memoryConfig: MemoryManagerConfig = {
        eventStore: this.eventStore,
        sessionId: session.id,
      };

      if (this.vectorIndex) {
        memoryConfig.vectorIndex = this.vectorIndex;
      }

      const memoryManager = new MemoryManager(memoryConfig);
      this.memoryManagers.set(session.id, memoryManager);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            sessionId: session.id,
            name: session.name,
            status: session.status,
            startedAt: session.startedAt.toISOString(),
          }),
        },
      ],
    };
  }

  private async handleSessionEnd(args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
  }> {
    if (!this.currentSessionId) {
      throw new Error("No active session");
    }

    await this.sessionManager.endSession(this.currentSessionId);
    this.currentSessionId = null;

    return {
      content: [{ type: "text", text: "Session ended" }],
    };
  }

  private async handleSave(args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
  }> {
    const sessionId = this.currentSessionId ?? (args.sessionId as SessionId);
    if (!sessionId) {
      throw new Error("No active session. Call context_session_start first.");
    }

    const memoryManager = this.getMemoryManager(sessionId);

    await memoryManager.save(
      args.key as string,
      args.value as string,
      {
        category: args.category as MemoryCategory,
        priority: args.priority as MemoryPriority,
        channel: args.channel as string,
        metadata: args.metadata as Record<string, unknown>,
      }
    );

    return {
      content: [{ type: "text", text: "Memory saved successfully" }],
    };
  }

  private async handleGet(args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
  }> {
    const sessionId = this.currentSessionId ?? (args.sessionId as SessionId);
    if (!sessionId) {
      throw new Error("No active session");
    }

    const memoryManager = this.getMemoryManager(sessionId);

    const key = args.key as string | undefined;
    if (key) {
      // Use recall to get memory by key
      const results = await memoryManager.recall({ key });
      if (results.length === 0) {
        throw new Error(`Memory with key "${key}" not found`);
      }
      const memory = results[0]?.memory;
      if (!memory) {
        throw new Error(`Memory with key "${key}" not found`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(memory) }],
      };
    }

    // If no key, use recall to search
    const results = await memoryManager.recall(args);
    return {
      content: [{ type: "text", text: JSON.stringify(results) }],
    };
  }

  private async handleSearch(args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
  }> {
    const sessionId = this.currentSessionId ?? (args.sessionId as SessionId);
    if (!sessionId) {
      throw new Error("No active session");
    }

    const memoryManager = this.getMemoryManager(sessionId);
    const results = await memoryManager.recall(args);

    return {
      content: [{ type: "text", text: JSON.stringify(results) }],
    };
  }

  private async handleDelete(args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
  }> {
    const sessionId = this.currentSessionId ?? (args.sessionId as SessionId);
    if (!sessionId) {
      throw new Error("No active session");
    }

    const memoryManager = this.getMemoryManager(sessionId);
    const key = args.key as string;

    await memoryManager.delete(key);

    return {
      content: [{ type: "text", text: "Memory deleted successfully" }],
    };
  }

  private async handleCheckpoint(args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
  }> {
    const sessionId = this.currentSessionId ?? (args.sessionId as SessionId);
    if (!sessionId) {
      throw new Error("No active session");
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
      args.description as string
    );

    return {
      content: [{ type: "text", text: "Checkpoint created" }],
    };
  }

  // ============================================================================
  // Utilities
  // ============================================================================

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
   * Handle incoming HTTP requests (both GET and POST)
   */
  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown
  ): Promise<void> {
    // Add CORS headers
    this.addCorsHeaders(res);

    // Handle preflight OPTIONS request
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Validate API key if configured
    if (this.config.apiKey) {
      const apiKey = req.headers["x-api-key"] as string;
      if (apiKey !== this.config.apiKey) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized", message: "Invalid API key" }));
        return;
      }
    }

    try {
      // Delegate to transport
      await this.transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      console.error("[SSE Server] Request handling error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Internal Server Error",
            message: error instanceof Error ? error.message : "Unknown error",
          })
        );
      }
    }
  }

  /**
   * Add CORS headers to response
   */
  private addCorsHeaders(res: ServerResponse): void {
    const cors = this.config.cors ?? { origin: "*" };
    const origins = Array.isArray(cors.origin) ? cors.origin : [cors.origin ?? "*"];

    res.setHeader("Access-Control-Allow-Origin", origins.join(", "));
    res.setHeader("Access-Control-Allow-Methods", (cors.methods ?? ["GET", "POST", "OPTIONS"]).join(", "));
    res.setHeader(
      "Access-Control-Allow-Headers",
      (cors.headers ?? ["Content-Type", "X-API-Key", "X-Session-ID"]).join(", ")
    );
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  /**
   * Start the SSE server
   *
   * Note: StreamableHTTPServerTransport doesn't need to be started manually.
   * It handles connections per-request. The start() method is a no-op.
   */
  async start(): Promise<void> {
    // Transport doesn't need explicit start for StreamableHTTP
    // It manages connections per-request
    console.log("[SSE Server] Ready (waiting for HTTP requests)");
  }

  /**
   * Stop the SSE server
   */
  async stop(): Promise<void> {
    await this.transport.close();
    await this.eventStore.close();
    console.log("[SSE Server] Stopped");
  }

  /**
   * Get the current session ID (if in stateful mode)
   */
  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  /**
   * Get the underlying MCP server instance
   */
  getMcpServer(): Server {
    return this.server;
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
 * Create a default SSE server configuration
 */
export function createDefaultSSEConfig(
  overrides?: Partial<SSEServerConfig>
): SSEServerConfig {
  return {
    port: 3000,
    host: "0.0.0.0",
    transport: "streamable-http",
    cors: {
      origin: "*",
      methods: ["GET", "POST", "OPTIONS"],
      headers: ["Content-Type", "X-API-Key", "X-Session-ID"],
    },
    ...overrides,
  };
}
