/**
 * SSE (Server-Sent Events) Transport for ping-mem
 *
 * Provides MCP protocol over HTTP using StreamableHTTPServerTransport.
 * Supports concurrent client sessions with isolation — each client
 * (Claude Code, Codex, Cursor, etc.) gets its own transport instance
 * keyed by Mcp-Session-Id header.
 *
 * Session lifecycle:
 * - Creation: POST without Mcp-Session-Id → new transport + session
 * - Routing: POST/GET with Mcp-Session-Id → existing transport
 * - Cleanup: DELETE with Mcp-Session-Id → close transport + remove session
 *
 * @module http/sse-server
 * @version 2.0.0
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as crypto from "crypto";
import { createLogger } from "../util/logger.js";
import { timingSafeStringEqual } from "../util/auth-utils.js";
import { SessionRegistry } from "../mcp/SessionRegistry.js";

const log = createLogger("SSE Server");

import { PingMemServer } from "../mcp/PingMemServer.js";

import type { SSEServerConfig } from "./types.js";
import type { PingMemServerConfig } from "../mcp/PingMemServer.js";
import { TOOLS } from "../mcp/PingMemServer.js";

/** Per-session transport + server pair */
interface SessionTransport {
  server: Server;
  transport: StreamableHTTPServerTransport;
}

// ============================================================================
// SSE Server Class
// ============================================================================

/**
 * Multi-client MCP server for ping-mem
 *
 * Each concurrent client gets an isolated StreamableHTTPServerTransport
 * instance keyed by Mcp-Session-Id header. Supports up to maxSessions
 * concurrent clients (default 20) with 1-hour TTL.
 */
export class SSEPingMemServer {
  private readonly transports = new Map<string, SessionTransport>();
  private readonly sessionRegistry: SessionRegistry;
  private readonly config: SSEServerConfig & PingMemServerConfig;

  // Delegate tool execution to PingMemServer (shared across sessions)
  private readonly toolServer: PingMemServer;

  constructor(config: SSEServerConfig & PingMemServerConfig) {
    this.config = {
      dbPath: ":memory:",
      enableVectorSearch: false,
      vectorDimensions: 768,
      ...config,
    };

    this.toolServer = new PingMemServer({
      dbPath: this.config.dbPath,
      enableVectorSearch: this.config.enableVectorSearch,
      vectorDimensions: this.config.vectorDimensions,
      graphManager: config.graphManager,
      hybridSearchEngine: config.hybridSearchEngine,
      lineageEngine: config.lineageEngine,
      evolutionEngine: config.evolutionEngine,
      ingestionService: config.ingestionService,
      diagnosticsStore: config.diagnosticsStore,
      diagnosticsDbPath: config.diagnosticsDbPath,
      eventStore: config.eventStore,
      qdrantClient: config.qdrantClient,
    });

    this.sessionRegistry = new SessionRegistry({
      maxSessions: config.maxSessions ?? 20,
      ttlMs: config.sessionTtlMs ?? 3_600_000,
      sessionIdGenerator: config.sessionIdGenerator ?? (() => crypto.randomUUID()),
    });
  }

  /**
   * Create a new MCP server + transport pair for a session.
   */
  private createSessionTransport(sessionId: string): SessionTransport {
    const server = new Server(
      {
        name: "ping-mem-sse-server",
        version: "2.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
    });

    // Set up MCP tool handlers
    this.setupHandlers(server);

    // Connect server to transport
    server.connect(transport as Parameters<typeof server.connect>[0]);

    const st: SessionTransport = { server, transport };
    this.transports.set(sessionId, st);
    return st;
  }

