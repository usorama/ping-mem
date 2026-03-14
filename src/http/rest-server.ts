/**
 * REST API Server for ping-mem
 *
 * Provides a simple REST API for accessing ping-mem functionality
 * without requiring MCP protocol overhead.
 *
 * @module http/rest-server
 * @version 1.4.0
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import * as crypto from "node:crypto";
import { timingSafeStringEqual } from "../util/auth-utils.js";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import * as path from "path";
import * as fs from "fs";
import { createLogger } from "../util/logger.js";
import { isProjectDirSafe } from "../util/path-safety.js";

const log = createLogger("REST Server");

import { SessionManager } from "../session/SessionManager.js";
import { MemoryManager, type MemoryManagerConfig } from "../memory/MemoryManager.js";
import { EventStore } from "../storage/EventStore.js";
import { type VectorIndex, createInMemoryVectorIndex } from "../search/VectorIndex.js";
import { RelevanceEngine } from "../memory/RelevanceEngine.js";
import type { GraphManager } from "../graph/GraphManager.js";
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
import {
  createAgentId,
  type SessionId,
  type MemoryCategory,
  type MemoryPriority,
} from "../types/index.js";

import type {
  HTTPServerConfig,
  RESTErrorResponse,
  RESTSuccessResponse,
} from "./types.js";
import type { PingMemServerConfig } from "../mcp/PingMemServer.js";
import { MemoryPubSub } from "../pubsub/index.js";

/** Maximum number of cached MemoryManager instances before LRU eviction */
const MAX_MEMORY_MANAGERS = 200;
import { registerUIRoutes } from "./ui/routes.js";
import { csrfProtection } from "./middleware/csrf.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { probeSystemHealth } from "../observability/health-probes.js";
import type { HealthMonitor } from "../observability/HealthMonitor.js";
import {
  SessionStartSchema,
  ContextSaveSchema,
  CheckpointSchema,
  CodebaseIngestSchema,
  CodebaseVerifySchema,
  DiagnosticsDiffSchema,
  DiagnosticsSummarizeSchema,
  MemoryConsolidateSchema,
  AgentRegisterSchema,
  KnowledgeSearchSchema,
  KnowledgeIngestSchema,
} from "../validation/api-schemas.js";
import { diagnosticsIngestBaseSchema } from "../validation/diagnostics-schemas.js";
import { KnowledgeStore } from "../knowledge/index.js";
import type { QdrantClientWrapper } from "../search/QdrantClient.js";

// ============================================================================
// REST Server Class
// ============================================================================

/**
 * REST API server for ping-mem
 *
 * Provides HTTP endpoints for memory operations without requiring
 * full MCP protocol implementation.
 */

export type AppEnv = {
  Variables: {
    cspNonce: string;
    csrfToken: string;
  };
};

export class RESTPingMemServer {
  private app: Hono<AppEnv>;
  private config: HTTPServerConfig & PingMemServerConfig;

  // Core components (same as PingMemServer)
  private eventStore: EventStore;
  private sessionManager: SessionManager;
  private vectorIndex: VectorIndex | null = null;
  private memoryManagers: Map<SessionId, MemoryManager> = new Map();
  private managerPromises: Map<string, Promise<MemoryManager>> = new Map();
  private currentSessionId: SessionId | null = null;
  private graphManager: GraphManager | null = null;
  private diagnosticsStore: DiagnosticsStore;
  private summaryGenerator: SummaryGenerator | null = null;
  private relevanceEngine: RelevanceEngine;
  private pubsub: MemoryPubSub;
  private knowledgeStore: KnowledgeStore;
  private qdrantClient: QdrantClientWrapper | null = null;
  private healthMonitor: HealthMonitor | null = null;
  private readonly ownsEventStore: boolean;
  private readonly ownsDiagnosticsStore: boolean;
  private sseConnectionCount = 0;
  private static readonly MAX_SSE_CONNECTIONS = 100;

  constructor(config: HTTPServerConfig & PingMemServerConfig) {
    this.config = {
      dbPath: ":memory:",
      enableVectorSearch: false,
      vectorDimensions: 768,
      ...config,
    };

    // Initialize core components — use shared EventStore if provided (avoids dual SQLite connections)
    const injectedEventStore = this.config.eventStore;
    this.ownsEventStore = injectedEventStore === undefined;
    this.eventStore = injectedEventStore ?? new EventStore({ dbPath: this.config.dbPath ?? ":memory:" });
    this.sessionManager = new SessionManager({ eventStore: this.eventStore });
    this.relevanceEngine = new RelevanceEngine(this.eventStore.getDatabase());
    this.pubsub = new MemoryPubSub();
    this.knowledgeStore = new KnowledgeStore(this.eventStore.getDatabase());
    this.ownsDiagnosticsStore = !this.config.diagnosticsStore;
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
    if (config.qdrantClient) {
      this.qdrantClient = config.qdrantClient;
    }
    if (config.healthMonitor) {
      this.healthMonitor = config.healthMonitor;
    }

    // Validate PING_MEM_STATIC_DIR at startup — catch misconfigurations early so
    // operators see a warning in logs rather than silent 404s on all static requests.
    const staticDirEnv = process.env.PING_MEM_STATIC_DIR;
    if (staticDirEnv !== undefined) {
      const safeStaticDirLog = staticDirEnv.replace(/[\x00-\x1f]/g, "?").slice(0, 200);
      if (staticDirEnv.includes("\0") || !path.isAbsolute(staticDirEnv)) {
        log.warn("PING_MEM_STATIC_DIR is not a valid absolute path — falling back to src/static", { value: safeStaticDirLog });
      } else if (!fs.existsSync(staticDirEnv)) {
        log.warn("PING_MEM_STATIC_DIR directory does not exist — static file requests will return 404", { value: safeStaticDirLog });
      }
    }

    // Initialize Hono app
    this.app = new Hono<AppEnv>();

    // Set up middleware
    this.setupMiddleware();

    // Set up routes
    this.setupRoutes();
  }

