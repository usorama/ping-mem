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
import { JunkFilter } from "../memory/JunkFilter.js";
import { EventStore } from "../storage/EventStore.js";
import { WriteLockManager } from "../storage/WriteLockManager.js";
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
  type MemoryPrivacy,
  type EventType,
  type WorklogEventData,
  type Entity,
} from "../types/index.js";

import type {
  HTTPServerConfig,
  RESTErrorResponse,
  RESTSuccessResponse,
} from "./types.js";
import { TOOLS, type PingMemServerConfig } from "../mcp/PingMemServer.js";
import { MemoryPubSub } from "../pubsub/index.js";
import { registerUIRoutes } from "./ui/routes.js";
import { csrfProtection } from "./middleware/csrf.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { probeSystemHealth, type HealthComponent } from "../observability/health-probes.js";
import type { HealthMonitor, HealthAlert } from "../observability/HealthMonitor.js";
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
  IngestionEnqueueSchema,
  GraphHybridSearchSchema,
  CausalDiscoverSchema,
  WorklogRecordSchema,
  MemorySubscribeSchema,
  MemoryUnsubscribeSchema,
  MemoryCompressSchema,
  ToolInvokeSchema,
  MemoryExtractSchema,
  MemoryAutoRecallSchema,
  ContextUpdateSchema,
} from "../validation/api-schemas.js";
import { KnowledgeStore } from "../knowledge/index.js";
import { SemanticCompressor } from "../memory/SemanticCompressor.js";
import { ObservationCaptureService } from "../observation/ObservationCaptureService.js";
import type { SearchWeights } from "../search/HybridSearchEngine.js";
import { diagnosticsIngestBaseSchema } from "../validation/diagnostics-schemas.js";
import type { QdrantClientWrapper } from "../search/QdrantClient.js";
import { IngestionQueue } from "../ingest/IngestionQueue.js";
import { registerOpenAPIRoute } from "./routes/openapi.js";
import { registerShellRoutes } from "./routes/shell.js";
import { TranscriptMiner } from "../mining/TranscriptMiner.js";
import { createDreamingEngine } from "../dreaming/DreamingEngine.js";
import { UserProfileStore } from "../profile/UserProfile.js";

/** Maximum SARIF payload size in bytes (5 MB) */
const MAX_SARIF_BYTES = 5 * 1024 * 1024;

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

/**
 * Distinct error class so handleError can preserve the operational message
 * instead of sanitizing it to "An internal error occurred (ref: XXX)". The
 * message carries retry guidance the caller needs ("still running in
 * background — do not retry state-changing ops").
 */
export class TimeoutError extends Error {
  readonly retrySafe: boolean;
  constructor(message: string, retrySafe: boolean) {
    super(message);
    this.name = "TimeoutError";
    this.retrySafe = retrySafe;
  }
}