  /**
   * Set up MCP request handlers on a server instance
   */
  private setupHandlers(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: TOOLS,
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        if (name === "ping") {
          return { content: [{ type: "text", text: "pong" }] };
        }

        const result = await this.toolServer.dispatchToolCall(name, args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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

  /**
   * Handle incoming HTTP requests with session routing.
   *
   * - No Mcp-Session-Id header → create new session + transport
   * - With Mcp-Session-Id header → route to existing transport
   * - DELETE method → close session and transport
   */
  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown
  ): Promise<void> {
    // Add CORS headers
    this.addCorsHeaders(req, res);

    // Handle preflight OPTIONS request
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Validate API key if configured
    if (!this.validateAuth(req, res)) {
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      // DELETE — close and remove session
      if (req.method === "DELETE") {
        if (sessionId) {
          await this.closeSession(sessionId);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Route to existing session or create new one
      let st: SessionTransport | undefined;

      if (sessionId) {
        // Look up existing session
        const session = this.sessionRegistry.get(sessionId);
        if (!session) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: "Session Not Found",
            message: `No active session with ID ${sessionId}. Create a new session by sending a request without Mcp-Session-Id header.`,
          }));
          return;
        }
        st = this.transports.get(sessionId);
      }

      if (!st) {
        // Create new session
        const clientName = SessionRegistry.detectClient(
          req.headers["user-agent"],
          req.headers["x-client-name"] as string | undefined,
        );
        const session = this.sessionRegistry.create(clientName);
        if (!session) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: "Service Unavailable",
            message: "Maximum concurrent sessions reached. Try again later.",
          }));
          return;
        }
        st = this.createSessionTransport(session.sessionId);
        log.info("New session transport created", {
          sessionId: session.sessionId,
          client: clientName,
        });
      }

      // Delegate to the session's transport
      await st.transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      log.error("Request handling error", { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Internal Server Error",
            message: "An unexpected error occurred",
          })
        );
      }
    }
  }

  /**
   * Validate API key authentication. Returns true if valid (or auth not required).
   */
  private validateAuth(req: IncomingMessage, res: ServerResponse): boolean {
    const authRequired = this.config.apiKeyManager
      ? this.config.apiKeyManager.hasSeedKey()
      : (this.config.apiKey && this.config.apiKey.trim().length > 0);

    if (!authRequired) {
      return true;
    }

    let apiKey = req.headers["x-api-key"] as string | undefined;
    if (!apiKey) {
      const authHeader = req.headers["authorization"] as string | undefined;
      if (authHeader?.startsWith("Bearer ")) {
        apiKey = authHeader.slice(7);
      }
    }

    const isValid = this.config.apiKeyManager
      ? this.config.apiKeyManager.isValid(apiKey)
      : (this.config.apiKey ? timingSafeStringEqual(apiKey ?? "", this.config.apiKey) : false);

    if (!isValid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "Unauthorized",
        message: "Invalid or missing API key. Use X-API-Key header or Authorization: Bearer <token>.",
      }));
      return false;
    }

    return true;
  }

  /**
   * Close a session and its transport.
   */
  private async closeSession(sessionId: string): Promise<void> {
    const st = this.transports.get(sessionId);
    if (st) {
      try {
        await st.transport.close();
      } catch (error) {
        log.warn("Error closing transport", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.transports.delete(sessionId);
    }
    this.sessionRegistry.remove(sessionId);
    log.info("Session closed", { sessionId });
  }

  /**
   * Add CORS headers to response
   */
  private addCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
    const envOrigin = process.env.PING_MEM_CORS_ORIGIN;
    const defaultOrigin = envOrigin ? envOrigin.split(",").map(s => s.trim()) : [];
    const corsConfig = this.config.cors ?? { origin: defaultOrigin };
    const resolvedOrigin = corsConfig.origin ?? defaultOrigin;
    const origins = Array.isArray(resolvedOrigin) ? resolvedOrigin : [resolvedOrigin];

    // Only set CORS headers if origins are configured
    if (origins.length === 0 || origins[0] === "") return;

    const requestOrigin = req.headers.origin;
    if (requestOrigin && origins.includes(requestOrigin)) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }

    res.setHeader("Access-Control-Allow-Methods", (corsConfig.methods ?? ["GET", "POST", "DELETE", "OPTIONS"]).join(", "));
    res.setHeader(
      "Access-Control-Allow-Headers",
      (corsConfig.headers ?? ["Content-Type", "X-API-Key", "X-Session-ID", "Mcp-Session-Id", "Authorization"]).join(", ")
    );
  }

  /**
   * Start the SSE server
   */
  async start(): Promise<void> {
    log.info("Ready (waiting for HTTP requests, multi-session enabled)");
  }

  /**
   * Stop the SSE server — closes all sessions
   */
  async stop(): Promise<void> {
    const sessions = this.sessionRegistry.list();
    for (const session of sessions) {
      await this.closeSession(session.sessionId);
    }
    await this.toolServer.close();
    log.info("Stopped");
  }

  /**
   * Get the session registry (for inspection/admin endpoints)
   */
  getSessionRegistry(): SessionRegistry {
    return this.sessionRegistry;
  }

  /**
   * Get the underlying tool server instance
   */
  getToolServer(): PingMemServer {
    return this.toolServer;
  }

  /**
   * Get transport for a specific session (for testing)
   */
  getSessionTransport(sessionId: string): SessionTransport | undefined {
    return this.transports.get(sessionId);
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
      origin: process.env.PING_MEM_CORS_ORIGIN
        ? process.env.PING_MEM_CORS_ORIGIN.split(",").map(s => s.trim())
        : [],
      methods: ["GET", "POST", "OPTIONS"],
      headers: ["Content-Type", "X-API-Key", "X-Session-ID"],
    },
    ...overrides,
  };
}