  /**
   * Set up Hono middleware
   */
  private setupMiddleware(): void {
    // CORS - default to denying cross-origin requests unless explicitly configured.
    // When no origins are configured, the cors middleware is not installed so the
    // browser's same-origin policy applies naturally (no ACAO header = denied).
    const envOrigin = process.env.PING_MEM_CORS_ORIGIN;
    const rawOrigins = envOrigin ? envOrigin.split(",").map(s => s.trim()) : [];
    // Reject wildcard '*' — permissive CORS disables CSRF protection for all API routes.
    const wildcardCount = rawOrigins.filter(o => o === "*").length;
    if (wildcardCount > 0) {
      log.warn("PING_MEM_CORS_ORIGIN contains wildcard '*' — ignored. Specify explicit origins.");
    }
    const defaultOrigin = rawOrigins.filter(o => o !== "*" && o.length > 0);
    const corsConfig = this.config.cors;
    const configuredOrigins = corsConfig?.origin ?? defaultOrigin;
    const hasSpecificOrigins =
      (Array.isArray(configuredOrigins) && configuredOrigins.length > 0) ||
      (typeof configuredOrigins === "string" && configuredOrigins.length > 0) ||
      typeof configuredOrigins === "function";
    if (hasSpecificOrigins) {
      this.app.use(
        "*",
        cors({
          origin: configuredOrigins,
          allowMethods: corsConfig?.methods ?? ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
          allowHeaders: corsConfig?.headers ?? ["Content-Type", "X-API-Key", "X-Session-ID", "Authorization"],
          credentials: true,
        })
      );
    }

    // Logger
    this.app.use("*", logger());

    // Security headers — applied to all responses
    // Uses nonce-based CSP to avoid 'unsafe-inline' for scripts
    this.app.use("*", async (c, next) => {
      const nonce = crypto.randomUUID();
      // Store nonce on context for UI renderers to add to inline <script> tags
      c.set("cspNonce", nonce);
      await next();
      c.header("X-Content-Type-Options", "nosniff");
      c.header("X-Frame-Options", "DENY");
      c.header("Referrer-Policy", "strict-origin-when-cross-origin");
      c.header(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
      );
      c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      c.header("Cross-Origin-Opener-Policy", "same-origin");
      c.header("Cross-Origin-Resource-Policy", "same-origin");
      if (process.env["PING_MEM_BEHIND_PROXY"] === "true") {
        c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
      }
    });

    // API Key authentication (if configured)
    // Auth is required only when: (apiKeyManager has seed key) OR (explicit apiKey is set non-empty)
    // Supports both X-API-Key header and Authorization: Bearer <token> header
    // Note: X-API-Key is a non-simple, non-CORS-safelisted custom header that browsers cannot
    // include in cross-origin requests without CORS preflight. This acts as CSRF protection for
    // all /api/v1/* POST/DELETE endpoints without requiring an additional synchronizer token.
    if (this.isAuthRequired()) {
      const authMiddleware = async (c: Parameters<Parameters<typeof this.app.use>[1]>[0], next: () => Promise<void>) => {
        const apiKey = this.extractApiKey(c as unknown as Context<AppEnv>);
        const isValid = this.validateApiKey(apiKey);
        if (!isValid) {
          return c.json(
            {
              error: "Unauthorized",
              message: "Invalid or missing API key. Use X-API-Key header or Authorization: Bearer <token>.",
            },
            401
          );
        }
        return next();
      };
      this.app.use("/api/*", authMiddleware);
      this.app.use("/ui/*", authMiddleware);
    } else {
      log.warn("No API key configured. All routes are unauthenticated.");
    }

    // CSRF protection for browser-based UI routes
    this.app.use("/ui/*", csrfProtection());

    // Rate limit state-changing API endpoints (60 req/min per IP)
    this.app.use("/api/v1/*", rateLimiter({
      name: "api-v1",
      maxRequests: 60,
      windowMs: 60_000,
    }));
  }