/**
 * Race a promise against a timeout. On timeout, rejects with TimeoutError
 * AND clears the timer so it doesn't leak per request. The underlying work
 * still runs to completion (we can't cancel without a cooperative signal),
 * so the returned error signals retry-safety to the caller so naive clients
 * don't double-invoke state-changing ops.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  retrySafe = false,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(message, retrySafe)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
  private ownsEventStore: boolean;
  private junkFilter = new JunkFilter();
  private writeLockManager: WriteLockManager;
  private qdrantClient: QdrantClientWrapper | null = null;
  private healthMonitor: HealthMonitor | null = null;
  private neo4jClient: import("../graph/Neo4jClient.js").Neo4jClient | null = null;
  private ingestionQueue: IngestionQueue | null = null;
  private observationCaptureService: ObservationCaptureService;
  private transcriptMiner: TranscriptMiner | null = null;
  private dreamingEngine: ReturnType<typeof createDreamingEngine> | null = null;
  private userProfileStore: UserProfileStore | null = null;
  private warmUpInProgress = false;

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
    this.observationCaptureService = new ObservationCaptureService(this.eventStore);
    this.sessionManager = new SessionManager({ eventStore: this.eventStore });
    this.relevanceEngine = new RelevanceEngine(this.eventStore.getDatabase());
    this.writeLockManager = new WriteLockManager(this.eventStore.getDatabase());
    this.pubsub = new MemoryPubSub();
    this.knowledgeStore = new KnowledgeStore(this.eventStore.getDatabase());
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
    if (config.neo4jClient) {
      this.neo4jClient = config.neo4jClient;
    }
    if (config.ingestionService) {
      this.ingestionQueue = new IngestionQueue(config.ingestionService);
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
          allowMethods: corsConfig?.methods ?? ["GET", "POST", "OPTIONS"],
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
      // SAMEORIGIN (not DENY): the /ui/codebase page embeds /static/codebase-diagram.html
      // in a same-origin iframe for style isolation. DENY would block that.
      c.header("X-Frame-Options", "SAMEORIGIN");
      c.header("Referrer-Policy", "strict-origin-when-cross-origin");
      if (c.req.path === "/static/codebase-diagram.html") {
        // codebase-diagram.html is a self-contained static page loaded in a same-origin
        // iframe. It uses external CDN resources (mermaid, Google Fonts) and inline
        // styles/scripts which cannot use server-generated nonces. Apply a targeted CSP
        // that allows only the specific CDNs this file actually uses.
        c.header(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'",
        );
      } else {
        c.header(
          "Content-Security-Policy",
          // style-src-attr 'unsafe-inline': required for the HTMX server-rendered UI which
          // uses inline style="" attributes extensively (e.g. color, opacity, pointer-events).
          // Migrating all inline styles to CSS classes is a significant refactor; the risk
          // is mitigated because all user-controlled values in HTML attributes go through
          // escapeHtml() before rendering, preventing CSS injection via style attribute values.
          // frame-ancestors 'self': allows same-origin iframes (/ui/codebase embeds the diagram).
          // Cross-origin framing is still blocked; 'self' is sufficient clickjacking protection.
          `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`,
        );
      }
      c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      c.header("Cross-Origin-Opener-Policy", "same-origin");
      c.header("Cross-Origin-Resource-Policy", "same-origin");
      // SEC-8: Send HSTS in production (behind proxy) and when NODE_ENV=production
      if (process.env["PING_MEM_BEHIND_PROXY"] === "true" || process.env["NODE_ENV"] === "production") {
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
      // UI uses Basic Auth (browser-friendly) instead of API key auth.
      // When admin credentials are configured, prompt the browser's native login dialog.
      // API key auth doesn't work for browsers (can't set X-API-Key headers).
      const adminUser = process.env.PING_MEM_ADMIN_USER;
      const adminPass = process.env.PING_MEM_ADMIN_PASS;
      if (adminUser && adminPass) {
        this.app.use("/ui/*", async (c, next) => {
          const authHeader = c.req.header("Authorization") ?? "";
          if (authHeader.startsWith("Basic ")) {
            let decoded = "";
            try {
              decoded = atob(authHeader.slice(6));
            } catch {
              // Malformed base64 → fall through to 401, same as missing header.
            }
            if (decoded) {
              const [user, ...passParts] = decoded.split(":");
              const pass = passParts.join(":");
              if (timingSafeStringEqual(user ?? "", adminUser) && timingSafeStringEqual(pass ?? "", adminPass)) {
                return next();
              }
            }
          }
          c.header("WWW-Authenticate", 'Basic realm="ping-mem UI"');
          return c.json({ error: "Unauthorized" }, 401);
        });
      }
    } else {
      log.warn("No API key configured. All routes are unauthenticated.");
      // Guard resource-intensive endpoints even without API key auth.
      // If admin credentials are set, require them for mining and dreaming.
      const adminUser = process.env.PING_MEM_ADMIN_USER;
      const adminPass = process.env.PING_MEM_ADMIN_PASS;
      if (adminUser && adminPass) {
        const adminGuard = async (c: Parameters<Parameters<typeof this.app.use>[1]>[0], next: () => Promise<void>) => {
          const authHeader = c.req.header("Authorization") ?? "";
          if (authHeader.startsWith("Basic ")) {
            // Narrow try/catch — only atob can throw on malformed base64.
            // Let surprises from timingSafeStringEqual/etc. bubble to handleError.
            let decoded = "";
            try {
              decoded = atob(authHeader.slice(6));
            } catch {
              // Fall through to 401 below.
            }
            if (decoded) {
              const [user, ...passParts] = decoded.split(":");
              const pass = passParts.join(":");
              if (timingSafeStringEqual(user ?? "", adminUser) && timingSafeStringEqual(pass ?? "", adminPass)) {
                return next();
              }
            }
          }
          c.header("WWW-Authenticate", 'Basic realm="ping-mem admin"');
          return c.json({ error: "Unauthorized" }, 401);
        };
        this.app.use("/api/v1/mining/*", adminGuard);
        this.app.use("/api/v1/dreaming/*", adminGuard);
      }
    }

    // CSRF protection for browser-based UI routes
    this.app.use("/ui/*", csrfProtection());

    // Local admin-authenticated callers (hooks, doctor, dev scripts) bypass
    // the IP-based limiter — they're trusted and generate legitimate bursts
    // (e.g., full memory re-sync of hundreds of files on session start).
    const adminUser = process.env.PING_MEM_ADMIN_USER;
    const adminPass = process.env.PING_MEM_ADMIN_PASS;
    const isAdminAuthed = (c: Context): boolean => {
      if (!adminUser || !adminPass) return false;
      const authHeader = c.req.header("Authorization") ?? "";
      if (!authHeader.startsWith("Basic ")) return false;
      try {
        const decoded = atob(authHeader.slice(6));
        const [user, ...passParts] = decoded.split(":");
        const pass = passParts.join(":");
        return (
          timingSafeStringEqual(user ?? "", adminUser) &&
          timingSafeStringEqual(pass ?? "", adminPass)
        );
      } catch {
        return false;
      }
    };

    // Higher rate limit for auto-capture hooks (300 req/min non-admin, 1500/min admin).
    // Admin callers (hooks, doctor, dev scripts) get a bounded higher ceiling instead of
    // a full bypass — keeps the route protected if admin creds leak.
    this.app.use("/api/v1/observations/*", rateLimiter({
      name: "observations",
      maxRequests: 300,
      windowMs: 60_000,
      adminMaxRequests: 1500,
      isAdmin: isAdminAuthed,
    }));

    // Rate limit state-changing API endpoints (60 req/min per IP non-admin, 600/min admin).
    // Policy: every /api/v1/* caller faces SOME limit. Admin gets 10× headroom for
    // legitimate bursts (full memory re-sync, ingestion sweeps) but never unbounded.
    this.app.use("/api/v1/*", rateLimiter({
      name: "api-v1",
      maxRequests: 60,
      windowMs: 60_000,
      adminMaxRequests: 600,
      isAdmin: isAdminAuthed,
    }));
  }

  /**
   * Set up REST API routes
   */
  private setupRoutes(): void {
    // Health check — per-component status
    this.app.get("/favicon.ico", (c) => c.body(null, 204));

    this.app.get("/health", async (c) => {
      // Health endpoint is ALWAYS unauthenticated — Docker healthchecks,
      // load balancers, and monitoring tools must reach it without API keys.

      // Primary liveness gate: SQLite must be reachable.
      const alive = await this.eventStore.ping();
      if (!alive) {
        log.error("Health check failed — SQLite unreachable");
        return c.json({ status: "unhealthy", error: "SQLite unreachable" }, 503);
      }

      // Per-component status from HealthMonitor cached snapshot (zero inline latency).
      // If no snapshot yet (first 60s), fall back to passive object-existence check.
      const components: Record<string, string> = { sqlite: "ok" };
      let degraded = false;

      const monitorStatus = this.healthMonitor?.getStatus();
      const snapshot = monitorStatus?.lastSnapshot;
      if (snapshot) {
        // Extract .status from HealthComponent objects — do NOT assign raw objects
        for (const [key, component] of Object.entries(snapshot.components)) {
          components[key] = typeof component === "string" ? component : (component as { status: string }).status;
        }
        degraded = snapshot.status !== "ok";
      }
      // Surface critical alerts even when the fast-tick snapshot says "ok"
      // (fast tick skips expensive checks like PRAGMA quick_check)
      if (!degraded && monitorStatus?.activeAlerts) {
        const hasCritical = monitorStatus.activeAlerts.some((a: { severity: string }) => a.severity === "critical");
        if (hasCritical) degraded = true;
      }
      if (!snapshot) {
        // No snapshot yet (initializing): passive fallback with "initializing" status
        if (this.graphManager) {
          components["neo4j"] = "initializing";
        } else if (process.env["NEO4J_URI"]) {
          components["neo4j"] = "not_connected";
          degraded = true;
        }
        if (this.qdrantClient) {
          components["qdrant"] = "initializing";
        } else if (process.env["QDRANT_URL"]) {
          components["qdrant"] = "not_connected";
          degraded = true;
        }
      }

      // G11: Surface Qdrant keyword-only fallback
      if (this.config.hybridSearchEngine?.isKeywordOnly?.()) {
        components["search_mode"] = "keyword_only";
      }

      return c.json({
        status: degraded ? "degraded" : "ok",
        timestamp: new Date().toISOString(),
        components,
        embeddingProvider: this.config.embeddingService?.providerName ?? "none (keyword-only)",
      });
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
            Object.entries(snapshot.components).map(([key, comp]: [string, HealthComponent]) => [
              key,
              comp.error ? { ...comp, error: comp.error.replace(/[\r\n\t\x00-\x1F\x7F\u061C\uFEFF\u202A-\u202E\u2066-\u2069]/g, "") } : comp,
            ])
          ),
        };

        const sanitizedMonitor = monitorStatus ? {
          ...monitorStatus,
          lastSnapshot: monitorStatus.lastSnapshot ? sanitizedSnapshot : null,
          // Alert messages are system-composed (metric names, numbers, static text) and do not
          // contain raw external error text. Apply light sanitization: strip control characters
          // (log-injection defence) and redact IPv4 addresses that may appear in metric values.
          activeAlerts: monitorStatus.activeAlerts.map((alert: HealthAlert) => ({
            ...alert,
            message: alert.message
              .replace(/[\r\n\t\x00-\x1F\x7F\u061C\uFEFF\u202A-\u202E\u2066-\u2069]/g, "")
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

    // GET /api/v1/internal/readiness — deep dependency probe for ping-guard / post-wake checks
    // Auth: API key required (inherits from /api/* authMiddleware)
    this.app.get("/api/v1/internal/readiness", async (c) => {
      try {
        const snapshot = await probeSystemHealth({
          eventStore: this.eventStore,
          ...(this.graphManager ? { graphManager: this.graphManager } : {}),
          ...(this.qdrantClient ? { qdrantClient: this.qdrantClient } : {}),
          diagnosticsStore: this.diagnosticsStore,
          skipIntegrityCheck: true,
        });
        const ready = snapshot.status === "ok";
        return c.json({ ready, checks: snapshot.components }, ready ? 200 : (503 as 503));
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // POST /api/v1/internal/warm-up — force connection pool reset + verify capability chain
    // Called by ping-guard after container recovery to ensure stale circuits are cleared.
    // Auth: API key required (inherits from /api/* authMiddleware)
    this.app.post("/api/v1/internal/warm-up", async (c) => {
      if (this.warmUpInProgress) {
        return c.json({ error: "warm-up already in progress" }, 409);
      }
      this.warmUpInProgress = true;
      const warmUpStart = Date.now();
      const steps: Array<{ name: string; status: "ok" | "failed" | "skipped"; durationMs: number; error?: string }> = [];

      const runStep = async (
        name: string,
        fn: () => Promise<void>
      ): Promise<boolean> => {
        const t = Date.now();
        try {
          await fn();
          steps.push({ name, status: "ok", durationMs: Date.now() - t });
          return true;
        } catch (err) {
          steps.push({
            name,
            status: "failed",
            durationMs: Date.now() - t,
            error: err instanceof Error ? err.message : String(err),
          });
          return false;
        }
      };

      try {
        // Step 1: sqlite_ping
        await runStep("sqlite_ping", async () => {
          const ok = await this.eventStore.ping();
          if (!ok) throw new Error("SQLite ping returned false");
        });

        // Step 2: neo4j_driver_reset — disconnect → resetPolicies → connect
        if (this.neo4jClient) {
          await runStep("neo4j_driver_reset", async () => {
            await this.neo4jClient!.disconnect();
            this.neo4jClient!.resetPolicies();
            await this.neo4jClient!.connect();
          });

          // Step 3: neo4j_roundtrip — verify with a lightweight read query
          await runStep("neo4j_roundtrip", async () => {
            const result = await Promise.race([
              this.neo4jClient!.executeQuery<{ count: number }>(
                "MATCH (n) RETURN count(n) AS count LIMIT 1"
              ),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Neo4j roundtrip timeout")), 4_000)
              ),
            ]);
            if (!Array.isArray(result)) throw new Error("Unexpected Neo4j response");
          });
        } else {
          steps.push({ name: "neo4j_driver_reset", status: "skipped", durationMs: 0 });
          steps.push({ name: "neo4j_roundtrip", status: "skipped", durationMs: 0 });
        }

        // Step 4: qdrant_roundtrip — use existing healthCheck() method
        if (this.qdrantClient) {
          await runStep("qdrant_roundtrip", async () => {
            const ok = await Promise.race([
              this.qdrantClient!.healthCheck(),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Qdrant roundtrip timeout")), 2_000)
              ),
            ]);
            if (!ok) throw new Error("Qdrant healthCheck returned false");
          });
        } else {
          steps.push({ name: "qdrant_roundtrip", status: "skipped", durationMs: 0 });
        }

        // Step 5: canary_roundtrip — write/read/delete via EventStore
        await runStep("canary_roundtrip", async () => {
          const canarySessionId = "warm-up-canary" as import("../types/index.js").SessionId;
          const event = await this.eventStore.createEvent(
            canarySessionId,
            "TOOL_RUN_RECORDED",
            { key: "warm-up-canary", value: "ping" },
          );
          const readBack = await this.eventStore.getById(event.eventId);
          if (!readBack) throw new Error("Canary event not found after write");
          this.eventStore.deleteSessions([canarySessionId]);
        });

        const success = steps.every((s) => s.status !== "failed");
        return c.json({
          success,
          durationMs: Date.now() - warmUpStart,
          steps,
        });
      } finally {
        this.warmUpInProgress = false;
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
          ...(body.agentId !== undefined ? { agentId: createAgentId(body.agentId) } : {}),
        });

        this.currentSessionId = session.id;

        // Create MemoryManager for this session
        const memoryConfig: MemoryManagerConfig = {
          eventStore: this.eventStore,
          sessionId: session.id,
          pubsub: this.pubsub,
          writeLockManager: this.writeLockManager,
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
        // Read optional sessionId from body (allows body-only clients without X-Session-ID header)
        let bodySessionId: string | undefined;
        try {
          const body = await c.req.json() as Record<string, unknown>;
          if (typeof body?.sessionId === "string") {
            bodySessionId = body.sessionId;
          }
        } catch {
          // Body is optional for session/end — ignore parse failures
        }
        // Prefer X-Session-ID header to avoid ending the wrong session under concurrent use.
        // Falls back to body sessionId, then to the single-client convenience field.
        const sessionId = this.getSessionIdFromRequest(c, bodySessionId);
        if (!sessionId) {
          return c.json<RESTErrorResponse>(
            {
              error: "Bad Request",
              message: "No active session. Provide X-Session-ID header or sessionId in body.",
            },
            400
          );
        }

        await this.sessionManager.endSession(sessionId);
        // Evict cached MemoryManager for ended session to prevent unbounded map growth
        this.memoryManagers.delete(sessionId);
        this.managerPromises.delete(sessionId);
        // Clear convenience fallback only if it matches the session being ended to avoid
        // clearing an unrelated session that was started concurrently.
        if (this.currentSessionId === sessionId) {
          this.currentSessionId = null;
        }

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
              message: "No active session. Call /api/v1/session/start first, or pass X-Session-ID header.",
            },
            400
          );
        }

        const memoryManager = await this.getMemoryManager(sessionId);

        // Quality gate: reject junk content
        const junkResult = this.junkFilter.isJunk(body.value);
        if (junkResult.junk) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: `Content rejected: ${junkResult.reason}` },
            400
          );
        }

        // Build options, excluding undefined values
        const options: Record<string, unknown> = {};
        if (body.category !== undefined) options.category = body.category;
        if (body.priority !== undefined) options.priority = body.priority;
        if (body.channel !== undefined) options.channel = body.channel;
        if (body.metadata !== undefined) options.metadata = body.metadata;
        if (body.createdAt !== undefined) options.createdAt = new Date(body.createdAt);
        if (body.updatedAt !== undefined) options.updatedAt = new Date(body.updatedAt);

        const savedMemory = await memoryManager.saveOrUpdate(body.key, body.value, options);

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

    // PUT /api/v1/context/:key — update an existing memory by key (used by native-sync hook)
    this.app.put("/api/v1/context/:key", async (c) => {
      try {
        const key = decodeURIComponent(c.req.param("key"));
        if (!key) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "key path parameter is required" }, 400);
        }

        let _reqBody: unknown;
        try { _reqBody = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }

        const parseResult = ContextUpdateSchema.safeParse(_reqBody);
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
            { error: "Bad Request", message: "No active session. Provide X-Session-ID header." },
            400
          );
        }

        const memoryManager = await this.getMemoryManager(sessionId);

        // Quality gate: reject junk content
        const junkResult = this.junkFilter.isJunk(body.value);
        if (junkResult.junk) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: `Content rejected: ${junkResult.reason}` },
            400
          );
        }

        const options: Record<string, unknown> = {};
        if (body.category !== undefined) options.category = body.category;
        if (body.priority !== undefined) options.priority = body.priority;
        if (body.channel !== undefined) options.channel = body.channel;
        if (body.metadata !== undefined) options.metadata = body.metadata;

        // supersede archives old value and stores new one under same key
        await memoryManager.supersede(key, body.value, options);

        return c.json<RESTSuccessResponse<Record<string, unknown>>>({
          data: { message: "Memory updated successfully" },
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
          // Pre-parse size guard: if sarif is a string, reject before JSON.parse to prevent
          // memory-amplification DoS (a crafted 10 MB JSON string can expand significantly
          // during deserialization before the post-serialize check would fire).
          if (typeof body.sarif === "string" && body.sarif.length > MAX_SARIF_BYTES) {
            return c.json<RESTErrorResponse>({ error: "Bad Request", message: "SARIF payload too large (max 5 MB)" }, 400);
          }
          let sarifPayload: unknown;
          try {
            sarifPayload = typeof body.sarif === "string" ? JSON.parse(body.sarif) : body.sarif;
          } catch (err) {
            console.warn("[REST] SARIF parse error:", err instanceof Error ? err.message : String(err));
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
          // Post-serialize check: catches object inputs that serialize to > 5 MB.
          if (rawSarif.length > MAX_SARIF_BYTES) {
            return c.json<RESTErrorResponse>({ error: "Bad Request", message: "SARIF payload too large (max 5 MB)" }, 400);
          }
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

        const parseResult = CodebaseIngestSchema.safeParse(await c.req.json());
        if (!parseResult.success) {
          return c.json(
            { error: "BadRequest", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }
        const projectDir = path.resolve(parseResult.data.projectDir);

        // Phase 0: Security fix — reject unsafe project directories (EVAL C2)
        if (!isProjectDirSafe(projectDir)) {
          return c.json(
            { error: "Forbidden", message: "Project directory is outside allowed roots" },
            403
          );
        }

        const forceReingest = parseResult.data.forceReingest;

        // Route through IngestionQueue to prevent concurrent Neo4j writes (deadlock).
        // Ingestion keeps running in the background after timeout — callers should
        // treat timeout as "still running" and NOT retry, or they'll double-write.
        const INGEST_TIMEOUT_MS = 300_000; // 5 min
        const ingestPromise = this.ingestionQueue
          ? this.ingestionQueue.enqueueAndWait({ projectDir, forceReingest })
          : this.config.ingestionService.ingestProject({ projectDir, forceReingest });
        // retrySafe=false — ingestion is state-changing; a retry would cause
        // double-writes to Neo4j + Qdrant. Client should poll run status instead.
        const result = await withTimeout(
          ingestPromise,
          INGEST_TIMEOUT_MS,
          "Ingestion timed out after 5 minutes — still running in background; poll /api/v1/ingestion/run/:id for status, do NOT retry",
          false,
        );

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
        const parseResult = CodebaseVerifySchema.safeParse(await c.req.json());
        if (!parseResult.success) {
          return c.json(
            { error: "BadRequest", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }
        const projectDir = path.resolve(parseResult.data.projectDir);
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
        const projectId = c.req.query("projectId");
        const filePath = c.req.query("filePath");
        const type = c.req.query("type") as "code" | "comment" | "docstring" | undefined;
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
        const filePath = c.req.query("filePath") ?? undefined;
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

    // ============================================================================
    // Ingestion Queue Endpoints (Phase 2)
    // ============================================================================

    this.app.post("/api/v1/ingestion/enqueue", async (c) => {
      try {
        if (!this.ingestionQueue) {
          return c.json(
            { error: "ServiceUnavailable", message: "Ingestion queue not configured" },
            503
          );
        }

        const parseResult = IngestionEnqueueSchema.safeParse(await c.req.json());
        if (!parseResult.success) {
          return c.json(
            { error: "BadRequest", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }

        const projectDir = path.resolve(parseResult.data.projectDir);
        if (!isProjectDirSafe(projectDir)) {
          return c.json(
            { error: "Forbidden", message: "Project directory is outside allowed roots" },
            403
          );
        }

        const enqueueOpts: import("../ingest/IngestionService.js").IngestProjectOptions = {
          projectDir,
          forceReingest: parseResult.data.forceReingest,
        };
        if (parseResult.data.maxCommits !== undefined) {
          enqueueOpts.maxCommits = parseResult.data.maxCommits;
        }
        if (parseResult.data.maxCommitAgeDays !== undefined) {
          enqueueOpts.maxCommitAgeDays = parseResult.data.maxCommitAgeDays;
        }
        const runId = await this.ingestionQueue.enqueue(enqueueOpts);
        return c.json({ runId }, 202);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("queue full")) {
          return c.json({ error: "TooManyRequests", message }, 429);
        }
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/ingestion/queue", (c) => {
      if (!this.ingestionQueue) {
        return c.json(
          { error: "ServiceUnavailable", message: "Ingestion queue not configured" },
          503
        );
      }
      const status = this.ingestionQueue.getQueueStatus();
      return c.json({
        ...status,
        runs: status.runs.map(({ originalError: _oe, ...r }) => r),
      });
    });

    this.app.get("/api/v1/ingestion/run/:runId", (c) => {
      if (!this.ingestionQueue) {
        return c.json(
          { error: "ServiceUnavailable", message: "Ingestion queue not configured" },
          503
        );
      }
      const runId = c.req.param("runId");
      // UUID v4 format validation
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
        return c.json({ error: "BadRequest", message: "Invalid runId format" }, 400);
      }
      const run = this.ingestionQueue.getRun(runId);
      if (!run) {
        return c.json({ error: "NotFound", message: "Run not found" }, 404);
      }
      const { originalError: _oe, ...runResponse } = run;
      return c.json(runResponse);
    });

    // ============================================================================
    // Staleness Detection Endpoint (Phase 5, EVAL PERF-2)
    // ============================================================================

    this.app.get("/api/v1/codebase/staleness", async (c) => {
      try {
        const projectDir = c.req.query("projectDir");
        if (!projectDir) {
          return c.json(
            { error: "BadRequest", message: "projectDir query parameter is required" },
            400
          );
        }

        const resolvedDir = path.resolve(projectDir);
        if (!isProjectDirSafe(resolvedDir)) {
          return c.json(
            { error: "Forbidden", message: "Project directory is outside allowed roots" },
            403
          );
        }

        // Check directory exists
        if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
          return c.json(
            { error: "NotFound", message: "Project directory does not exist" },
            404
          );
        }

        // Use git status --porcelain for O(1) staleness check (not full re-hash)
        const { execFileSync } = await import("child_process");
        let gitDirty = false;
        let gitStatusOutput = "";
        try {
          gitStatusOutput = execFileSync("git", ["status", "--porcelain"], {
            cwd: resolvedDir,
            encoding: "utf-8",
            maxBuffer: 1024 * 1024,
            timeout: 10_000,
          }).trim();
          gitDirty = gitStatusOutput.length > 0;
        } catch {
          // Not a git repo or git not available — report as unknown
          return c.json({
            projectDir: resolvedDir,
            stale: false,
            reason: "not a git repository or git unavailable",
            hasManifest: false,
          });
        }

        // Check if manifest exists
        const manifestPath = path.join(resolvedDir, ".ping-mem", "manifest.json");
        const hasManifest = fs.existsSync(manifestPath);

        // Determine staleness reason
        let stale = false;
        let reason = "up to date";

        if (!hasManifest) {
          stale = true;
          reason = "no manifest found — project has never been ingested";
        } else if (gitDirty) {
          const changedFileCount = gitStatusOutput.split("\n").filter(Boolean).length;
          stale = true;
          reason = `${changedFileCount} uncommitted change(s) detected`;
        }

        return c.json({
          projectDir: resolvedDir,
          stale,
          reason,
          hasManifest,
          ...(gitDirty ? { changedFiles: gitStatusOutput.split("\n").filter(Boolean).length } : {}),
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // Structural Intelligence Endpoints
    this.app.get("/api/v1/codebase/impact", async (c) => {
      try {
        if (!this.config.ingestionService) {
          return c.json({ error: "ServiceUnavailable", message: "Ingestion service not configured" }, 503);
        }
        const projectId = c.req.query("projectId");
        const filePath = c.req.query("filePath");
        const maxDepthStr = c.req.query("maxDepth");
        if (!projectId || !filePath) {
          return c.json({ error: "BadRequest", message: "projectId and filePath query parameters are required" }, 400);
        }
        const maxDepth = maxDepthStr ? Math.max(1, Math.min(parseInt(maxDepthStr, 10) || 5, 10)) : 5;
        const results = await this.config.ingestionService.queryImpact(projectId, filePath, maxDepth);
        return c.json({ projectId, filePath, maxDepth, affectedFiles: results.length, results });
      } catch (error) { return this.handleError(c, error); }
    });

    this.app.get("/api/v1/codebase/blast-radius", async (c) => {
      try {
        if (!this.config.ingestionService) {
          return c.json({ error: "ServiceUnavailable", message: "Ingestion service not configured" }, 503);
        }
        const projectId = c.req.query("projectId");
        const filePath = c.req.query("filePath");
        const maxDepthStr = c.req.query("maxDepth");
        if (!projectId || !filePath) {
          return c.json({ error: "BadRequest", message: "projectId and filePath query parameters are required" }, 400);
        }
        const maxDepth = maxDepthStr ? Math.max(1, Math.min(parseInt(maxDepthStr, 10) || 5, 10)) : 5;
        const results = await this.config.ingestionService.queryBlastRadius(projectId, filePath, maxDepth);
        return c.json({ projectId, filePath, maxDepth, dependencyCount: results.length, results });
      } catch (error) { return this.handleError(c, error); }
    });

    this.app.get("/api/v1/codebase/dependency-map", async (c) => {
      try {
        if (!this.config.ingestionService) {
          return c.json({ error: "ServiceUnavailable", message: "Ingestion service not configured" }, 503);
        }
        const projectId = c.req.query("projectId");
        const includeExternal = c.req.query("includeExternal") === "true";
        if (!projectId) {
          return c.json({ error: "BadRequest", message: "projectId query parameter is required" }, 400);
        }
        const results = await this.config.ingestionService.queryDependencyMap(projectId, includeExternal);
        const adjacencyMap: Record<string, string[]> = {};
        for (const edge of results) {
          const list = adjacencyMap[edge.sourceFile];
          if (list) { if (!list.includes(edge.targetFile)) list.push(edge.targetFile); }
          else { adjacencyMap[edge.sourceFile] = [edge.targetFile]; }
        }
        return c.json({ projectId, includeExternal, edgeCount: results.length, uniqueFiles: Object.keys(adjacencyMap).length, edges: results, adjacencyMap });
      } catch (error) { return this.handleError(c, error); }
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

        // Strip glob metacharacters and SQLite LIKE wildcards from user input.
        // % and _ are also stripped defensively in case the underlying store
        // ever uses a LIKE expression for pattern matching. Capped at 1000 chars: the query
        // param itself is validated at 2000, but stripping metacharacters doesn't reduce length.
        const safeQuery = query.replace(/[*?[\]\\%_]/g, "").slice(0, 1000);
        // An empty safeQuery after metacharacter stripping would produce keyPattern `**`,
        // matching all stored memories — effectively a full data dump. Reject it explicitly.
        if (safeQuery.length === 0) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Query must contain at least one non-metacharacter character" }, 400);
        }

        // Build shared filter params (category, channel, priority, limit, offset)
        const filterParams: Record<string, unknown> = {};

        if (c.req.query("category")) {
          const rawCategory = c.req.query("category")!;
          if (!RESTPingMemServer.VALID_CATEGORIES.has(rawCategory)) {
            return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid category: must be task, decision, progress, note, error, or warning" }, 400);
          }
          filterParams.category = rawCategory as MemoryCategory;
        }
        if (c.req.query("channel")) {
          const rawChannel = c.req.query("channel")!;
          if (rawChannel.length > 200) {
            return c.json<RESTErrorResponse>({ error: "Bad Request", message: "channel exceeds maximum length" }, 400);
          }
          // Strip control chars, BiDi overrides, and SQLite LIKE wildcards.
          filterParams.channel = rawChannel.replace(/[\x00-\x1f\x7f\u061C\uFEFF\u202A-\u202E\u2066-\u2069%_]/g, "");
        }
        if (c.req.query("priority")) {
          const rawPriority = c.req.query("priority")!;
          if (!RESTPingMemServer.VALID_PRIORITIES.has(rawPriority)) {
            return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid priority: must be high, normal, or low" }, 400);
          }
          filterParams.priority = rawPriority as MemoryPriority;
        }
        const rawLim = c.req.query("limit");
        const limit = rawLim ? (Number.isNaN(parseInt(rawLim, 10)) ? 10 : Math.min(Math.max(parseInt(rawLim, 10), 1), 1000)) : 10;
        const rawOff = c.req.query("offset");
        const offset = rawOff ? (Number.isNaN(parseInt(rawOff, 10)) ? 0 : Math.max(parseInt(rawOff, 10), 0)) : 0;

        const compact = c.req.query("compact") === "true";

        // Primary path: semanticQuery — scores by keyword overlap on key+value (same as MCP).
        // Fallback path: keyPattern — wildcard match on key names only.
        // Both paths are searched and results are merged (deduped by memory id, highest score wins).
        const semanticResults = await memoryManager.recall({
          ...filterParams,
          semanticQuery: safeQuery,
          limit,
          offset,
        });

        const keyPatternResults = await memoryManager.recall({
          ...filterParams,
          keyPattern: `*${safeQuery}*`,
          limit,
          offset,
        });

        // Merge results: semantic path first (higher quality scores); add key-pattern hits not already present
        const seenIds = new Set<string>();
        const mergedResults: typeof semanticResults = [];
        for (const r of semanticResults) {
          if (!seenIds.has(r.memory.id)) {
            seenIds.add(r.memory.id);
            mergedResults.push(r);
          }
        }
        for (const r of keyPatternResults) {
          if (!seenIds.has(r.memory.id)) {
            seenIds.add(r.memory.id);
            mergedResults.push(r);
          }
        }

        const results = mergedResults;

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

        if (compact) {
          const compactResults = weightedResults.map((r) => ({
            id: r.memory.id,
            key: r.memory.key,
            category: r.memory.category,
            snippet: r.memory.value?.slice(0, 80) ?? "",
            score: r.score,
          }));
          return c.json<RESTSuccessResponse<typeof compactResults>>({
            data: compactResults,
          });
        }

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
            totalEvents: eventStats.eventCount ?? 0,
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
    // Memory Auto-Recall Route
    // ============================================================================

    this.app.post("/api/v1/memory/auto-recall", async (c) => {
      try {
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400);
        }
        const parseResult = MemoryAutoRecallSchema.safeParse(body);
        if (!parseResult.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }

        const { query: queryText, limit: rawLimit, minScore: rawMinScore } = parseResult.data;
        const limit = rawLimit ?? 5;
        const minScore = rawMinScore ?? 0.1;

        const sessionId = this.getSessionIdFromRequest(c);
        if (!sessionId) {
          return c.json<RESTErrorResponse>({ error: "No Session", message: "No active session. Start one first." }, 400);
        }
        const memoryManager = await this.getMemoryManager(sessionId);

        const results = await memoryManager.recall({
          semanticQuery: queryText,
          limit,
        });

        const filtered = results.filter((r) => (r.score ?? 0) >= minScore);

        if (filtered.length === 0) {
          // Fire-and-forget RECALL_MISS event for observability
          void this.eventStore.createEvent(sessionId, "RECALL_MISS", { query: queryText, timestamp: Date.now() })
            .catch((err) => { log.warn("Failed to emit RECALL_MISS event", { error: err instanceof Error ? err.message : String(err) }); });
          return c.json({ data: { recalled: false, context: "", count: 0 } });
        }

        const lines = filtered.map((r, i) => {
          const mem = r.memory;
          const score = Math.round((r.score ?? 0) * 100);
          return `[${i + 1}] (${score}%) ${mem.key}: ${mem.value}`;
        });

        const context = [
          "--- ping-mem auto-recall ---",
          ...lines,
          "--- end recall ---",
        ].join("\n");

        return c.json({
          data: {
            recalled: true,
            count: filtered.length,
            context,
            memories: filtered.map((r) => ({
              key: r.memory.key,
              value: r.memory.value,
              score: r.score ?? 0,
              category: r.memory.category,
            })),
          },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Memory Extraction Route
    // ============================================================================

    this.app.post("/api/v1/memory/extract", async (c) => {
      try {
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400);
        }
        const parseResult = MemoryExtractSchema.safeParse(body);
        if (!parseResult.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }

        const { exchange, category } = parseResult.data;
        const sessionId = this.getSessionIdFromRequest(c);
        if (!sessionId) {
          return c.json<RESTErrorResponse>({ error: "No Session", message: "No active session. Start one first." }, 400);
        }
        const memoryManager = await this.getMemoryManager(sessionId);

        // Extract key facts from the exchange using simple heuristic extraction
        const facts = extractFactsFromExchange(exchange);

        if (facts.length === 0) {
          return c.json({ data: { extracted: 0, facts: [] } });
        }

        // Save each extracted fact as a memory
        const saved: Array<{ key: string; value: string }> = [];
        for (const fact of facts) {
          try {
            await memoryManager.save(fact.key, fact.value, {
              category: category ?? "fact",
              priority: "normal",
            });
            saved.push({ key: fact.key, value: fact.value });
          } catch (saveError) {
            log.warn("Failed to save extracted fact", {
              key: fact.key,
              error: saveError instanceof Error ? saveError.message : String(saveError),
            });
          }
        }

        return c.json({
          data: {
            extracted: saved.length,
            facts: saved,
          },
        });
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
        const maxAgents = parseInt(process.env.PING_MEM_MAX_AGENTS ?? "100", 10) || 100;
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
            return c.json<RESTErrorResponse>({ error: "Not Found", message: `Agent '${agentId}' not found` }, 404);
          }
          return c.json<RESTSuccessResponse<Record<string, unknown>>>({ data: row });
        }

        const rows = db.prepare("SELECT * FROM agent_quotas ORDER BY updated_at DESC").all();
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
          return c.json<RESTErrorResponse>({ error: "Not Found", message: `Agent '${rawId}' not found` }, 404);
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
      const channel = c.req.query("channel");
      const category = c.req.query("category");
      const agentId = c.req.query("agentId");

      // Validate agentId exists and is not expired if provided
      if (agentId) {
        try {
          const validId = createAgentId(agentId);
          const db = this.eventStore.getDatabase();
          const row = db.prepare(
            "SELECT 1 FROM agent_quotas WHERE agent_id = $agent_id AND (expires_at IS NULL OR expires_at >= $now)"
          ).get({ $agent_id: validId, $now: new Date().toISOString() });
          if (!row) {
            return c.json<RESTErrorResponse>({ error: "Forbidden", message: "Agent not registered or expired" }, 403);
          }
        } catch {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid agentId format" }, 400);
        }
      }

      const stream = new ReadableStream({
        start: (controller) => {
          const encoder = new TextEncoder();
          let heartbeat: ReturnType<typeof setInterval>;

          const subscriptionId = this.pubsub.subscribe(
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
                this.pubsub?.unsubscribe(subscriptionId);
                clearInterval(heartbeat);
                if (err instanceof TypeError && /closed|errored/i.test(String(err.message))) return;
                console.error("[SSE] Failed to send event:", err instanceof Error ? err.message : String(err));
              }
            }
          );

          // Heartbeat every 30 seconds
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`: heartbeat\n\n`));
            } catch (err) {
              clearInterval(heartbeat);
              this.pubsub?.unsubscribe(subscriptionId);
              if (!(err instanceof TypeError && /closed|errored/i.test(String(err.message)))) {
                console.error("[SSE] Heartbeat error:", err instanceof Error ? err.message : String(err));
              }
            }
          }, 30_000);

          // Clean up on abort
          c.req.raw.signal.addEventListener("abort", () => {
            clearInterval(heartbeat);
            this.pubsub.unsubscribe(subscriptionId);
            try {
              controller.close();
            } catch (err) {
              // Stream already closed by client disconnect
              if (err instanceof Error && !/closed|errored/i.test(err.message)) {
                console.error("[SSE] Cleanup error:", err.message);
              }
            }
          });
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    });

    // ============================================================================
    // Knowledge Endpoints
    // ============================================================================

    this.app.post("/api/v1/knowledge/search", async (c) => {
      try {
        const raw = await c.req.json();
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
        const raw = await c.req.json();
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
    // Graph Endpoints (requires graphManager / hybridSearchEngine / lineageEngine / evolutionEngine)
    // ============================================================================

    this.app.get("/api/v1/graph/relationships", async (c) => {
      try {
        if (!this.graphManager) {
          return c.json<RESTErrorResponse>(
            { error: "Service Unavailable", message: "GraphManager not configured" },
            503
          );
        }

        const entityId = c.req.query("entityId");
        if (!entityId) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "entityId query parameter is required" },
            400
          );
        }
        if (entityId.length > 500) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "entityId exceeds maximum length" }, 400);
        }

        const rawDepth = c.req.query("depth") ? parseInt(c.req.query("depth") as string, 10) : 1;
        const depth = Number.isNaN(rawDepth) ? 1 : Math.min(Math.max(rawDepth, 1), 10);
        const relationshipTypesStr = c.req.query("relationshipTypes");
        const relationshipTypes = relationshipTypesStr ? relationshipTypesStr.split(",").map(s => s.trim()).filter(Boolean) : undefined;
        const VALID_DIRECTIONS_REL = new Set(["incoming", "outgoing", "both"]);
        const dirRaw = c.req.query("direction") ?? "both";
        const direction = VALID_DIRECTIONS_REL.has(dirRaw) ? dirRaw as "incoming" | "outgoing" | "both" : "both";

        const allRelationships = await this.graphManager.findRelationshipsByEntity(entityId);

        const validRelTypes = relationshipTypes ? new Set(relationshipTypes) : null;

        const filteredRelationships = allRelationships.filter((rel) => {
          if (direction === "outgoing" && rel.sourceId !== entityId) return false;
          if (direction === "incoming" && rel.targetId !== entityId) return false;
          if (validRelTypes && !validRelTypes.has(rel.type)) return false;
          return true;
        });

        const relatedEntityIds = new Set<string>();
        for (const rel of filteredRelationships) {
          if (rel.sourceId !== entityId) relatedEntityIds.add(rel.sourceId);
          if (rel.targetId !== entityId) relatedEntityIds.add(rel.targetId);
        }

        const entities: Entity[] = [];
        for (const id of relatedEntityIds) {
          const entity = await this.graphManager.getEntity(id);
          if (entity) entities.push(entity);
        }

        return c.json({
          data: {
            entities: entities.map((e) => ({
              id: e.id, type: e.type, name: e.name, properties: e.properties,
              createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString(),
            })),
            relationships: filteredRelationships.map((r) => ({
              id: r.id, type: r.type, sourceId: r.sourceId, targetId: r.targetId,
              weight: r.weight, properties: r.properties,
              createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
            })),
          },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.post("/api/v1/graph/hybrid-search", async (c) => {
      try {
        if (!this.config.hybridSearchEngine) {
          return c.json<RESTErrorResponse>(
            { error: "Service Unavailable", message: "HybridSearchEngine not configured" },
            503
          );
        }

        let rawBody: unknown;
        try { rawBody = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }

        const parseResult = GraphHybridSearchSchema.safeParse(rawBody);
        if (!parseResult.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }

        const { query, limit, weights, sessionId } = parseResult.data;
        const searchOptions: {
          limit?: number;
          sessionId?: SessionId;
          weights?: Partial<SearchWeights>;
        } = {};

        if (limit !== undefined) searchOptions.limit = limit;
        if (sessionId !== undefined) searchOptions.sessionId = sessionId as SessionId;
        if (weights !== undefined) {
          const w: Partial<SearchWeights> = {};
          if (weights.semantic !== undefined) w.semantic = weights.semantic;
          if (weights.keyword !== undefined) w.keyword = weights.keyword;
          if (weights.graph !== undefined) w.graph = weights.graph;
          searchOptions.weights = w;
        }

        const results = await this.config.hybridSearchEngine.search(query, searchOptions);

        return c.json({
          data: {
            query,
            count: results.length,
            results: results.map((r) => ({
              memoryId: r.memoryId, sessionId: r.sessionId, content: r.content,
              hybridScore: r.hybridScore, searchModes: r.searchModes,
              graphContext: r.graphContext, modeScores: r.modeScores,
            })),
          },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/graph/lineage/:entity", async (c) => {
      try {
        if (!this.config.lineageEngine) {
          return c.json<RESTErrorResponse>(
            { error: "Service Unavailable", message: "LineageEngine not configured" },
            503
          );
        }

        const entityId = c.req.param("entity");
        if (!entityId || entityId.length > 500) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid entity parameter" }, 400);
        }

        const VALID_DIRECTIONS_LIN = new Set(["upstream", "downstream", "both"]);
        const dirRawLin = c.req.query("direction") ?? "both";
        const direction = VALID_DIRECTIONS_LIN.has(dirRawLin) ? dirRawLin as "upstream" | "downstream" | "both" : "both";
        const rawMaxDepth = c.req.query("maxDepth") ? parseInt(c.req.query("maxDepth") as string, 10) : undefined;
        const maxDepth = rawMaxDepth !== undefined && !Number.isNaN(rawMaxDepth)
          ? Math.min(Math.max(rawMaxDepth, 1), 10)
          : undefined;

        let upstream: Entity[] = [];
        if (direction === "upstream" || direction === "both") {
          upstream = await this.config.lineageEngine.getAncestors(entityId, maxDepth);
        }
        let downstream: Entity[] = [];
        if (direction === "downstream" || direction === "both") {
          downstream = await this.config.lineageEngine.getDescendants(entityId, maxDepth);
        }

        return c.json({
          data: {
            entityId, direction,
            upstream: upstream.map((e) => ({
              id: e.id, type: e.type, name: e.name, properties: e.properties,
              eventTime: e.eventTime.toISOString(),
            })),
            downstream: downstream.map((e) => ({
              id: e.id, type: e.type, name: e.name, properties: e.properties,
              eventTime: e.eventTime.toISOString(),
            })),
            upstreamCount: upstream.length,
            downstreamCount: downstream.length,
          },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/graph/evolution", async (c) => {
      try {
        if (!this.config.evolutionEngine) {
          return c.json<RESTErrorResponse>(
            { error: "Service Unavailable", message: "EvolutionEngine not configured" },
            503
          );
        }

        const entityId = c.req.query("entityId");
        if (!entityId) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "entityId query parameter is required" },
            400
          );
        }
        if (entityId.length > 500) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "entityId exceeds maximum length" }, 400);
        }

        const startTimeStr = c.req.query("startTime");
        const endTimeStr = c.req.query("endTime");
        const queryOptions: { startTime?: Date; endTime?: Date } = {};
        if (startTimeStr) {
          const d = new Date(startTimeStr);
          if (isNaN(d.getTime())) {
            return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid startTime — must be ISO 8601 date string" }, 400);
          }
          queryOptions.startTime = d;
        }
        if (endTimeStr) {
          const d = new Date(endTimeStr);
          if (isNaN(d.getTime())) {
            return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid endTime — must be ISO 8601 date string" }, 400);
          }
          queryOptions.endTime = d;
        }

        let evolution;
        try {
          evolution = await this.config.evolutionEngine.getEvolution(entityId, queryOptions);
        } catch (evoError) {
          if (evoError instanceof Error && evoError.name === "EntityEvolutionNotFoundError") {
            return c.json({ data: { entityId, changes: [], totalChanges: 0 } });
          }
          throw evoError;
        }

        return c.json({
          data: {
            entityId: evolution.entityId,
            entityName: evolution.entityName,
            startTime: evolution.startTime.toISOString(),
            endTime: evolution.endTime.toISOString(),
            totalChanges: evolution.totalChanges,
            changes: evolution.changes.map((ch) => ({
              timestamp: ch.timestamp.toISOString(),
              changeType: ch.changeType,
              entityId: ch.entityId,
              entityName: ch.entityName,
              previousState: ch.previousState ? {
                id: ch.previousState.id, type: ch.previousState.type,
                name: ch.previousState.name, properties: ch.previousState.properties,
              } : null,
              currentState: ch.currentState ? {
                id: ch.currentState.id, type: ch.currentState.type,
                name: ch.currentState.name, properties: ch.currentState.properties,
              } : null,
              metadata: ch.metadata,
            })),
          },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/graph/health", async (c) => {
      try {
        const snapshot = await probeSystemHealth({
          eventStore: this.eventStore,
          ...(this.graphManager ? { graphManager: this.graphManager } : {}),
          ...(this.qdrantClient ? { qdrantClient: this.qdrantClient } : {}),
          diagnosticsStore: this.diagnosticsStore,
        });

        return c.json({
          data: {
            status: snapshot.status === "ok" ? "healthy" : snapshot.status === "degraded" ? "degraded" : "unhealthy",
            timestamp: new Date().toISOString(),
            version: "1.0.0",
            components: snapshot.components,
            session: {
              active: this.currentSessionId !== null,
              sessionId: this.currentSessionId,
            },
          },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Causal Endpoints (requires causalGraphManager / causalDiscoveryAgent)
    // ============================================================================

    this.app.get("/api/v1/causal/causes", async (c) => {
      try {
        if (!this.config.causalGraphManager) {
          return c.json<RESTErrorResponse>(
            { error: "Service Unavailable", message: "Causal graph not configured" },
            503
          );
        }

        const entityId = c.req.query("entityId");
        if (!entityId) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "entityId query parameter is required" },
            400
          );
        }

        const rawLimit = c.req.query("limit") ? parseInt(c.req.query("limit") as string, 10) : 10;
        const limit = Number.isNaN(rawLimit) ? 10 : Math.min(Math.max(rawLimit, 1), 100);

        const causes = await this.config.causalGraphManager.getCausesOf(entityId, { limit });
        return c.json({ data: { entityId, causes } });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/causal/effects", async (c) => {
      try {
        if (!this.config.causalGraphManager) {
          return c.json<RESTErrorResponse>(
            { error: "Service Unavailable", message: "Causal graph not configured" },
            503
          );
        }

        const entityId = c.req.query("entityId");
        if (!entityId) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "entityId query parameter is required" },
            400
          );
        }

        const rawLimit = c.req.query("limit") ? parseInt(c.req.query("limit") as string, 10) : 10;
        const limit = Number.isNaN(rawLimit) ? 10 : Math.min(Math.max(rawLimit, 1), 100);

        const effects = await this.config.causalGraphManager.getEffectsOf(entityId, { limit });
        return c.json({ data: { entityId, effects } });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/causal/chain", async (c) => {
      try {
        if (!this.config.causalGraphManager) {
          return c.json<RESTErrorResponse>(
            { error: "Service Unavailable", message: "Causal graph not configured" },
            503
          );
        }

        const startEntityId = c.req.query("startEntityId");
        const endEntityId = c.req.query("endEntityId");
        if (!startEntityId || !endEntityId) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "startEntityId and endEntityId query parameters are required" },
            400
          );
        }

        const chain = await this.config.causalGraphManager.getCausalChain(startEntityId, endEntityId);
        return c.json({ data: { startEntityId, endEntityId, chain } });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.post("/api/v1/causal/discover", async (c) => {
      try {
        if (!this.config.causalDiscoveryAgent) {
          return c.json<RESTErrorResponse>(
            { error: "Service Unavailable", message: "Causal discovery agent not configured" },
            503
          );
        }

        let rawBody: unknown;
        try { rawBody = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }

        const parseResult = CausalDiscoverSchema.safeParse(rawBody);
        if (!parseResult.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }

        const { text, persist } = parseResult.data;
        if (persist) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "Persistence is not yet supported for causal discovery. Use persist=false." },
            400
          );
        }

        const links = await this.config.causalDiscoveryAgent.discover(text);
        return c.json({ data: { discovered: links.length, links, persisted: false } });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Worklog Endpoints
    // ============================================================================

    this.app.post("/api/v1/worklog", async (c) => {
      try {
        let rawBody: unknown;
        try { rawBody = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }

        const parseResult = WorklogRecordSchema.safeParse(rawBody);
        if (!parseResult.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }

        const args = parseResult.data;
        const sessionId = (args.sessionId ?? this.currentSessionId) as SessionId | null;
        if (!sessionId) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "No active session. Start a session first or provide sessionId in body." },
            400
          );
        }

        const kind = args.kind;
        const phase = args.phase;
        let eventType: EventType;
        switch (kind) {
          case "tool": eventType = "TOOL_RUN_RECORDED"; break;
          case "diagnostics": eventType = "DIAGNOSTICS_INGESTED"; break;
          case "git": eventType = "GIT_OPERATION_RECORDED"; break;
          case "task":
            if (phase === "started") eventType = "AGENT_TASK_STARTED";
            else if (phase === "summary") eventType = "AGENT_TASK_SUMMARY";
            else if (phase === "completed") eventType = "AGENT_TASK_COMPLETED";
            else return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Task worklog requires phase: started | summary | completed" }, 400);
            break;
          default:
            return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid worklog kind" }, 400);
        }

        const payload: WorklogEventData = {
          sessionId,
          kind,
          title: args.title,
        };

        if (args.status !== undefined) payload.status = args.status;
        if (args.toolName !== undefined) payload.toolName = args.toolName;
        if (args.toolVersion !== undefined) payload.toolVersion = args.toolVersion;
        if (args.configHash !== undefined) payload.configHash = args.configHash;
        if (args.environmentHash !== undefined) payload.environmentHash = args.environmentHash;
        if (args.projectId !== undefined) payload.projectId = args.projectId;
        if (args.treeHash !== undefined) payload.treeHash = args.treeHash;
        if (args.commitHash !== undefined) payload.commitHash = args.commitHash;
        if (args.runId !== undefined) payload.runId = args.runId;
        if (args.command !== undefined) payload.command = args.command;
        if (args.durationMs !== undefined) payload.durationMs = args.durationMs;
        if (args.summary !== undefined) payload.summary = args.summary;
        if (args.metadata !== undefined) payload.metadata = args.metadata;

        const metadata = {
          kind,
          projectId: payload.projectId,
          treeHash: payload.treeHash,
          commitHash: payload.commitHash,
          toolName: payload.toolName,
          toolVersion: payload.toolVersion,
          runId: payload.runId,
        };

        const event = await this.eventStore.createEvent(sessionId, eventType, payload, metadata);

        return c.json({
          data: {
            success: true,
            eventId: event.eventId,
            eventType: event.eventType,
            timestamp: event.timestamp.toISOString(),
          },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Observation Capture Endpoint (auto-capture from Claude Code hooks)
    // ============================================================================

    this.app.post("/api/v1/observations/capture", async (c) => {
      try {
        let rawBody: unknown;
        try { rawBody = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }

        const body = rawBody as Record<string, unknown>;
        const sessionId = (body.sessionId as string) ?? (this.currentSessionId as string);
        if (!sessionId) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "No active session. Provide sessionId or start a session." },
            400
          );
        }

        // Validate session exists
        const session = await this.sessionManager.getSession(sessionId as SessionId);
        if (!session) {
          return c.json<RESTErrorResponse>(
            { error: "Not Found", message: `Session ${sessionId} not found` },
            404
          );
        }

        const toolName = body.toolName as string;
        if (!toolName) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "toolName is required" },
            400
          );
        }

        const captureInput: import("../observation/ObservationCaptureService.js").ObservationInput = {
          sessionId,
          toolName,
          hookEvent: (body.hookEvent as string) ?? "PostToolUse",
          ...(body.toolUseId !== undefined && { toolUseId: body.toolUseId as string }),
          ...(body.project !== undefined && { project: body.project as string }),
          ...(Array.isArray(body.filesTouched) && { filesTouched: body.filesTouched as string[] }),
          ...(body.claudeSessionId !== undefined && { claudeSessionId: body.claudeSessionId as string }),
          ...(body.summary !== undefined && { summary: body.summary as string }),
        };
        const result = await this.observationCaptureService.capture(captureInput);

        if (result.deduplicated) {
          return c.json({ data: { deduplicated: true, eventId: null } });
        }

        return c.json({ data: { deduplicated: false, eventId: result.eventId } }, 201);
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Mining & Dreaming Endpoints
    // ============================================================================

    this.app.post("/api/v1/mining/start", async (c) => {
      try {
        let body: Record<string, unknown> = {};
        const contentType = c.req.header("content-type") ?? "";
        if (contentType.includes("application/json")) {
          try {
            body = (await c.req.json()) as Record<string, unknown>;
          } catch {
            return c.json<RESTErrorResponse>(
              { error: "Bad Request", message: "Malformed JSON body" },
              400
            );
          }
        }

        const rawLimit = typeof body.limit === "number" ? body.limit : undefined;
        const limit = rawLimit !== undefined
          ? Math.min(Math.max(Math.floor(rawLimit), 1), 50)
          : undefined;

        const rawProject = typeof body.project === "string" ? body.project : undefined;
        if (rawProject !== undefined && !/^[a-zA-Z0-9._-]{1,128}$/.test(rawProject)) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "Invalid project name. Must match /^[a-zA-Z0-9._-]{1,128}$/." },
            400
          );
        }
        const project = rawProject;

        const mineOptions: { limit?: number; project?: string } = {};
        if (limit !== undefined) mineOptions.limit = limit;
        if (project !== undefined) mineOptions.project = project;

        // Lazily instantiate TranscriptMiner and its dependencies
        if (!this.transcriptMiner) {
          if (!this.userProfileStore) {
            this.userProfileStore = new UserProfileStore();
          }
          // Require an active session to bind the MemoryManager
          const sessionId = this.currentSessionId;
          if (!sessionId) {
            return c.json<RESTErrorResponse>(
              { error: "Bad Request", message: "No active session. Start a session first." },
              400
            );
          }
          const memoryManager = await this.getMemoryManager(sessionId);
          this.transcriptMiner = new TranscriptMiner(
            this.eventStore.getDatabase(),
            memoryManager,
            this.userProfileStore,
            undefined,
            this.eventStore
          );
        }

        const result = await this.transcriptMiner.mine(mineOptions);
        return c.json({ data: result }, 200);
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/mining/status", async (c) => {
      try {
        const db = this.eventStore.getDatabase();

        // Query mining_progress table — may not exist if mining hasn't run yet
        let stats: {
          total: number;
          pending: number;
          processing: number;
          completed: number;
          failed: number;
          facts_extracted: number;
        };

        try {
          const row = db.prepare(`
            SELECT
              COUNT(*) as total,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
              SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
              COALESCE(SUM(facts_extracted), 0) as facts_extracted
            FROM mining_progress
          `).get() as {
            total: number;
            pending: number;
            processing: number;
            completed: number;
            failed: number;
            facts_extracted: number;
          } | null;

          stats = row ?? { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, facts_extracted: 0 };
        } catch (err) {
          // Only swallow "no such table" — mining hasn't run yet
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("no such table")) {
            throw err;
          }
          stats = { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, facts_extracted: 0 };
        }

        return c.json({ data: stats }, 200);
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/insights", async (c) => {
      try {
        const sessionId = this.currentSessionId;
        if (!sessionId) {
          return c.json({ data: [] }, 200);
        }

        const memoryManager = await this.getMemoryManager(sessionId);
        const results = await memoryManager.recall({ category: "derived_insight" as import("../types/index.js").MemoryCategory });

        return c.json({
          data: results.map((r) => ({
            key: r.memory.key,
            value: r.memory.value,
            metadata: r.memory.metadata,
            createdAt: r.memory.createdAt instanceof Date ? r.memory.createdAt.toISOString() : r.memory.createdAt,
            updatedAt: r.memory.updatedAt instanceof Date ? r.memory.updatedAt.toISOString() : r.memory.updatedAt,
          })),
        }, 200);
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.post("/api/v1/dreaming/run", async (c) => {
      try {
        const sessionId = this.currentSessionId;
        if (!sessionId) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "No active session. Start a session first." },
            400
          );
        }

        const memoryManager = await this.getMemoryManager(sessionId);

        // Lazily instantiate DreamingEngine
        if (!this.dreamingEngine) {
          if (!this.userProfileStore) {
            this.userProfileStore = new UserProfileStore();
          }
          this.dreamingEngine = createDreamingEngine(
            memoryManager,
            this.config.contradictionDetector ?? null, // ContradictionDetector — Ollama or OpenAI
            this.userProfileStore,
            this.eventStore
          );
        }

        const result = await this.dreamingEngine.dream(sessionId);
        return c.json({ data: result }, 200);
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/worklog", async (c) => {
      try {
        const sessionId = (c.req.query("sessionId") ?? this.currentSessionId) as SessionId | null;
        if (!sessionId) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "No active session. Start a session first or provide sessionId query param." },
            400
          );
        }

        const rawLimit = c.req.query("limit") ? parseInt(c.req.query("limit") as string, 10) : 100;
        const limit = Number.isNaN(rawLimit) ? 100 : Math.min(Math.max(rawLimit, 1), 1000);

        const allowedTypes = new Set([
          "TOOL_RUN_RECORDED",
          "DIAGNOSTICS_INGESTED",
          "GIT_OPERATION_RECORDED",
          "AGENT_TASK_STARTED",
          "AGENT_TASK_SUMMARY",
          "AGENT_TASK_COMPLETED",
        ]);

        const events = await this.eventStore.getBySession(sessionId);
        const filtered = events.filter((e) => allowedTypes.has(e.eventType));
        const selected = filtered.slice(-limit);

        return c.json({
          data: {
            sessionId,
            count: selected.length,
            events: selected.map((e) => ({
              eventId: e.eventId,
              eventType: e.eventType,
              timestamp: e.timestamp.toISOString(),
              payload: e.payload,
              metadata: e.metadata,
              causedBy: e.causedBy,
            })),
          },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Diagnostics — Additional Endpoints (compare, by-symbol)
    // ============================================================================

    this.app.get("/api/v1/diagnostics/compare", async (c) => {
      try {
        const projectId = c.req.query("projectId");
        const treeHash = c.req.query("treeHash");
        if (!projectId || !treeHash) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "projectId and treeHash query parameters are required" },
            400
          );
        }
        if (projectId.length > 128 || treeHash.length > 200) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Query parameter exceeds maximum length" }, 400);
        }

        const toolNamesStr = c.req.query("toolNames");
        const toolNames = toolNamesStr
          ? toolNamesStr.split(",").map(s => s.trim()).filter(Boolean)
          : ["tsc", "eslint", "prettier"];

        const allRuns: Array<{
          toolName: string;
          analysisId: string;
          status: string;
          createdAt: string;
        }> = [];

        for (const toolName of toolNames) {
          const run = this.diagnosticsStore.getLatestRun({ projectId, treeHash, toolName });
          if (run) {
            allRuns.push({
              toolName: run.tool.name,
              analysisId: run.analysisId,
              status: run.status,
              createdAt: run.createdAt,
            });
          }
        }

        const toolSummaries = allRuns.map(run => {
          const findings = this.diagnosticsStore.listFindings(run.analysisId);
          const bySeverity: Record<string, number> = {};
          const fileSet = new Set<string>();
          for (const finding of findings) {
            bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
            fileSet.add(finding.filePath);
          }
          return {
            toolName: run.toolName, analysisId: run.analysisId, status: run.status,
            createdAt: run.createdAt, total: findings.length, bySeverity, affectedFiles: fileSet.size,
          };
        });

        const aggregateSeverity: Record<string, number> = {};
        for (const summary of toolSummaries) {
          for (const [severity, count] of Object.entries(summary.bySeverity)) {
            aggregateSeverity[severity] = (aggregateSeverity[severity] ?? 0) + count;
          }
        }

        return c.json({
          data: {
            projectId, treeHash,
            toolCount: toolSummaries.length,
            tools: toolSummaries,
            aggregateSeverity,
            totalFindings: toolSummaries.reduce((sum, s) => sum + s.total, 0),
          },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.get("/api/v1/diagnostics/by-symbol", async (c) => {
      try {
        const analysisId = c.req.query("analysisId");
        if (!analysisId) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "analysisId query parameter is required" },
            400
          );
        }
        if (!RESTPingMemServer.ANALYSIS_ID_RE.test(analysisId)) {
          return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid analysisId" }, 400);
        }

        const VALID_GROUP_BY = new Set(["symbol", "file"]);
        const groupByRaw = c.req.query("groupBy") ?? "symbol";
        const groupBy = VALID_GROUP_BY.has(groupByRaw) ? groupByRaw as "symbol" | "file" : "symbol";
        const findings = this.diagnosticsStore.listFindings(analysisId);

        if (groupBy === "symbol") {
          const symbolGroups = new Map<string, {
            symbolName: string; symbolKind: string; filePath: string;
            count: number; bySeverity: Record<string, number>;
          }>();

          for (const finding of findings) {
            if (!finding.symbolId || !finding.symbolName) continue;
            if (!symbolGroups.has(finding.symbolId)) {
              symbolGroups.set(finding.symbolId, {
                symbolName: finding.symbolName, symbolKind: finding.symbolKind ?? "unknown",
                filePath: finding.filePath, count: 0, bySeverity: {},
              });
            }
            const group = symbolGroups.get(finding.symbolId)!;
            group.count += 1;
            group.bySeverity[finding.severity] = (group.bySeverity[finding.severity] ?? 0) + 1;
          }

          const symbols = Array.from(symbolGroups.entries())
            .map(([symbolId, group]) => ({ symbolId, ...group }))
            .sort((a, b) => b.count - a.count);

          return c.json({
            data: {
              analysisId, groupBy: "symbol",
              symbolCount: symbols.length, symbols,
              totalAttributed: symbols.reduce((sum, s) => sum + s.count, 0),
              totalUnattributed: findings.filter(f => !f.symbolId).length,
            },
          });
        } else {
          const fileGroups = new Map<string, { total: number }>();
          for (const finding of findings) {
            if (!fileGroups.has(finding.filePath)) {
              fileGroups.set(finding.filePath, { total: 0 });
            }
            fileGroups.get(finding.filePath)!.total += 1;
          }

          const files = Array.from(fileGroups.entries())
            .map(([filePath, group]) => ({ filePath, total: group.total }))
            .sort((a, b) => b.total - a.total);

          return c.json({
            data: { analysisId, groupBy: "file", fileCount: files.length, files },
          });
        }
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Codebase — Additional Endpoints (list-projects, delete)
    // ============================================================================

    this.app.get("/api/v1/codebase/projects", async (c) => {
      try {
        if (!this.config.ingestionService) {
          return c.json<RESTErrorResponse>(
            { error: "Service Unavailable", message: "Ingestion service not configured" },
            503
          );
        }

        const projectId = c.req.query("projectId") ?? undefined;
        const rawLimit = c.req.query("limit") ? parseInt(c.req.query("limit") as string, 10) : 100;
        const limit = Number.isNaN(rawLimit) ? 100 : Math.min(Math.max(rawLimit, 1), 1000);
        const VALID_SORT = new Set(["lastIngestedAt", "filesCount", "rootPath"]);
        const sortByRaw = c.req.query("sortBy") ?? "lastIngestedAt";
        const sortBy = VALID_SORT.has(sortByRaw) ? sortByRaw as "lastIngestedAt" | "filesCount" | "rootPath" : "lastIngestedAt";

        const options: { limit: number; sortBy: "lastIngestedAt" | "filesCount" | "rootPath"; projectId?: string } = { limit, sortBy };
        if (projectId !== undefined) options.projectId = projectId;

        const projects = await this.config.ingestionService.listProjects(options);

        return c.json({
          data: {
            count: projects.length,
            sortBy,
            projects: projects.map((p) => ({
              projectId: p.projectId, rootPath: p.rootPath, treeHash: p.treeHash,
              filesCount: p.filesCount, chunksCount: p.chunksCount, commitsCount: p.commitsCount,
              lastIngestedAt: p.lastIngestedAt,
            })),
          },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.delete("/api/v1/codebase/projects/:id", async (c) => {
      try {
        // Destructive operation — require admin credentials (default-deny when unconfigured)
        const adminUser = process.env.PING_MEM_ADMIN_USER;
        const adminPass = process.env.PING_MEM_ADMIN_PASS;
        if (!adminUser || !adminPass) {
          return c.json<RESTErrorResponse>(
            { error: "Forbidden", message: "Project deletion disabled: admin credentials not configured" },
            403
          );
        }
        const authHeader = c.req.header("Authorization") ?? "";
        const [, encoded] = authHeader.split(" ", 2);
        const decoded = encoded ? Buffer.from(encoded, "base64").toString() : "";
        const colonIdx = decoded.indexOf(":");
        const user = colonIdx === -1 ? decoded : decoded.slice(0, colonIdx);
        const pass = colonIdx === -1 ? "" : decoded.slice(colonIdx + 1);
        if (!timingSafeStringEqual(user, adminUser) || !timingSafeStringEqual(pass, adminPass)) {
          return c.json<RESTErrorResponse>(
            { error: "Forbidden", message: "Project deletion requires admin credentials (Basic Auth)" },
            403
          );
        }

        if (!this.config.ingestionService) {
          return c.json<RESTErrorResponse>(
            { error: "Service Unavailable", message: "Ingestion service not configured" },
            503
          );
        }

        const projectId = c.req.param("id");
        if (!projectId || projectId.length > 500) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "Invalid project ID" },
            400
          );
        }

        await this.config.ingestionService.deleteProject(projectId);

        // Clean up diagnostics
        this.diagnosticsStore.deleteProject(projectId);

        return c.json({
          data: { success: true, projectId },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Memory — Additional Endpoints (subscribe, unsubscribe, compress)
    // ============================================================================

    this.app.post("/api/v1/memory/subscribe", async (c) => {
      try {
        // REST subscriptions redirect to SSE endpoint — subscriptions are stateful
        return c.json({
          data: {
            success: false,
            message: "REST subscriptions are not supported. Use the SSE endpoint /api/v1/events/stream for real-time events.",
          },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.post("/api/v1/memory/unsubscribe", async (c) => {
      try {
        let rawBody: unknown;
        try { rawBody = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }

        const parseResult = MemoryUnsubscribeSchema.safeParse(rawBody);
        if (!parseResult.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }

        const { subscriptionId } = parseResult.data;
        const success = this.pubsub.unsubscribe(subscriptionId);

        return c.json({
          data: { success, subscriberCount: this.pubsub.subscriberCount },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    this.app.post("/api/v1/memory/compress", async (c) => {
      try {
        const sessionId = this.getSessionIdFromRequest(c);
        if (!sessionId) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: "No active session. Start a session first." },
            400
          );
        }

        let rawBody: unknown;
        try { rawBody = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }

        const parseResult = MemoryCompressSchema.safeParse(rawBody);
        if (!parseResult.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }

        const { channel, category, maxCount } = parseResult.data;
        const memoryManager = await this.getMemoryManager(sessionId);

        const listOptions: { limit?: number; category?: MemoryCategory; channel?: string } = {};
        if (category !== undefined) listOptions.category = category as MemoryCategory;
        if (channel !== undefined) listOptions.channel = channel;
        listOptions.limit = maxCount;

        const memories = memoryManager.list(listOptions);

        if (memories.length === 0) {
          return c.json({
            data: {
              result: {
                facts: [], sourceCount: 0, compressionRatio: 1,
                strategy: "heuristic", digestSaved: false,
              },
            },
          });
        }

        const compressor = new SemanticCompressor();
        const compressionResult = await compressor.compress(memories);

        let digestSaved = false;
        if (compressionResult.facts.length > 0) {
          const digestKey = `digest::${channel ?? "all"}::${category ?? "all"}::${new Date().toISOString()}`;
          const digestValue = compressionResult.facts.join("\n");

          await memoryManager.saveOrUpdate(digestKey, digestValue, {
            category: "digest" as MemoryCategory,
            priority: "normal",
            metadata: {
              sourceCount: compressionResult.sourceCount,
              compressionRatio: compressionResult.compressionRatio,
              strategy: compressionResult.strategy,
              costEstimate: compressionResult.costEstimate,
            },
          });
          digestSaved = true;
        }

        return c.json({
          data: {
            result: {
              facts: compressionResult.facts,
              sourceCount: compressionResult.sourceCount,
              compressionRatio: compressionResult.compressionRatio,
              strategy: compressionResult.strategy,
              costEstimate: compressionResult.costEstimate,
              digestSaved,
            },
          },
        });
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Tool Discovery Endpoints
    // ============================================================================

    this.app.get("/api/v1/tools", (c) => {
      return c.json({
        data: {
          count: TOOLS.length,
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      });
    });

    this.app.get("/api/v1/tools/:name", (c) => {
      const name = c.req.param("name");
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return c.json<RESTErrorResponse>(
          { error: "Not Found", message: `Tool '${name}' not found` },
          404
        );
      }
      return c.json({
        data: {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
      });
    });

    // Tool invocation requires admin auth — this is an RPC gateway to the full MCP tool surface.
    // Read-only tool listing (GET /tools, GET /tools/:name) is available to any authenticated user.
    this.app.post("/api/v1/tools/:name/invoke", async (c) => {
      try {
        // Require admin credentials for tool invocation (defense in depth)
        // Default-deny: if admin creds are not configured, reject all requests (SEC-1 fix)
        const adminUser = process.env.PING_MEM_ADMIN_USER;
        const adminPass = process.env.PING_MEM_ADMIN_PASS;
        if (!adminUser || !adminPass) {
          return c.json<RESTErrorResponse>(
            { error: "Forbidden", message: "Tool invocation disabled: admin credentials not configured" },
            403
          );
        }
        const authHeader = c.req.header("Authorization") ?? "";
        const [, encoded] = authHeader.split(" ", 2);
        const decoded = encoded ? Buffer.from(encoded, "base64").toString() : "";
        const colonIdx = decoded.indexOf(":");
        const user = colonIdx === -1 ? decoded : decoded.slice(0, colonIdx);
        const pass = colonIdx === -1 ? "" : decoded.slice(colonIdx + 1);
        if (!timingSafeStringEqual(user, adminUser) || !timingSafeStringEqual(pass, adminPass)) {
          return c.json<RESTErrorResponse>(
            { error: "Forbidden", message: "Tool invocation requires admin credentials (Basic Auth)" },
            403
          );
        }

        const name = c.req.param("name");
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) {
          return c.json<RESTErrorResponse>(
            { error: "Not Found", message: `Tool '${name}' not found` },
            404
          );
        }

        let rawBody: unknown;
        try { rawBody = await c.req.json(); }
        catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON body" }, 400); }

        const parseResult = ToolInvokeSchema.safeParse(rawBody);
        if (!parseResult.success) {
          return c.json<RESTErrorResponse>(
            { error: "Bad Request", message: parseResult.error.issues[0]?.message ?? "Invalid request" },
            400
          );
        }

        // Validate args against the tool's own input schema (defense in depth)
        const { z } = await import("zod");
        if (tool.inputSchema && typeof tool.inputSchema === "object") {
          const requiredProps = (tool.inputSchema as Record<string, unknown>).required;
          if (Array.isArray(requiredProps)) {
            for (const prop of requiredProps) {
              if (!(prop as string in parseResult.data.args)) {
                return c.json<RESTErrorResponse>(
                  { error: "Bad Request", message: `Missing required argument: ${prop}` },
                  400
                );
              }
            }
          }
        }

        // Lazy-import modules (Bun caches after first call)
        const { GraphToolModule } = await import("../mcp/handlers/GraphToolModule.js");
        const { CausalToolModule } = await import("../mcp/handlers/CausalToolModule.js");
        const { WorklogToolModule } = await import("../mcp/handlers/WorklogToolModule.js");
        const { DiagnosticsToolModule } = await import("../mcp/handlers/DiagnosticsToolModule.js");
        const { CodebaseToolModule } = await import("../mcp/handlers/CodebaseToolModule.js");
        const { MemoryToolModule } = await import("../mcp/handlers/MemoryToolModule.js");
        const { ContextToolModule } = await import("../mcp/handlers/ContextToolModule.js");
        const { KnowledgeToolModule } = await import("../mcp/handlers/KnowledgeToolModule.js");
        const { AgentToolModule } = await import("../mcp/handlers/AgentToolModule.js");

        const state = {
          currentSessionId: this.currentSessionId,
          memoryManagers: this.memoryManagers,
          sessionManager: this.sessionManager,
          eventStore: this.eventStore,
          vectorIndex: this.vectorIndex,
          graphManager: this.graphManager,
          entityExtractor: this.config.entityExtractor ?? null,
          llmEntityExtractor: this.config.llmEntityExtractor ?? null,
          hybridSearchEngine: this.config.hybridSearchEngine ?? null,
          lineageEngine: this.config.lineageEngine ?? null,
          evolutionEngine: this.config.evolutionEngine ?? null,
          ingestionService: this.config.ingestionService ?? null,
          diagnosticsStore: this.diagnosticsStore ?? null,
          summaryGenerator: this.summaryGenerator,
          relevanceEngine: this.relevanceEngine,
          causalGraphManager: this.config.causalGraphManager ?? null,
          causalDiscoveryAgent: this.config.causalDiscoveryAgent ?? null,
          pubsub: this.pubsub,
          knowledgeStore: this.knowledgeStore,
          qdrantClient: this.qdrantClient,
          ccMemoryBridge: null,
          contradictionDetector: this.config.contradictionDetector ?? null,
          writeLockManager: this.writeLockManager,
        };

        const { StructuralToolModule } = await import("../mcp/handlers/StructuralToolModule.js");
        const { MiningToolModule } = await import("../mcp/handlers/MiningToolModule.js");

        const modules = [
          new ContextToolModule(state),
          new GraphToolModule(state),
          new WorklogToolModule(state),
          new DiagnosticsToolModule(state),
          new CodebaseToolModule(state),
          new StructuralToolModule(state),
          new MemoryToolModule(state),
          new CausalToolModule(state),
          new KnowledgeToolModule(state),
          new AgentToolModule(state),
          new MiningToolModule(state),
        ];

        const TOOL_INVOKE_TIMEOUT_MS = 120_000; // 2 min — matches proxy-cli client-side timeout
        const args = parseResult.data.args;
        for (const mod of modules) {
          const result = mod.handle(name, args);
          if (result !== undefined) {
            // retrySafe=false — most MCP tools in the module set are state-changing
            // (context_save, memory_consolidate, knowledge_ingest, trigger_causal_discovery).
            // Conservative default prevents accidental double-writes on retry.
            const data = await withTimeout(
              result,
              TOOL_INVOKE_TIMEOUT_MS,
              `Tool '${name}' timed out after 2 minutes — operation may still be running; do NOT retry state-changing tools`,
              false,
            );

            // Sync session state back from tool module to REST server.
            // When context_session_start runs via /invoke, it updates
            // state.currentSessionId in the module's local state. We need
            // to propagate this back to the REST server so subsequent
            // /invoke calls see the session.
            if (state.currentSessionId !== this.currentSessionId) {
              this.currentSessionId = state.currentSessionId;
            }

            return c.json({ data });
          }
        }

        return c.json<RESTErrorResponse>(
          { error: "Not Found", message: `No handler found for tool '${name}'` },
          404
        );
      } catch (error) {
        return this.handleError(c, error);
      }
    });

    // ============================================================================
    // Shell Event Endpoint
    // ============================================================================
    registerShellRoutes(this.app, {
      eventStore: this.eventStore,
      getCurrentSessionId: () => this.currentSessionId,
    });

    // ============================================================================
    // OpenAPI Spec Endpoint
    // ============================================================================
    registerOpenAPIRoute(this.app);

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
      miningStart: async (options) => {
        if (!this.userProfileStore) {
          this.userProfileStore = new UserProfileStore();
        }
        const sessionId = this.currentSessionId;
        if (!sessionId) {
          throw new Error("No active session. Start a session first.");
        }
        if (!this.transcriptMiner) {
          const memoryManager = await this.getMemoryManager(sessionId);
          this.transcriptMiner = new TranscriptMiner(
            this.eventStore.getDatabase(),
            memoryManager,
            this.userProfileStore,
            undefined,
            this.eventStore
          );
        }
        return this.transcriptMiner.mine(options);
      },
    });
  }

  /**
   * Extract session ID from X-Session-ID header or fall back to currentSessionId.
   * Validates UUID format to prevent injection attacks.
   *
   * When X-Session-ID header is absent and multiple active sessions exist, returns null
   * to force a 400 response — silently picking one session would be incorrect. Callers
   * should always pass the X-Session-ID header to avoid ambiguity.
   */
  private getSessionIdFromRequest(c: Context<AppEnv>, bodySessionId?: string): SessionId | null {
    // Priority 1: X-Session-ID header (most reliable)
    const header = c.req.header("x-session-id");
    if (header) {
      const normalized = header.trim().toLowerCase();
      if (RESTPingMemServer.UUID_RE.test(normalized)) {
        return normalized as SessionId;
      }
      return null;
    }

    // Priority 2: sessionId from request body (common in POST endpoints)
    if (bodySessionId) {
      const normalized = bodySessionId.trim().toLowerCase();
      if (RESTPingMemServer.UUID_RE.test(normalized)) {
        return normalized as SessionId;
      }
    }

    // No header or body sessionId — check how many active sessions exist.
    const activeSessions = this.sessionManager.listSessions().filter((s) => s.status === "active");
    if (activeSessions.length > 1) {
      // Ambiguous: multiple active sessions and no X-Session-ID header. Return null so
      // the caller returns 400 rather than silently picking the wrong session.
      log.warn(
        "getSessionIdFromRequest: no X-Session-ID header and multiple active sessions — cannot pick one. " +
          "Pass X-Session-ID header to disambiguate.",
        { activeCount: activeSessions.length }
      );
      return null;
    }

    // Single active session or no session — fall back to the convenience singleton.
    if (this.currentSessionId) {
      log.warn(
        "getSessionIdFromRequest: no X-Session-ID header — falling back to currentSessionId. " +
          "Clients should pass X-Session-ID header for reliable routing.",
        { sessionId: this.currentSessionId }
      );
    }
    return this.currentSessionId;
  }

  /**
   * Extract API key from X-API-Key header or Authorization: Bearer token.
   */
  private extractApiKey(c: Context<AppEnv>): string | undefined {
    const apiKey = c.req.header("x-api-key");
    if (apiKey) return apiKey.length <= 512 ? apiKey : undefined;
    const authHeader = c.req.header("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      return token.length <= 512 ? token : undefined;
    }
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
    const message = error instanceof Error ? error.message : "Unknown error";
    const isClientError = statusCode >= 400 && statusCode < 500;
    // TimeoutError messages carry retry guidance ("still running") that the
    // client NEEDS to avoid double-writes. Don't sanitize to "internal error".
    const isTimeout = error instanceof Error && error.name === "TimeoutError";

    if (!isClientError && !isTimeout) {
      const requestId = crypto.randomUUID().slice(0, 8);
      console.error(`[REST Server] Error [${requestId}] ${c.req.method} ${c.req.path}:`, error);
      return c.json(
        { error: this.getErrorName(statusCode), message: `An internal error occurred (ref: ${requestId})` },
        statusCode as ContentfulStatusCode
      );
    }

    if (isTimeout) {
      const retrySafe = (error as TimeoutError).retrySafe;
      console.warn(`[REST Server] Timeout: ${c.req.method} ${c.req.path} — ${message}`);
      return c.json(
        {
          error: "Gateway Timeout",
          message,
          retrySafe,
        },
        statusCode as ContentfulStatusCode,
      );
    }

    console.error("[REST Server] Error:", message);
    return c.json(
      { error: this.getErrorName(statusCode), message },
      statusCode as ContentfulStatusCode
    );
  }

  /**
   * Map error to HTTP status code
   */
  private getStatusCode(error: unknown): number {
    if (error instanceof Error) {
      // Use error class name or code property for reliable mapping
      const name = error.name;
      if (name === "TimeoutError") return 504;
      if (name === "MemoryKeyNotFoundError" || name === "AgentNotRegisteredError") return 404;
      if (name === "QuotaExhaustedError" || name === "WriteLockConflictError") return 409;
      if (name === "EvidenceGateRejectionError" || name === "ScopeViolationError") return 403;
      if (name === "MemoryKeyExistsError") return 409;
      if (name === "SchemaValidationError" || name === "InvalidSessionError") return 400;
      // Map session limit errors to 429 Too Many Requests
      if (error.message.includes("Maximum active sessions")) return 429;
      // Check for known error codes
      const codeErr = error as { code?: string };
      if (codeErr.code === "MEMORY_NOT_FOUND") return 404;
      if (codeErr.code === "QUOTA_EXHAUSTED" || codeErr.code === "WRITE_LOCK_CONFLICT") return 409;
      if (codeErr.code === "MEMORY_EXISTS") return 409;
      if (codeErr.code === "INVALID_SESSION") return 400;
      if (codeErr.code === "AGENT_EXPIRED") return 410;
      // Fallback to message-based detection — only for known domain error types
      const isDomainError = "code" in error ||
        /Memory|Agent|Quota|Lock|Evidence|Schema|Scope/.test(error.name ?? "");
      if (isDomainError) {
        if (error.message.includes("not found")) {
          log.warn(`getStatusCode: message-based 404 for '${error.name}'`, { message: error.message.slice(0, 80) });
          return 404;
        }
        if (error.message.includes("invalid") || error.message.includes("required")) {
          log.warn(`getStatusCode: message-based 400 for '${error.name}'`, { message: error.message.slice(0, 80) });
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
      429: "Too Many Requests",
      500: "Internal Server Error",
      503: "Service Unavailable",
    };
    return names[statusCode] ?? "Error";
  }

  /**
   * Get MemoryManager for session, creating if needed.
   * Uses Promise-based deduplication to prevent TOCTOU races.
   */
  private getMemoryManager(sessionId: SessionId): Promise<MemoryManager> {
    const cached = this.memoryManagers.get(sessionId);
    if (cached) return Promise.resolve(cached);

    // Verify the session exists and is active before creating a new MemoryManager.
    // Without this check, callers using a stale/ended sessionId would silently get
    // a fresh (empty) MemoryManager instead of an error.
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return Promise.reject(Object.assign(new Error("Session not found or ended"), { code: "INVALID_SESSION" }));
    }
    if (session.status !== "active") {
      return Promise.reject(Object.assign(new Error("Session not found or ended"), { code: "INVALID_SESSION" }));
    }

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
      writeLockManager: this.writeLockManager,
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
   * Hydrate session state from EventStore before accepting requests.
   * Must be called before start() to restore sessions from prior runs.
   */
  async hydrateSessionState(): Promise<void> {
    await this.sessionManager.hydrate();
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
    // Close SessionManager before EventStore — checkpoint timers depend on EventStore
    await this.sessionManager.close();
    // Close event store only if we own it (not injected externally — caller closes it)
    if (this.ownsEventStore) {
      await this.eventStore.close();
    }
    // Clear cached memory managers
    this.memoryManagers.clear();
    this.managerPromises.clear();
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
 * Extract key facts from a conversation exchange using heuristic patterns.
 * Looks for decisions, facts, preferences, and other notable statements.
 */
function extractFactsFromExchange(exchange: string): Array<{ key: string; value: string }> {
  const facts: Array<{ key: string; value: string }> = [];
  const lines = exchange.split("\n").filter((l) => l.trim().length > 15);
  const seen = new Set<string>();

  // Patterns that indicate notable facts
  const factPatterns = [
    /(?:decided|decision|chose|choosing|picked|selected)\s+(?:to\s+)?(.{15,200})/i,
    /(?:always|never|must|should|don't|do not)\s+(.{10,200})/i,
    /(?:important|critical|key|essential|remember|note)\s*:?\s+(.{10,200})/i,
    /(?:prefer|preference|like|want|need)\s+(.{10,200})/i,
    /(?:the (?:issue|problem|bug|fix|solution|answer|reason|cause) (?:is|was))\s+(.{10,200})/i,
    /(?:use|using|switch(?:ed)? to|migrat(?:ed|ing) to)\s+(\w+(?:\s+\w+){0,5})\s+(?:for|because|instead)/i,
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    for (const pattern of factPatterns) {
      const match = trimmed.match(pattern);
      if (match?.[1]) {
        const value = match[1].trim().replace(/[.!?]+$/, "");
        if (value.length >= 10 && !seen.has(value.toLowerCase())) {
          seen.add(value.toLowerCase());
          // Generate a key from the first few words
          const keyWords = value
            .split(/\s+/)
            .slice(0, 4)
            .join("-")
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "");
          facts.push({ key: `extracted:${keyWords}`, value });
        }
      }
    }
    if (facts.length >= 10) break;
  }

  return facts;
}

/**
 * Create a default REST server configuration
 */
export function createDefaultRESTConfig(
  overrides?: Partial<HTTPServerConfig>
): HTTPServerConfig {
  return {
    port: 3003,
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
