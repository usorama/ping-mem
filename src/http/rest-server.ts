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
import * as path from "path";

import { SessionManager } from "../session/SessionManager.js";
import { MemoryManager, type MemoryManagerConfig } from "../memory/MemoryManager.js";
import { EventStore } from "../storage/EventStore.js";
import { VectorIndex, createInMemoryVectorIndex } from "../search/VectorIndex.js";
import type { GraphManager } from "../graph/GraphManager.js";
import type { HybridSearchEngine } from "../search/HybridSearchEngine.js";
import {
  DiagnosticsStore,
  parseSarif,
  normalizeFindings,
  computeFindingsDigest,
  computeAnalysisId,
  SummaryGenerator,
  OpenAIProvider,
  SummaryCache,
} from "../diagnostics/index.js";
import type { FindingInput } from "../diagnostics/types.js";
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
  private diagnosticsStore: DiagnosticsStore;
  private summaryGenerator: SummaryGenerator | null = null;

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
    this.diagnosticsStore =
      this.config.diagnosticsStore ??
      new DiagnosticsStore({
        dbPath: this.config.diagnosticsDbPath,
      });

    // Initialize LLM summary generator only when explicitly enabled
    const openaiKey = process.env.OPENAI_API_KEY;
    const enableLLMSummaries = process.env.PING_MEM_ENABLE_LLM_SUMMARIES === "true";
    if (enableLLMSummaries && openaiKey) {
      const summaryCache = new SummaryCache({ db: this.diagnosticsStore.getDatabase() });
      const provider = new OpenAIProvider(openaiKey);
      this.summaryGenerator = new SummaryGenerator(provider, summaryCache);
    }

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
    // Auth is required only when: (apiKeyManager has seed key) OR (explicit apiKey is set non-empty)
    const authRequired = this.config.apiKeyManager
      ? this.config.apiKeyManager.hasSeedKey()
      : (this.config.apiKey && this.config.apiKey.trim().length > 0);

    if (authRequired) {
      this.app.use("/api/*", async (c, next) => {
        const apiKey = c.req.header("x-api-key");
        const isValid = this.config.apiKeyManager
          ? this.config.apiKeyManager.isValid(apiKey ?? undefined)
          : apiKey === this.config.apiKey;
        if (!isValid) {
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
      // Auth is required for health check only when keys are configured
      const authRequired = this.config.apiKeyManager
        ? this.config.apiKeyManager.hasSeedKey()
        : (this.config.apiKey && this.config.apiKey.trim().length > 0);

      if (authRequired) {
        const apiKey = c.req.header("x-api-key");
        const isValid = this.config.apiKeyManager
          ? this.config.apiKeyManager.isValid(apiKey ?? undefined)
          : apiKey === this.config.apiKey;
        if (!isValid) {
          return c.json(
            { error: "Unauthorized", message: "Invalid API key" },
            401
          );
        }
      }
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

        // Hydrate memory state from event store
        await memoryManager.hydrate();

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
        if (body.createdAt !== undefined) options.createdAt = new Date(body.createdAt);
        if (body.updatedAt !== undefined) options.updatedAt = new Date(body.updatedAt);

        await memoryManager.save(body.key, body.value, options);

        return c.json<RESTSuccessResponse<{ message: string }>>({
          data: { message: "Memory saved successfully" },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Diagnostics Operations
    // ============================================================================

    this.app.post("/api/v1/diagnostics/ingest", async (c) => {
      try {
        const body = await c.req.json();

        const projectId = body.projectId as string | undefined;
        const treeHash = body.treeHash as string | undefined;
        const configHash = body.configHash as string | undefined;
        if (!projectId || !treeHash || !configHash) {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "projectId, treeHash, and configHash are required",
            },
            400
          );
        }

        const commitHash = body.commitHash as string | undefined;
        const environmentHash = body.environmentHash as string | undefined;
        const status =
          (body.status as "passed" | "failed" | "partial" | undefined) ?? "failed";
        const durationMs = body.durationMs as number | undefined;
        const metadata = (body.metadata as Record<string, unknown> | undefined) ?? {};

        let findings: FindingInput[] = [];
        let toolName = body.toolName as string | undefined;
        let toolVersion = body.toolVersion as string | undefined;
        let rawSarif: string | undefined;

        if (body.sarif !== undefined) {
          const sarifPayload = typeof body.sarif === "string" ? JSON.parse(body.sarif) : body.sarif;
          const parsed = parseSarif(sarifPayload);
          findings = parsed.findings;
          toolName = toolName ?? parsed.toolName;
          toolVersion = toolVersion ?? parsed.toolVersion;
          rawSarif = typeof body.sarif === "string" ? body.sarif : JSON.stringify(body.sarif);
        } else if (Array.isArray(body.findings)) {
          findings = body.findings as FindingInput[];
        } else {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "Diagnostics ingest requires sarif or findings",
            },
            400
          );
        }

        if (!toolName || !toolVersion) {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "toolName and toolVersion are required (or must be in SARIF)",
            },
            400
          );
        }

        const tempFindings = normalizeFindings(findings, "temp-analysis");
        const findingsDigest = computeFindingsDigest(tempFindings);
        const analysisId = computeAnalysisId({
          projectId,
          treeHash,
          toolName,
          toolVersion,
          configHash,
          findingsDigest,
        });

        const normalizedFindings = normalizeFindings(findings, analysisId);
        const runId = this.diagnosticsStore.createRunId();

        this.diagnosticsStore.saveRun(
          {
            runId,
            analysisId,
            projectId,
            treeHash,
            commitHash,
            tool: { name: toolName, version: toolVersion },
            configHash,
            environmentHash,
            status,
            createdAt: new Date().toISOString(),
            durationMs,
            findingsDigest,
            rawSarif,
            metadata,
          },
          normalizedFindings
        );

        return c.json<RESTSuccessResponse<Record<string, unknown>>>({
          data: {
            success: true,
            runId,
            analysisId,
            findingsCount: normalizedFindings.length,
            toolName,
            toolVersion,
            treeHash,
          },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Codebase Ingestion (requires IngestionService)
    // ============================================================================

    this.app.post("/api/v1/codebase/ingest", async (c) => {
      if (!this.config.ingestionService) {
        return c.json(
          { error: "ServiceUnavailable", message: "Ingestion service not configured" },
          503
        );
      }

      const body = await c.req.json();
      const rawProjectDir = body.projectDir as string | undefined;
      const projectDir = rawProjectDir ? path.resolve(rawProjectDir) : undefined;
      if (!projectDir) {
        return c.json({ error: "BadRequest", message: "projectDir is required" }, 400);
      }
      const forceReingest = body.forceReingest === true;

      const result = await this.config.ingestionService.ingestProject({
        projectDir,
        forceReingest,
      });

      if (result) {
        if (this.config.adminStore) {
          this.config.adminStore.upsertProject({
            projectId: result.projectId,
            projectDir,
            treeHash: result.treeHash,
            lastIngestedAt: result.ingestedAt,
          });
        }
        return c.json({ data: result });
      }

      const verify = await this.config.ingestionService.verifyProject(projectDir);
      if (verify.projectId && this.config.adminStore) {
        this.config.adminStore.upsertProject({
          projectId: verify.projectId,
          projectDir,
          treeHash: verify.currentTreeHash ?? undefined,
          lastIngestedAt: new Date().toISOString(),
        });
      }

      return c.json({
        data: {
          projectId: verify.projectId,
          treeHash: verify.currentTreeHash,
          filesIndexed: 0,
          chunksIndexed: 0,
          commitsIndexed: 0,
          ingestedAt: new Date().toISOString(),
          hadChanges: false,
        },
      });
    });

    this.app.post("/api/v1/codebase/verify", async (c) => {
      if (!this.config.ingestionService) {
        return c.json(
          { error: "ServiceUnavailable", message: "Ingestion service not configured" },
          503
        );
      }
      const body = await c.req.json();
      const rawProjectDir = body.projectDir as string | undefined;
      const projectDir = rawProjectDir ? path.resolve(rawProjectDir) : undefined;
      if (!projectDir) {
        return c.json({ error: "BadRequest", message: "projectDir is required" }, 400);
      }
      const result = await this.config.ingestionService.verifyProject(projectDir);
      return c.json({ data: result });
    });

    this.app.get("/api/v1/codebase/search", async (c) => {
      if (!this.config.ingestionService) {
        return c.json(
          { error: "ServiceUnavailable", message: "Ingestion service not configured" },
          503
        );
      }
      const query = c.req.query("query");
      if (!query) {
        return c.json({ error: "BadRequest", message: "query is required" }, 400);
      }
      const projectId = c.req.query("projectId");
      const filePath = c.req.query("filePath");
      const type = c.req.query("type") as "code" | "comment" | "docstring" | undefined;
      const limit = c.req.query("limit") ? parseInt(c.req.query("limit") as string, 10) : undefined;
      const searchOptions: {
        projectId?: string;
        filePath?: string;
        type?: "code" | "comment" | "docstring";
        limit?: number;
      } = {};
      if (projectId) searchOptions.projectId = projectId;
      if (filePath) searchOptions.filePath = filePath;
      if (type) searchOptions.type = type;
      if (limit !== undefined) searchOptions.limit = limit;

      const results = await this.config.ingestionService.searchCode(query, searchOptions);
      return c.json({ data: { count: results.length, results } });
    });

    this.app.get("/api/v1/codebase/timeline", async (c) => {
      if (!this.config.ingestionService) {
        return c.json(
          { error: "ServiceUnavailable", message: "Ingestion service not configured" },
          503
        );
      }
      const projectId = c.req.query("projectId");
      if (!projectId) {
        return c.json({ error: "BadRequest", message: "projectId is required" }, 400);
      }
      const filePath = c.req.query("filePath") ?? undefined;
      const limit = c.req.query("limit") ? parseInt(c.req.query("limit") as string, 10) : undefined;
      const timelineOptions: { projectId: string; filePath?: string; limit?: number } = {
        projectId,
      };
      if (filePath) timelineOptions.filePath = filePath;
      if (limit !== undefined) timelineOptions.limit = limit;

      const results = await this.config.ingestionService.queryTimeline(timelineOptions);
      return c.json({ data: results });
    });

    this.app.get("/api/v1/diagnostics/latest", async (c) => {
      try {
        const projectId = c.req.query("projectId");
        if (!projectId) {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "projectId is required",
            },
            400
          );
        }

        const run = this.diagnosticsStore.getLatestRun({
          projectId,
          toolName: c.req.query("toolName") ?? undefined,
          toolVersion: c.req.query("toolVersion") ?? undefined,
          treeHash: c.req.query("treeHash") ?? undefined,
        });

        return c.json<RESTSuccessResponse<Record<string, unknown>>>({
          data: run ? { found: true, run } : { found: false },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/diagnostics/findings/:analysisId", async (c) => {
      try {
        const analysisId = c.req.param("analysisId");
        const findings = this.diagnosticsStore.listFindings(analysisId);
        return c.json<RESTSuccessResponse<Record<string, unknown>>>({
          data: { analysisId, count: findings.length, findings },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.post("/api/v1/diagnostics/diff", async (c) => {
      try {
        const body = await c.req.json();
        const analysisIdA = body.analysisIdA as string | undefined;
        const analysisIdB = body.analysisIdB as string | undefined;
        if (!analysisIdA || !analysisIdB) {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "analysisIdA and analysisIdB are required",
            },
            400
          );
        }

        const diff = this.diagnosticsStore.diffAnalyses(analysisIdA, analysisIdB);
        return c.json<RESTSuccessResponse<Record<string, unknown>>>({
          data: { analysisIdA, analysisIdB, ...diff },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/diagnostics/summary/:analysisId", async (c) => {
      try {
        const analysisId = c.req.param("analysisId");
        const findings = this.diagnosticsStore.listFindings(analysisId);
        const bySeverity: Record<string, number> = {};
        for (const finding of findings) {
          bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
        }

        return c.json<RESTSuccessResponse<Record<string, unknown>>>({
          data: {
            analysisId,
            total: findings.length,
            bySeverity,
          },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.post("/api/v1/diagnostics/summarize/:analysisId", async (c) => {
      try {
        const analysisId = c.req.param("analysisId");
        const body = await c.req.json();
        const useLLM = body.useLLM === true;
        const forceRefresh = body.forceRefresh === true;

        const findings = this.diagnosticsStore.listFindings(analysisId);

        if (!useLLM) {
          return c.json<RESTSuccessResponse<Record<string, unknown>>>({
            data: {
              analysisId,
              useLLM: false,
              total: findings.length,
              findings: findings.slice(0, 100),
            },
          });
        }

        if (!this.summaryGenerator) {
          return c.json<RESTErrorResponse>(
            {
              error: "Service Unavailable",
              message: "LLM summarization not available. Set OPENAI_API_KEY environment variable.",
            },
            503
          );
        }

        const summary = await this.summaryGenerator.summarize(analysisId, findings, forceRefresh);

        return c.json<RESTSuccessResponse<Record<string, unknown>>>({
          data: {
            analysisId,
            useLLM: true,
            summary: {
              text: summary.summaryText,
              model: summary.llmModel,
              provider: summary.llmProvider,
              generatedAt: summary.generatedAt,
              promptTokens: summary.promptTokens,
              completionTokens: summary.completionTokens,
              costUsd: summary.costUsd,
              isFromCache: summary.isFromCache,
            },
            findingsCount: findings.length,
          },
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