  /**
   * Set up REST API routes
   */
  private setupRoutes(): void {
    // Health check — per-component status
    this.app.get("/health", async (c) => {
      // Auth is required for health check only when keys are configured.
      // Uses isAuthRequired() — same policy as the global middleware.
      if (this.isAuthRequired()) {
        if (!this.validateApiKey(this.extractApiKey(c))) {
          return c.json(
            { error: "Unauthorized", message: "Invalid API key" },
            401
          );
        }
      }

      // Lightweight liveness check — only pings SQLite (core dependency).
      // Full dependency probing is at /api/v1/observability/status.
      const alive = await this.eventStore.ping();
      if (alive) {
        return c.json({
          status: "ok",
          timestamp: new Date().toISOString(),
        });
      }
      log.error("Health check failed — SQLite unreachable");
      return c.json({ status: "unhealthy", error: "SQLite unreachable" }, 503);
    });

    this.app.get("/api/v1/observability/status", async (c) => {
      try {
        // Use cached snapshot from health monitor if available (avoids duplicate probes)
        const monitorStatus = this.healthMonitor?.getStatus() ?? null;
        const snapshot = monitorStatus?.lastSnapshot ?? await probeSystemHealth({
          eventStore: this.eventStore,
          ...(this.graphManager ? { graphManager: this.graphManager } : {}),
          ...(this.qdrantClient ? { qdrantClient: this.qdrantClient } : {}),
          diagnosticsStore: this.diagnosticsStore,
          skipIntegrityCheck: true,
        });

        // comp.error was already sanitized at probe origin by sanitizeHealthError().
        // Re-running sanitizeHealthError() here would double-sanitize: "connection refused"
        // (already a safe friendly string) matches no keywords and becomes "service unavailable".
        // Apply only a control-character strip as defense-in-depth.
        const sanitizedSnapshot = {
          ...snapshot,
          components: Object.fromEntries(
            Object.entries(snapshot.components).map(([key, comp]) => [
              key,
              comp.error ? { ...comp, error: comp.error.replace(/[\r\n\t\x00-\x1F\x7F]/g, "") } : comp,
            ])
          ),
        };

        const sanitizedMonitor = monitorStatus ? {
          ...monitorStatus,
          lastSnapshot: monitorStatus.lastSnapshot ? sanitizedSnapshot : null,
          // Alert messages are system-composed (metric names, numbers, static text) and do not
          // contain raw external error text. Apply light sanitization: strip control characters
          // (log-injection defence) and redact IPv4 addresses that may appear in metric values.
          activeAlerts: monitorStatus.activeAlerts.map((alert) => ({
            ...alert,
            message: alert.message
              .replace(/[\r\n\t\x00-\x1F\x7F]/g, "")
              .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "[redacted]"),
          })),
        } : null;

        return c.json({
          data: {
            health: sanitizedSnapshot,
            monitor: sanitizedMonitor,
          },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Session Management
    // ============================================================================

    this.app.post("/api/v1/session/start", async (c) => {
      try {
        let _reqBody0: unknown;
        try { _reqBody0 = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }
        const parseResult = SessionStartSchema.safeParse(_reqBody0);
        if (!parseResult.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }
        const body = parseResult.data;
        if (body.projectDir !== undefined && !isProjectDirSafe(body.projectDir)) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "projectDir must be within an allowed root" },
            400
          );
        }
        const session = await this.sessionManager.startSession({
          name: body.name,
          ...(body.projectDir !== undefined ? { projectDir: body.projectDir } : {}),
          ...(body.continueFrom !== undefined ? { continueFrom: body.continueFrom } : {}),
          ...(body.defaultChannel !== undefined ? { defaultChannel: body.defaultChannel } : {}),
        });

        this.currentSessionId = session.id;

        // Create MemoryManager for this session
        const memoryConfig: MemoryManagerConfig = {
          eventStore: this.eventStore,
          sessionId: session.id,
          pubsub: this.pubsub,
        };

        if (this.vectorIndex) {
          memoryConfig.vectorIndex = this.vectorIndex;
        }

        const memoryManager = new MemoryManager(memoryConfig);

        // Hydrate memory state from event store
        await memoryManager.hydrate();

        this.memoryManagers.set(session.id, memoryManager);

        return c.json({
          data: { ...session, sessionId: session.id },
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

        const endingSessionId = this.currentSessionId;
        await this.sessionManager.endSession(endingSessionId);
        // Evict cached MemoryManager for ended session to prevent unbounded map growth
        this.memoryManagers.delete(endingSessionId);
        this.managerPromises.delete(endingSessionId);
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
        const rawLimit = parseInt(c.req.query("limit") ?? "10", 10);
        const limit = Number.isNaN(rawLimit) ? 10 : Math.min(Math.max(rawLimit, 1), 1000);
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
        let _reqBody1: unknown;
        try { _reqBody1 = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }
        const parseResult = ContextSaveSchema.safeParse(_reqBody1);
        if (!parseResult.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }
        const body = parseResult.data;
        const sessionId = this.getSessionIdFromRequest(c);

        if (!sessionId) {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "No active session. Call /api/v1/session/start first.",
            },
            400
          );
        }

        const memoryManager = await this.getMemoryManager(sessionId);

        // Build options, excluding undefined values
        const options: Record<string, unknown> = {};
        if (body.category !== undefined) options.category = body.category;
        if (body.priority !== undefined) options.priority = body.priority;
        if (body.channel !== undefined) options.channel = body.channel;
        if (body.metadata !== undefined) options.metadata = body.metadata;
        if (body.createdAt !== undefined) options.createdAt = new Date(body.createdAt);
        if (body.updatedAt !== undefined) options.updatedAt = new Date(body.updatedAt);

        const savedMemory = await memoryManager.save(body.key, body.value, options);

        // Update session memory count (sessionId verified non-null above)
        await this.sessionManager.incrementMemoryCount(sessionId);

        // Track relevance for the new memory
        this.relevanceEngine.ensureTracking(
          savedMemory.id,
          savedMemory.priority,
          savedMemory.category
        );

        // Proactive recall: surface related memories from other sessions
        let relatedMemories: Array<{
          key: string;
          value: string;
          category: string;
          relevance: number;
          sessionId: string;
        }> = [];

        if (body.skipProactiveRecall !== true) {
          try {
            const findOpts: { excludeKeys?: string[]; limit?: number; excludeSessionId?: string } = {
              excludeKeys: [body.key],
              limit: 5,
            };
            findOpts.excludeSessionId = sessionId;

            // Cross-session search with 200ms timeout
            const recallPromise = new Promise<typeof relatedMemories>((resolve) => {
              const crossSession = memoryManager.findRelatedAcrossSessions(
                body.value,
                findOpts
              );
              const withRelevance = crossSession
                .filter((r) => {
                  const tracking = this.relevanceEngine.getRelevanceScore(r.memory.id);
                  return tracking >= 0.5 || r.score > 0.3;
                })
                .map((r) => ({
                  key: r.memory.key,
                  value: r.memory.value.length > 200 ? r.memory.value.substring(0, 200) + "..." : r.memory.value,
                  category: r.memory.category ?? "note",
                  relevance: r.score,
                  sessionId: String(r.memory.sessionId),
                }));
              resolve(withRelevance);
            });
            const timeout = new Promise<typeof relatedMemories>((resolve) =>
              setTimeout(() => resolve([]), 200)
            );
            relatedMemories = await Promise.race([recallPromise, timeout]);
          } catch (error) {
            // Best-effort: don't block save
            log.warn("Proactive recall failed", { error: error instanceof Error ? error.message : String(error) });
          }
        }

        const result: Record<string, unknown> = { message: "Memory saved successfully" };
        if (relatedMemories.length > 0) {
          result.relatedMemories = relatedMemories;
        }

        return c.json<RESTSuccessResponse<Record<string, unknown>>>({
          data: result,
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
        let rawBody: unknown;
        try { rawBody = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }

        // Validate request body with Zod schema
        const parseResult = diagnosticsIngestBaseSchema.safeParse(rawBody);
        if (!parseResult.success) {
          const messages = parseResult.error.issues.map(
            (i) => `${i.path.join(".")}: ${i.message}`
          );
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: messages.join("; "),
            },
            400
          );
        }

        const body = parseResult.data;
        const {
          projectId,
          treeHash,
          configHash,
          commitHash,
          environmentHash,
          status,
          durationMs,
        } = body;
        const metadata = body.metadata ?? {};

        let findings: FindingInput[] = [];
        let toolName = body.toolName;
        let toolVersion = body.toolVersion;
        let rawSarif: string | undefined;

        if (body.sarif !== undefined) {
          let sarifPayload: unknown;
          try {
            sarifPayload = typeof body.sarif === "string" ? JSON.parse(body.sarif) : body.sarif;
          } catch (err) {
            log.warn("SARIF parse error", { error: err instanceof Error ? err.message : String(err) });
            return c.json<RESTErrorResponse>(
              { error: "Bad Request", message: "Invalid JSON in sarif field" },
              400
            );
          }
          const parsed = parseSarif(sarifPayload);
          findings = parsed.findings;
          toolName = toolName ?? parsed.toolName;
          toolVersion = toolVersion ?? parsed.toolVersion;
          rawSarif = typeof body.sarif === "string" ? body.sarif : JSON.stringify(body.sarif);
        } else if (Array.isArray(body.findings)) {
          // The Zod findingSchema validates structure; cast to the internal
          // FindingInput type which normalizeFindings() expects (flat fields).
          findings = body.findings as unknown as FindingInput[];
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
      try {
        if (!this.config.ingestionService) {
          return c.json(
            { error: "ServiceUnavailable", message: "Ingestion service not configured" },
            503
          );
        }

        let _reqBody2: unknown;
        try { _reqBody2 = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }
        const parseResult = CodebaseIngestSchema.safeParse(_reqBody2);
        if (!parseResult.success) {
          return c.json(
            { error: "BadRequest", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }
        const projectDir = path.resolve(parseResult.data.projectDir);
        if (!isProjectDirSafe(projectDir)) {
          return c.json({ error: "BadRequest", message: "projectDir must be within an allowed root" }, 400);
        }
        const forceReingest = parseResult.data.forceReingest;

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
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.post("/api/v1/codebase/verify", async (c) => {
      try {
        if (!this.config.ingestionService) {
          return c.json(
            { error: "ServiceUnavailable", message: "Ingestion service not configured" },
            503
          );
        }
        let _reqBody3: unknown;
        try { _reqBody3 = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }
        const parseResult = CodebaseVerifySchema.safeParse(_reqBody3);
        if (!parseResult.success) {
          return c.json(
            { error: "BadRequest", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }
        const projectDir = path.resolve(parseResult.data.projectDir);
        if (!isProjectDirSafe(projectDir)) {
          return c.json({ error: "BadRequest", message: "projectDir must be within an allowed root" }, 400);
        }
        const result = await this.config.ingestionService.verifyProject(projectDir);
        return c.json({ data: result });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/codebase/search", async (c) => {
      try {
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
        if (query.length > 2000) {
          return c.json({ error: "BadRequest", message: "query exceeds maximum length" }, 400);
        }
        const projectId = c.req.query("projectId");
        if (projectId !== undefined && projectId.length > 128) {
          return c.json({ error: "BadRequest", message: "projectId exceeds maximum length" }, 400);
        }
        const rawFilePath = c.req.query("filePath");
        if (rawFilePath !== undefined && (rawFilePath.length > 1000 || rawFilePath.includes("..") || rawFilePath.startsWith("/"))) {
          return c.json({ error: "BadRequest", message: "filePath must be a relative path without traversal sequences (max 1000 chars)" }, 400);
        }
        const filePath = rawFilePath;
        const rawType = c.req.query("type");
        if (rawType !== undefined && !RESTPingMemServer.VALID_CODE_TYPES.has(rawType)) {
          return c.json({ error: "BadRequest", message: "Invalid type: must be one of: code, comment, docstring" }, 400);
        }
        const type = rawType as "code" | "comment" | "docstring" | undefined;
        const rawSearchLimit = c.req.query("limit") ? parseInt(c.req.query("limit") as string, 10) : undefined;
        const limit = rawSearchLimit !== undefined ? (Number.isNaN(rawSearchLimit) ? 10 : Math.min(Math.max(rawSearchLimit, 1), 1000)) : undefined;
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
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/codebase/timeline", async (c) => {
      try {
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
        if (projectId.length > 128) {
          return c.json({ error: "BadRequest", message: "projectId exceeds maximum length" }, 400);
        }
        const rawTimelineFilePath = c.req.query("filePath");
        if (rawTimelineFilePath !== undefined && (rawTimelineFilePath.length > 1000 || rawTimelineFilePath.includes("..") || rawTimelineFilePath.startsWith("/"))) {
          return c.json({ error: "BadRequest", message: "filePath must be a relative path without traversal sequences (max 1000 chars)" }, 400);
        }
        const filePath = rawTimelineFilePath;
        const rawTimelineLimit = c.req.query("limit") ? parseInt(c.req.query("limit") as string, 10) : undefined;
        const limit = rawTimelineLimit !== undefined ? (Number.isNaN(rawTimelineLimit) ? 50 : Math.min(Math.max(rawTimelineLimit, 1), 1000)) : undefined;
        const timelineOptions: { projectId: string; filePath?: string; limit?: number } = {
          projectId,
        };
        if (filePath) timelineOptions.filePath = filePath;
        if (limit !== undefined) timelineOptions.limit = limit;

        const results = await this.config.ingestionService.queryTimeline(timelineOptions);
        return c.json({ data: results });
      } catch (error) {
        return this.handleError(c, error);
      }
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
        if (projectId.length > 128) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "projectId exceeds maximum length" }, 400);
        }
        const toolName = c.req.query("toolName") ?? undefined;
        const toolVersion = c.req.query("toolVersion") ?? undefined;
        const treeHash = c.req.query("treeHash") ?? undefined;
        if ((toolName && toolName.length > 200) || (toolVersion && toolVersion.length > 200) || (treeHash && treeHash.length > 200)) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Query parameter exceeds maximum length" }, 400);
        }

        const run = this.diagnosticsStore.getLatestRun({
          projectId,
          toolName,
          toolVersion,
          treeHash,
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
        if (!analysisId || !RESTPingMemServer.ANALYSIS_ID_RE.test(analysisId)) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid analysisId" }, 400);
        }
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
        let _reqBody4: unknown;
        try { _reqBody4 = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }
        const parseResult = DiagnosticsDiffSchema.safeParse(_reqBody4);
        if (!parseResult.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }
        const { analysisIdA, analysisIdB } = parseResult.data;

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
        if (!analysisId || !RESTPingMemServer.ANALYSIS_ID_RE.test(analysisId)) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid analysisId" }, 400);
        }
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
        if (!analysisId || !RESTPingMemServer.ANALYSIS_ID_RE.test(analysisId)) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid analysisId" }, 400);
        }
        let _reqBody5: unknown;
        try { _reqBody5 = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }
        const parseResult = DiagnosticsSummarizeSchema.safeParse(_reqBody5);
        if (!parseResult.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }
        const { useLLM, forceRefresh } = parseResult.data;

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
        if (key.length > 1000) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Key too long" }, 400);
        }
        const sessionId = this.getSessionIdFromRequest(c);

        if (!sessionId) {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "No active session",
            },
            400
          );
        }

        const memoryManager = await this.getMemoryManager(sessionId);

        // Use recall to get memory by key
        const results = await memoryManager.recall({ key });

        if (results.length === 0) {
          return c.json(
            {
              error: "Not Found",
              message: "Memory with requested key not found",
            },
            404
          );
        }

        const memory = results[0]?.memory;
        if (!memory) {
          return c.json(
            {
              error: "Not Found",
              message: "Memory with requested key not found",
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
        if (key.length > 1000) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Key too long" }, 400);
        }
        const sessionId = this.getSessionIdFromRequest(c);

        if (!sessionId) {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "No active session",
            },
            400
          );
        }

        const memoryManager = await this.getMemoryManager(sessionId);
        const deleted = await memoryManager.delete(key);

        if (!deleted) {
          return c.json<RESTErrorResponse>(
            { error: "Not Found", message: "Memory not found or not accessible" },
            404
          );
        }

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
        if (query.length > 2000) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "query exceeds maximum length" }, 400);
        }

        const sessionId = this.getSessionIdFromRequest(c);
        if (!sessionId) {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "No active session",
            },
            400
          );
        }

        const memoryManager = await this.getMemoryManager(sessionId);

        // Build query params — map query text to keyPattern for wildcard matching.
        // Strip glob metacharacters from user input before wrapping in wildcards so
        // a query of '*' matches keys containing the text '*', not all keys.
        const safeQuery = query.replace(/[*?[\]\\]/g, "");
        const queryParams: Record<string, unknown> = { keyPattern: `*${safeQuery}*` };

        if (c.req.query("category")) {
          const rawCategory = c.req.query("category")!;
          if (!RESTPingMemServer.VALID_CATEGORIES.has(rawCategory)) {
            return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid category: must be task, decision, progress, note, error, or warning" }, 400);
          }
          queryParams.category = rawCategory as MemoryCategory;
        }
        if (c.req.query("channel")) {
          const rawChannel = c.req.query("channel")!;
          if (rawChannel.length > 200) {
            return c.json<RESTErrorResponse>({ error: "Bad Request", message: "channel exceeds maximum length" }, 400);
          }
          // Strip SQLite LIKE wildcards to prevent logic-bypass in downstream LIKE expressions.
          queryParams.channel = rawChannel.replace(/[%_]/g, "");
        }
        if (c.req.query("priority")) {
          const rawPriority = c.req.query("priority")!;
          if (!RESTPingMemServer.VALID_PRIORITIES.has(rawPriority)) {
            return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid priority: must be high, normal, or low" }, 400);
          }
          queryParams.priority = rawPriority as MemoryPriority;
        }
        if (c.req.query("limit")) {
          const rawLim = parseInt(c.req.query("limit")!, 10);
          queryParams.limit = Number.isNaN(rawLim) ? 10 : Math.min(Math.max(rawLim, 1), 1000);
        }
        if (c.req.query("offset")) {
          const rawOff = parseInt(c.req.query("offset")!, 10);
          queryParams.offset = Number.isNaN(rawOff) ? 0 : Math.min(Math.max(rawOff, 0), 100_000);
        }

        const results = await memoryManager.recall(queryParams);

        // Apply relevance decay weighting to search results
        const weightedResults = results.map((r) => {
          const relevanceScore = this.relevanceEngine.getRelevanceScore(r.memory.id);
          const baseScore = r.score ?? 1.0;
          // Blend original score with relevance decay (70% match score, 30% relevance)
          const weightedScore = baseScore * 0.7 + relevanceScore * 0.3;
          return { ...r, score: weightedScore };
        });

        // Re-sort by weighted score
        weightedResults.sort((a, b) => b.score - a.score);

        return c.json<RESTSuccessResponse<typeof weightedResults>>({
          data: weightedResults,
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
        let _reqBody6: unknown;
        try { _reqBody6 = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }
        const parseResult = CheckpointSchema.safeParse(_reqBody6);
        if (!parseResult.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }
        const body = parseResult.data;
        const sessionId = this.getSessionIdFromRequest(c);

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
        const session = this.sessionManager.getSession(sessionId);
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
          ? this.sessionManager.getSession(this.currentSessionId)
          : null;

        const eventStats = this.eventStore.getStats();
        const stats = {
          eventStore: {
            totalEvents: eventStats.eventCount,
          },
          sessions: (() => {
            const allSessions = this.sessionManager.listSessions();
            return {
              total: allSessions.length,
              active: allSessions.filter((s) => s.status === "active").length,
            };
          })(),
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

    // ============================================================================
    // Relevance Engine Operations
    // ============================================================================

    this.app.get("/api/v1/memory/stats", async (c) => {
      try {
        const stats = this.relevanceEngine.getStats();
        return c.json({ data: stats });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.post("/api/v1/memory/consolidate", async (c) => {
      try {
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400);
        }
        const parseResult = MemoryConsolidateSchema.safeParse(body);
        if (!parseResult.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }
        const options: Parameters<typeof this.relevanceEngine.consolidate>[0] = {};
        if (parseResult.data.maxScore !== undefined) {
          options.maxScore = parseResult.data.maxScore;
        }
        if (parseResult.data.minDaysOld !== undefined) {
          options.minDaysOld = parseResult.data.minDaysOld;
        }
        const result = await this.relevanceEngine.consolidate(options);
        return c.json({ data: result });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Agent Management Routes
    // ============================================================================

    this.app.post("/api/v1/agents/register", async (c) => {
      try {
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400);
        }
        const parseResult = AgentRegisterSchema.safeParse(body);
        if (!parseResult.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }

        const { agentId: rawId, role, ttlMs: rawTtlMs, quotaBytes, quotaCount, metadata } = parseResult.data;
        // admin privilege must be granted via server config, not self-assignment
        const admin = false;
        let agentId: ReturnType<typeof createAgentId>;
        try {
          agentId = createAgentId(rawId);
        } catch (err) {
          if (err instanceof Error) {
            return c.json<RESTErrorResponse>({ error: "Bad Request", message: err.message }, 400);
          }
          throw err;
        }
        // Clamp TTL: min 1 second, max 7 days
        const ttlMs = Math.max(1000, Math.min(rawTtlMs, 604800000));
        const now = new Date().toISOString();
        const expiresAt = new Date(Date.now() + ttlMs).toISOString();

        const db = this.eventStore.getDatabase();

        // Garbage collect expired agents before counting (aligned with MCP handler)
        db.prepare("DELETE FROM agent_quotas WHERE expires_at IS NOT NULL AND expires_at < $now").run({ $now: new Date().toISOString() });

        // Enforce max-agents limit
        const parsedMax = parseInt(process.env.PING_MEM_MAX_AGENTS ?? "100", 10);
        // Guard NaN and non-positive values: `|| 100` would not catch negative ints (truthy).
        const maxAgents = !Number.isNaN(parsedMax) && parsedMax > 0 ? parsedMax : 100;
        const countRow = db.prepare(
          "SELECT COUNT(*) as cnt FROM agent_quotas"
        ).get() as { cnt: number };
        const existingRow = db.prepare("SELECT 1 FROM agent_quotas WHERE agent_id = $agent_id").get({ $agent_id: agentId });
        if (!existingRow && countRow.cnt >= maxAgents) {
          return c.json<RESTErrorResponse>({ error: "Conflict", message: `Maximum agent registrations (${maxAgents}) reached` }, 409);
        }

        // Enforce metadata size limit
        const metadataStr = JSON.stringify(metadata ?? {});
        if (metadataStr.length > 10_000) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "metadata exceeds 10KB size limit" }, 400);
        }

        db.prepare(
          `INSERT INTO agent_quotas (agent_id, role, admin, ttl_ms, expires_at, current_bytes, current_count, quota_bytes, quota_count, created_at, updated_at, metadata)
           VALUES ($agent_id, $role, $admin, $ttl_ms, $expires_at, 0, 0, $quota_bytes, $quota_count, $created_at, $updated_at, $metadata)
           ON CONFLICT(agent_id) DO UPDATE SET
             role = $role, ttl_ms = $ttl_ms, expires_at = $expires_at,
             updated_at = $updated_at, metadata = $metadata`
        ).run({
          $agent_id: agentId,
          $role: role,
          $admin: admin ? 1 : 0,
          $ttl_ms: ttlMs,
          $expires_at: expiresAt,
          $quota_bytes: quotaBytes,
          $quota_count: quotaCount,
          $created_at: now,
          $updated_at: now,
          $metadata: metadataStr,
        });

        return c.json<RESTSuccessResponse<Record<string, unknown>>>({
          data: { agentId, role, admin, ttlMs, expiresAt, quotaBytes, quotaCount },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/agents/quotas", async (c) => {
      try {
        const agentId = c.req.query("agentId");
        const db = this.eventStore.getDatabase();

        if (agentId) {
          let validatedAgentId: ReturnType<typeof createAgentId>;
          try {
            validatedAgentId = createAgentId(agentId);
          } catch (err) {
            if (err instanceof Error && err.message.includes("Invalid agent ID")) {
              return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid agentId format" }, 400);
            }
            throw err;
          }
          const row = db.prepare(
            "SELECT * FROM agent_quotas WHERE agent_id = $agent_id"
          ).get({ $agent_id: validatedAgentId }) as Record<string, unknown> | undefined;

          if (!row) {
            return c.json<RESTErrorResponse>({ error: "Not Found", message: "Agent not found" }, 404);
          }
          return c.json<RESTSuccessResponse<Record<string, unknown>>>({ data: row });
        }

        const rows = db.prepare("SELECT * FROM agent_quotas ORDER BY updated_at DESC LIMIT 200").all();
        return c.json<RESTSuccessResponse<{ agents: unknown[] }>>({ data: { agents: rows } });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.delete("/api/v1/agents/:agentId", async (c) => {
      try {
        const rawId = c.req.param("agentId");
        if (!rawId) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "agentId is required" }, 400);
        }
        let agentId: ReturnType<typeof createAgentId>;
        try {
          agentId = createAgentId(rawId);
        } catch (err) {
          if (err instanceof Error && err.message.includes("Invalid agent ID")) {
            return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid agentId format" }, 400);
          }
          throw err;
        }
        const db = this.eventStore.getDatabase();

        const deleteResult = db.transaction(() => {
          const lockResult = db.prepare("DELETE FROM write_locks WHERE holder_id = $agent_id").run({ $agent_id: agentId });
          const quotaResult = db.prepare("DELETE FROM agent_quotas WHERE agent_id = $agent_id").run({ $agent_id: agentId });
          return { lockResult, quotaResult };
        })();
        const { lockResult, quotaResult } = deleteResult;

        if (quotaResult.changes === 0) {
          return c.json<RESTErrorResponse>({ error: "Not Found", message: "Agent not found" }, 404);
        }

        return c.json<RESTSuccessResponse<Record<string, unknown>>>({
          data: { agentId, quotaRowsDeleted: quotaResult.changes, lockRowsDeleted: lockResult.changes },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // SSE Event Stream (Memory PubSub)
    // ============================================================================

    this.app.get("/api/v1/events/stream", async (c) => {
      // SSE responses are returned via raw ReadableStream which bypasses the global auth middleware
      // pipeline on some runtimes. Apply an explicit auth gate here so the stream is never
      // accessible without credentials when auth is configured.
      // Uses isAuthRequired() — same policy as the global middleware.
      if (this.isAuthRequired() && !this.validateApiKey(this.extractApiKey(c))) {
        return c.json<RESTErrorResponse>({ error: "Unauthorized", message: "Valid API key required" }, 401);
      }

      const channel = c.req.query("channel");
      const category = c.req.query("category");
      const agentId = c.req.query("agentId");
      if ((channel && channel.length > 200) || (category && category.length > 200)) {
        return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Filter parameter exceeds maximum length" }, 400);
      }

      // Validate agentId exists and is not expired if provided
      if (agentId) {
        try {
          const validId = createAgentId(agentId);
          if (!this.eventStore.isAgentActive(validId)) {
            return c.json<RESTErrorResponse>({ error: "Forbidden", message: "Agent not registered or expired" }, 403);
          }
        } catch {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid agentId format" }, 400);
        }
      }

      // Increment first, then check to prevent TOCTOU race under concurrent SSE requests.
      const sseCount = ++this.sseConnectionCount;
      if (sseCount > RESTPingMemServer.MAX_SSE_CONNECTIONS) {
        this.sseConnectionCount--;
        return c.json<RESTErrorResponse>(
          { error: "Service Unavailable", message: "Too many SSE connections" },
          503
        );
      }

      // Track cleanup state shared between start() and cancel()
      let sseHeartbeat: ReturnType<typeof setInterval> = 0 as unknown as ReturnType<typeof setInterval>;
      let sseSubscriptionId = "";
      let sseReleaseConnection: (() => void) | null = null;

      const stream = new ReadableStream({
        start: (controller) => {
          const encoder = new TextEncoder();
          // Use a once-guard so any cleanup path (abort, error, stream cancel) only decrements once
          let released = false;
          const releaseConnection = (): void => {
            if (!released) {
              released = true;
              this.sseConnectionCount = Math.max(0, this.sseConnectionCount - 1);
            }
          };
          sseReleaseConnection = releaseConnection;

          sseSubscriptionId = this.pubsub.subscribe(
            {
              ...(channel ? { channel } : {}),
              ...(category ? { category } : {}),
              ...(agentId ? { agentId } : {}),
            },
            (event) => {
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              } catch (err) {
                // Stream closed — clean up subscription and heartbeat
                this.pubsub?.unsubscribe(sseSubscriptionId);
                clearInterval(sseHeartbeat);
                releaseConnection();
                if (err instanceof TypeError && /closed|errored/i.test(String(err.message))) return;
                log.error("SSE failed to send event", { error: err instanceof Error ? err.message : String(err) });
              }
            }
          );

          // Heartbeat every 30 seconds
          sseHeartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`: heartbeat\n\n`));
            } catch (err) {
              clearInterval(sseHeartbeat);
              this.pubsub?.unsubscribe(sseSubscriptionId);
              releaseConnection();
              if (!(err instanceof TypeError && /closed|errored/i.test(String(err.message)))) {
                log.error("SSE heartbeat error", { error: err instanceof Error ? err.message : String(err) });
              }
            }
          }, 30_000);

          // Clean up on abort
          c.req.raw.signal.addEventListener("abort", () => {
            clearInterval(sseHeartbeat);
            this.pubsub.unsubscribe(sseSubscriptionId);
            releaseConnection();
            try {
              controller.close();
            } catch (err) {
              // Stream already closed by client disconnect
              if (err instanceof Error && !/closed|errored/i.test(err.message)) {
                log.error("SSE cleanup error", { error: err.message });
              }
            }
          });
        },
        cancel: () => {
          // Fires when consumer calls reader.cancel() or stream is otherwise cancelled
          clearInterval(sseHeartbeat);
          if (sseSubscriptionId) this.pubsub?.unsubscribe(sseSubscriptionId);
          sseReleaseConnection?.();
        },
      });

      // This raw Response bypasses Hono's middleware pipeline so security headers
      // must be added explicitly here (the middleware only runs after next()).
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          // no-store prevents caches from retaining per-user event stream data;
          // no-cache additionally prevents conditional caching on reconnect.
          "Cache-Control": "no-store, no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "strict-origin-when-cross-origin",
          "Content-Security-Policy": "default-src 'none'",
          "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Resource-Policy": "same-origin",
          // HSTS: only set when behind a TLS-terminating reverse proxy to match
          // the main middleware policy applied to all other response paths.
          ...(process.env.PING_MEM_BEHIND_PROXY === "true"
            ? { "Strict-Transport-Security": "max-age=63072000; includeSubDomains" }
            : {}),
        },
      });
    });

    // ============================================================================
    // Knowledge Endpoints
    // ============================================================================

    this.app.post("/api/v1/knowledge/search", async (c) => {
      try {
        let raw: unknown;
        try { raw = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }
        const parsed = KnowledgeSearchSchema.safeParse(raw);
        if (!parsed.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parsed.error.issues.map((i) => i.message).join("; ") },
            400
          );
        }
        const body = parsed.data;

        // Build search options with only defined properties (exactOptionalPropertyTypes)
        const searchOpts: import("../knowledge/index.js").KnowledgeSearchOptions = {
          query: body.query,
          crossProject: body.crossProject,
          limit: body.limit,
        };
        if (body.projectId !== undefined) {
          searchOpts.projectId = body.projectId;
        }
        if (body.tags !== undefined) {
          searchOpts.tags = body.tags;
        }

        const results = this.knowledgeStore.search(searchOpts);

        return c.json<RESTSuccessResponse<{ count: number; results: unknown[] }>>({
          data: {
            count: results.length,
            results: results.map((r) => ({ ...r.entry, rank: r.rank })),
          },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.post("/api/v1/knowledge/ingest", async (c) => {
      try {
        let raw: unknown;
        try { raw = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }
        const parsed = KnowledgeIngestSchema.safeParse(raw);
        if (!parsed.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parsed.error.issues.map((i) => i.message).join("; ") },
            400
          );
        }
        const body = parsed.data;

        // Build ingest entry with only defined properties (exactOptionalPropertyTypes)
        const ingestEntry: Omit<import("../knowledge/index.js").KnowledgeEntry, "id" | "createdAt" | "updatedAt"> = {
          projectId: body.projectId,
          title: body.title,
          solution: body.solution,
          tags: body.tags,
        };
        if (body.symptoms !== undefined) {
          ingestEntry.symptoms = body.symptoms;
        }
        if (body.rootCause !== undefined) {
          ingestEntry.rootCause = body.rootCause;
        }

        const entry = this.knowledgeStore.ingest(ingestEntry);

        return c.json<RESTSuccessResponse<{ entry: unknown }>>({
          data: { entry },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Static Files & UI Routes
    // ============================================================================

    // Serve static files from src/static/
    this.app.get("/static/*", async (c) => {
      const filePath = c.req.path.slice("/static/".length);
      // Reject null bytes early — can truncate paths in C-based syscalls
      if (filePath.includes("\0")) {
        return c.text("Bad Request", 400);
      }
      const staticDir = process.env.PING_MEM_STATIC_DIR
        ?? path.resolve(process.cwd(), "src/static");
      const fullPath = path.resolve(staticDir, filePath);

      // Security: prevent path traversal — canonicalize with realpath to resolve symlinks,
      // then compare with trailing separator to prevent escape via symlink targets.
      // Uses async fs.promises.realpath to avoid blocking the event loop on I/O.
      let canonicalPath: string;
      let canonicalBase: string;
      try {
        [canonicalPath, canonicalBase] = await Promise.all([
          fs.promises.realpath(fullPath),
          fs.promises.realpath(path.resolve(staticDir)),
        ]);
      } catch {
        return c.text("Not Found", 404);
      }
      // Sanitize filePath for all log calls in this handler to prevent log injection
      const safeFilePath = filePath.replace(/[\x00-\x1f]/g, "?").slice(0, 200);
      if (!canonicalPath.startsWith(canonicalBase + path.sep) && canonicalPath !== canonicalBase) {
        log.warn("Path traversal attempt blocked", { filePath: safeFilePath });
        return c.text("Forbidden", 403);
      }

      // Block source map files — they expose original source code to unauthenticated clients
      if (filePath.endsWith(".map")) {
        return c.text("Not Found", 404);
      }

      try {
        const file = Bun.file(canonicalPath);
        if (!(await file.exists())) {
          return c.text("Not Found", 404);
        }
        const contentType = getContentType(filePath);
        // HTML files must not be cached: they may contain per-request CSP nonces and
        // sensitive rendered data. Other static assets (JS, CSS, images) are safely cacheable.
        const cacheControl = filePath.endsWith(".html") ? "no-store" : "public, max-age=3600";
        return new Response(file, {
          headers: { "Content-Type": contentType, "Cache-Control": cacheControl },
        });
      } catch (err) {
        log.error("Error serving static file", { filePath: safeFilePath, error: err instanceof Error ? err.message : String(err) });
        return c.text("Internal Server Error", 500);
      }
    });

    // Register UI routes
    registerUIRoutes(this.app, {
      eventStore: this.eventStore,
      sessionManager: this.sessionManager,
      diagnosticsStore: this.diagnosticsStore,
      ingestionService: this.config.ingestionService,
      knowledgeStore: this.knowledgeStore,
      graphManager: this.graphManager ?? undefined,
      qdrantClient: this.qdrantClient ?? undefined,
    });
  }

  /**
   * Extract API key from X-API-Key header or Authorization: Bearer token.
   */
  private extractApiKey(c: Context<AppEnv>): string | undefined {
    const apiKey = c.req.header("x-api-key");
    if (apiKey) return apiKey;
    const authHeader = c.req.header("authorization");
    if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
    return undefined;
  }

  /**
   * Single source of truth for whether auth is required on this server instance.
   * Used by the global middleware, the /health handler, and the SSE handler so
   * all three stay in sync when auth configuration changes.
   */
  private isAuthRequired(): boolean {
    return this.config.apiKeyManager
      ? this.config.apiKeyManager.hasSeedKey()
      : Boolean(this.config.apiKey && this.config.apiKey.trim().length > 0);
  }

  /**
   * Validate an API key using constant-time comparison
   */
  private validateApiKey(apiKey: string | undefined): boolean {
    if (this.config.apiKeyManager) {
      return this.config.apiKeyManager.isValid(apiKey);
    }
    if (!apiKey || !this.config.apiKey) {
      return false;
    }
    return timingSafeStringEqual(apiKey, this.config.apiKey);
  }

  /**
   * UUID format regex for validating X-Session-ID header values.
   * Enforces RFC 4122 version nibble (4 or 7) and variant nibble (8/9/a/b).
   * Input is normalized to lowercase before testing so no /i flag is needed.
   */
  private static readonly UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  /** Valid priority values for query parameter validation */
  private static readonly VALID_PRIORITIES = new Set(["high", "normal", "low"]);

  /** Valid memory category values for query parameter validation */
  private static readonly VALID_CATEGORIES = new Set(["task", "decision", "progress", "note", "error", "warning"]);

  /** Valid code types for codebase search */
  private static readonly VALID_CODE_TYPES = new Set(["code", "comment", "docstring"]);

  /** Strict allowlist for analysisId path params — prevents log injection and SQL metacharacter injection */
  private static readonly ANALYSIS_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

  /**
   * Exact set of domain error names whose messages are safe to expose to clients.
   * Uses error.name (explicitly set in each error constructor via this.name = "...")
   * which survives minification, unlike error.constructor.name which reflects the
   * minified class variable name. An exact Set avoids false-positive substring
   * matches from base classes or unrelated errors.
   *
   * Note: "MemoryManagerError" is intentionally excluded — it represents
   * infrastructure failures (VECTOR_INDEX_NOT_CONFIGURED, AGENT_EXPIRED)
   * that map via error.code or default to 500.
   */
  private static readonly DOMAIN_ERROR_NAMES = new Set([
    "MemoryKeyNotFoundError",
    "MemoryKeyExistsError",
    "MemoryNotFoundError",
    "AgentNotRegisteredError",
    "QuotaExhaustedError",
    "WriteLockConflictError",
    "EvidenceGateRejectionError",
    "ScopeViolationError",
    "SchemaValidationError",
    "InvalidSessionError",
    "InvalidSessionStateError",
    "SessionNotFoundError",
  ]);

  /**
   * Handle errors and return consistent error responses
   */
  private handleError(c: Context<AppEnv>, error: unknown): Response {
    const statusCode = this.getStatusCode(error);
    const rawMessage = error instanceof Error ? error.message : "Unknown error";

    // Truncate and sanitize log messages to prevent log injection from user-controlled
    // input embedded in error messages (e.g., session IDs, memory keys, file paths).
    // Strip all C0 control characters (null bytes, ANSI escapes, CR/LF, tabs, etc.)
    const sanitizedMessage = rawMessage.replace(/[\x00-\x1f]/g, "?").slice(0, 200);

    if (statusCode >= 500) {
      const requestId = crypto.randomUUID().slice(0, 8);
      log.error("Request error", {
        requestId,
        method: c.req.method,
        path: c.req.path.replace(/[\x00-\x1f]/g, "?").slice(0, 200),
        error: sanitizedMessage,
      });
      return c.json(
        { error: this.getErrorName(statusCode), message: `An internal error occurred (ref: ${requestId})` },
        statusCode as ContentfulStatusCode
      );
    }

    // For 4xx: only return raw message for known domain error classes whose messages
    // are safe to expose. All others get a generic message to prevent leaking internal
    // details (SQL errors, file paths) from misclassified exceptions.
    const isDomainError = error instanceof Error &&
      RESTPingMemServer.DOMAIN_ERROR_NAMES.has(error.name);
    // Sanitize domain-error messages too: strip control chars and truncate in case
    // any domain error message ever embeds user-supplied input (path, key, etc.).
    const safeMessage = isDomainError
      ? rawMessage.replace(/[\x00-\x1f]/g, "?").slice(0, 200)
      : this.getErrorName(statusCode);

    // 4xx are client errors — log at warn to avoid inflating server error alert volumes.
    // 5xx are server-side problems — log at error for immediate alerting.
    if (statusCode >= 500) {
      log.error("Error", { statusCode, message: sanitizedMessage });
    } else {
      log.warn("Client error", { statusCode, message: sanitizedMessage });
    }
    return c.json(
      { error: this.getErrorName(statusCode), message: safeMessage },
      statusCode as ContentfulStatusCode
    );
  }

  /**
   * Map error to HTTP status code
   */
  private getStatusCode(error: unknown): number {
    if (error instanceof Error) {
      // Use error.name for reliable mapping (explicitly set in each error constructor)
      const name = error.name;
      if (name === "MemoryKeyNotFoundError" || name === "MemoryNotFoundError" || name === "AgentNotRegisteredError" || name === "SessionNotFoundError") return 404;
      if (name === "QuotaExhaustedError" || name === "WriteLockConflictError") return 409;
      if (name === "EvidenceGateRejectionError" || name === "ScopeViolationError") return 403;
      if (name === "MemoryKeyExistsError") return 409;
      if (name === "SchemaValidationError" || name === "InvalidSessionError") return 400;
      if (name === "InvalidSessionStateError") return 409;
      // Check for known error codes
      const codeErr = error as { code?: string };
      if (codeErr.code === "MEMORY_NOT_FOUND" || codeErr.code === "SESSION_NOT_FOUND") return 404;
      if (codeErr.code === "QUOTA_EXHAUSTED" || codeErr.code === "WRITE_LOCK_CONFLICT") return 409;
      if (codeErr.code === "MEMORY_EXISTS") return 409;
      if (codeErr.code === "INVALID_SESSION") return 400;
      if (codeErr.code === "INVALID_SESSION_STATE") return 409;
      if (codeErr.code === "AGENT_EXPIRED") return 410;
      // Fallback to message-based detection — only for known domain error names
      if (RESTPingMemServer.DOMAIN_ERROR_NAMES.has(error.name)) {
        const safeName = error.name.replace(/[\r\n\t]/g, "?").slice(0, 64);
        if (error.message.includes("not found")) {
          log.warn("getStatusCode: message-based 404", { errorName: safeName, message: error.message.slice(0, 80) });
          return 404;
        }
        if (error.message.includes("invalid") || error.message.includes("required")) {
          log.warn("getStatusCode: message-based 400", { errorName: safeName, message: error.message.slice(0, 80) });
          return 400;
        }
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
      409: "Conflict",
      410: "Gone",
      500: "Internal Server Error",
      503: "Service Unavailable",
    };
    return names[statusCode] ?? "Error";
  }

  /**
   * Extract session ID from X-Session-ID header, falling back to the single-client
   * currentSessionId when no header is present.
   *
   * Header is checked FIRST so a caller that provides X-Session-ID always gets their
   * own session, regardless of what another concurrent caller's session/start set.
   * Concurrent callers MUST supply X-Session-ID to avoid session confusion.
   */
  private getSessionIdFromRequest(c: Context<AppEnv>): SessionId | null {
    // Header takes precedence — validates UUID format to prevent map pollution.
    // Normalized to lowercase so uppercase UUIDs from external clients don't create
    // duplicate MemoryManager entries.
    const header = c.req.header("x-session-id");
    if (header) {
      const normalizedHeader = header.toLowerCase();
      if (RESTPingMemServer.UUID_RE.test(normalizedHeader)) {
        return normalizedHeader as SessionId;
      }
    }
    // Single-client convenience fallback: if no header is supplied, use the session
    // from the most recent session/start call on this server instance.
    return this.currentSessionId;
  }

  /**
   * Get MemoryManager for session, creating if needed.
   * Uses Promise-based deduplication to prevent TOCTOU races.
   */
  private getMemoryManager(sessionId: SessionId): Promise<MemoryManager> {
    const cached = this.memoryManagers.get(sessionId);
    if (cached) return Promise.resolve(cached);

    let promise = this.managerPromises.get(sessionId);
    if (!promise) {
      promise = this.hydrateManager(sessionId).catch((err) => {
        this.managerPromises.delete(sessionId);
        throw err;
      });
      this.managerPromises.set(sessionId, promise);
    }
    return promise;
  }

  private async hydrateManager(sessionId: SessionId): Promise<MemoryManager> {
    const config: MemoryManagerConfig = {
      eventStore: this.eventStore,
      sessionId,
      pubsub: this.pubsub,
    };

    if (this.vectorIndex) {
      config.vectorIndex = this.vectorIndex;
    }

    // Propagate agent identity from session metadata
    const session = this.sessionManager.getSession(sessionId);
    if (session) {
      const meta = session.metadata;
      if (meta?.agentId && typeof meta.agentId === "string") {
        config.agentId = createAgentId(meta.agentId);
      }
      if (meta?.agentRole && typeof meta.agentRole === "string") {
        config.agentRole = meta.agentRole;
      }
    }

    const manager = new MemoryManager(config);
    await manager.hydrate();

    // Evict oldest entries if map exceeds cap to prevent unbounded memory growth.
    // Map iteration order is insertion order (V8/Bun), so .keys().next().value gives
    // the insertion-oldest entry — an approximation of LRU that is correct unless a
    // session was evicted and re-hydrated (which would re-insert it at the tail).
    // True LRU would require a doubly-linked list; this approximation is sufficient
    // for the expected workload of a few active sessions at a time.
    if (this.memoryManagers.size >= MAX_MEMORY_MANAGERS) {
      const oldest = this.memoryManagers.keys().next().value;
      if (oldest) {
        // Evict from both maps together so their sizes stay bounded in tandem.
        this.memoryManagers.delete(oldest);
        this.managerPromises.delete(oldest);
      }
    }

    this.memoryManagers.set(sessionId, manager);
    this.managerPromises.delete(sessionId);
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
    let url: URL;
    try {
      url = new URL(req.url ?? "", "http://localhost");
    } catch {
      res.statusCode = 400;
      res.end("Bad Request");
      return;
    }

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
      try {
        body = await this.readRequestBody(req);
      } catch (bodyErr) {
        const msg = bodyErr instanceof Error ? bodyErr.message : String(bodyErr);
        if (msg.includes("too large")) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload Too Large", message: "Request body exceeds limit" }));
          return;
        }
        throw bodyErr;
      }
    }

    // Create Web Standard Request
    const webRequest = new Request(url.toString(), {
      method: req.method ?? "GET",
      headers,
      body,
    });

    // Process request through Hono — wrap in try/catch so a synchronous throw from
    // a middleware (e.g., unhandled non-async error) does not crash the Node.js
    // 'request' event handler and leave the connection hanging.
    let webResponse: Response;
    try {
      webResponse = await this.app.fetch(webRequest);
    } catch (err) {
      log.error("Hono fetch threw unexpectedly", { error: err instanceof Error ? err.message : String(err) });
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Internal Server Error", message: "Unexpected server error" }));
      return;
    }

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
    const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      req.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          settled = true;
          req.destroy();
          reject(new Error("Request body too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf-8"));
      });
      req.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }

  /**
   * Start the REST server
   */
  async start(): Promise<void> {
    log.info("Started (ready to handle requests)");
  }

  /**
   * Stop the REST server
   */
  async stop(): Promise<void> {
    // Destroy PubSub subscriptions first to stop event delivery
    if (this.pubsub) {
      this.pubsub.destroy();
    }
    // Stop HealthMonitor to halt tick timers
    if (this.healthMonitor) {
      await this.healthMonitor.stop();
    }
    // Close SessionManager to clear checkpoint timers (must precede EventStore close)
    await this.sessionManager.close();
    // Clear cached memory managers (do NOT call manager.close() — they share this.vectorIndex
    // and MemoryManager.close() would close it N times; we close it explicitly below)
    this.memoryManagers.clear();
    this.managerPromises.clear();
    // Close shared VectorIndex once (holds an open SQLite connection)
    if (this.vectorIndex) {
      await this.vectorIndex.close();
    }
    // Close event store only if we own it (not injected externally — caller closes it)
    if (this.ownsEventStore) {
      await this.eventStore.close();
    }
    // Close diagnostics store only if we own it (not injected externally — caller closes it)
    if (this.ownsDiagnosticsStore) {
      this.diagnosticsStore.close();
    }
    // adminStore is externally owned (injected via config from server.ts) — caller closes it
    log.info("Stopped");
  }

  /**
   * Get the Hono app instance (for advanced use cases)
   */
  getApp(): Hono<AppEnv> {
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

/** Static content-type map — hoisted to module level to avoid re-allocation per request */
const CONTENT_TYPE_MAP: Record<string, string> = {
  css: "text/css",
  js: "application/javascript",
  html: "text/html",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  // Note: .map (source map) files are blocked entirely by the static file handler
  // before getContentType() is reached, so no entry for "map" is needed here.
};

function getContentType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return CONTENT_TYPE_MAP[ext ?? ""] ?? "application/octet-stream";
}

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
      origin: process.env.PING_MEM_CORS_ORIGIN
        ? process.env.PING_MEM_CORS_ORIGIN.split(",").map(s => s.trim())
        : [],
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      headers: ["Content-Type", "X-API-Key", "X-Session-ID"],
    },
    ...overrides,
  };
}
