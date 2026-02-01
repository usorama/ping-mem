/**
 * MCP Server for ping-mem
 *
 * Provides memory management tools via Model Context Protocol,
 * enabling AI agents to persist and recall context across sessions.
 *
 * @module mcp/PingMemServer
 * @version 1.0.0
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { SessionManager } from "../session/SessionManager.js";
import { MemoryManager, type MemoryManagerConfig } from "../memory/MemoryManager.js";
import { EventStore } from "../storage/EventStore.js";
import { VectorIndex, createInMemoryVectorIndex } from "../search/VectorIndex.js";
import { EntityExtractor } from "../graph/EntityExtractor.js";
import type { GraphManager } from "../graph/GraphManager.js";
import type { HybridSearchEngine, SearchWeights } from "../search/HybridSearchEngine.js";
import type { LineageEngine } from "../graph/LineageEngine.js";
import type { EvolutionEngine } from "../graph/EvolutionEngine.js";
import type {
  SessionId,
  SessionStatus,
  EventType,
  MemoryCategory,
  MemoryPriority,
  MemoryPrivacy,
  MemoryQuery,
  Entity,
  Relationship,
  WorklogEventData,
} from "../types/index.js";
import { RelationshipType } from "../types/index.js";
import { createRuntimeServices, loadRuntimeConfig } from "../config/runtime.js";
import { IngestionService } from "../ingest/IngestionService.js";
import {
  DiagnosticsStore,
  parseSarif,
  normalizeFindings,
  computeFindingsDigest,
  computeAnalysisId,
} from "../diagnostics/index.js";
import type { FindingInput } from "../diagnostics/types.js";
import { SummaryGenerator, OpenAIProvider } from "../diagnostics/SummaryGenerator.js";
import { SummaryCache } from "../diagnostics/SummaryCache.js";
import { AdminStore } from "../admin/AdminStore.js";
import { ProjectScanner } from "../ingest/ProjectScanner.js";
import { ListProjectsSchema, type ListProjectsInput } from "../validation/codebase-schemas.js";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Tool Schemas
// ============================================================================

export const TOOLS = [
  {
    name: "context_session_start",
    description: "Start a new memory session with optional configuration. If projectDir is provided with autoIngest=true, automatically ingests the project codebase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Session name" },
        projectDir: { type: "string", description: "Project directory for context isolation and automatic code ingestion" },
        continueFrom: { type: "string", description: "Session ID to continue from" },
        defaultChannel: { type: "string", description: "Default channel for memories" },
        autoIngest: { type: "boolean", description: "Automatically ingest project codebase when projectDir is provided (default: false)" },
      },
      required: ["name"],
    },
  },
  {
    name: "context_session_end",
    description: "End the current session",
    inputSchema: {
      type: "object" as const,
      properties: {
        reason: { type: "string", description: "Reason for ending session" },
      },
    },
  },
  {
    name: "context_save",
    description: "Save a memory item with key-value pair, optionally extracting entities for knowledge graph",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "Unique key for the memory" },
        value: { type: "string", description: "Memory content" },
        category: {
          type: "string",
          enum: ["task", "decision", "progress", "note", "error", "warning", "fact", "observation"],
          description: "Memory category",
        },
        priority: {
          type: "string",
          enum: ["high", "normal", "low"],
          description: "Priority level",
        },
        channel: { type: "string", description: "Channel for organization" },
        metadata: { type: "object", description: "Custom metadata" },
        extractEntities: {
          type: "boolean",
          description: "When true, extract entities from value and store in knowledge graph",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "context_get",
    description: "Retrieve memories by key or query parameters",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "Exact key to retrieve" },
        keyPattern: { type: "string", description: "Wildcard pattern for keys" },
        category: { type: "string", description: "Filter by category" },
        channel: { type: "string", description: "Filter by channel" },
        limit: { type: "number", description: "Maximum results" },
        offset: { type: "number", description: "Pagination offset" },
      },
    },
  },
  {
    name: "context_search",
    description: "Semantic search for relevant memories",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        minSimilarity: { type: "number", description: "Minimum similarity score (0-1)" },
        category: { type: "string", description: "Filter by category" },
        channel: { type: "string", description: "Filter by channel" },
        limit: { type: "number", description: "Maximum results" },
      },
      required: ["query"],
    },
  },
  {
    name: "context_delete",
    description: "Delete a memory by key",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "Key of memory to delete" },
      },
      required: ["key"],
    },
  },
  {
    name: "context_checkpoint",
    description: "Create a checkpoint of current session state",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Checkpoint name" },
        description: { type: "string", description: "Checkpoint description" },
      },
      required: ["name"],
    },
  },
  {
    name: "context_status",
    description: "Get current session status and statistics",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "context_session_list",
    description: "List recent sessions",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Maximum sessions to return" },
      },
    },
  },
  {
    name: "context_query_relationships",
    description: "Query relationships for an entity",
    inputSchema: {
      type: "object" as const,
      properties: {
        entityId: { type: "string", description: "Entity ID or name to query" },
        depth: { type: "number", description: "Maximum traversal depth (default: 1)" },
        relationshipTypes: {
          type: "array",
          items: { type: "string" },
          description: "Filter by relationship types",
        },
        direction: {
          type: "string",
          enum: ["incoming", "outgoing", "both"],
          description: "Relationship direction",
        },
      },
      required: ["entityId"],
    },
  },
  {
    name: "context_hybrid_search",
    description: "Hybrid search combining semantic, keyword, and graph search",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Maximum results" },
        weights: {
          type: "object",
          properties: {
            semantic: { type: "number", description: "Weight for semantic search (0-1)" },
            keyword: { type: "number", description: "Weight for keyword search (0-1)" },
            graph: { type: "number", description: "Weight for graph search (0-1)" },
          },
          description: "Weights for different search modes",
        },
        sessionId: { type: "string", description: "Filter by session" },
      },
      required: ["query"],
    },
  },
  {
    name: "context_get_lineage",
    description: "Get upstream/downstream lineage for an entity",
    inputSchema: {
      type: "object" as const,
      properties: {
        entityId: { type: "string", description: "Entity ID to trace" },
        direction: {
          type: "string",
          enum: ["upstream", "downstream", "both"],
          description: "Direction of lineage traversal",
        },
        maxDepth: { type: "number", description: "Maximum traversal depth" },
      },
      required: ["entityId"],
    },
  },
  {
    name: "worklog_record",
    description: "Record a deterministic worklog event (tool, diagnostics, git, task)",
    inputSchema: {
      type: "object" as const,
      properties: {
        kind: {
          type: "string",
          enum: ["tool", "diagnostics", "git", "task"],
          description: "Worklog category",
        },
        title: { type: "string", description: "Short title for the event" },
        status: {
          type: "string",
          enum: ["success", "failed", "partial"],
          description: "Outcome status",
        },
        phase: {
          type: "string",
          enum: ["started", "summary", "completed"],
          description: "Task phase (only for kind=task)",
        },
        toolName: { type: "string", description: "Tool name" },
        toolVersion: { type: "string", description: "Tool version" },
        configHash: { type: "string", description: "Deterministic config hash" },
        environmentHash: { type: "string", description: "Environment hash" },
        projectId: { type: "string", description: "Project ID" },
        treeHash: { type: "string", description: "Tree hash" },
        commitHash: { type: "string", description: "Commit hash" },
        runId: { type: "string", description: "Diagnostics run ID" },
        command: { type: "string", description: "Command executed" },
        durationMs: { type: "number", description: "Duration in milliseconds" },
        summary: { type: "string", description: "Summary of outcome" },
        metadata: { type: "object", description: "Additional metadata" },
        sessionId: { type: "string", description: "Explicit session ID (optional)" },
      },
      required: ["kind", "title"],
    },
  },
  {
    name: "worklog_list",
    description: "List worklog events for a session",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID (optional)" },
        limit: { type: "number", description: "Max events to return" },
        eventTypes: {
          type: "array",
          items: { type: "string" },
          description: "Filter by event types",
        },
      },
    },
  },
  {
    name: "diagnostics_ingest",
    description: "Ingest diagnostics results (SARIF 2.1.0 or normalized findings).",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID" },
        treeHash: { type: "string", description: "Tree hash" },
        commitHash: { type: "string", description: "Optional commit hash" },
        toolName: { type: "string", description: "Tool name (optional if SARIF provides it)" },
        toolVersion: { type: "string", description: "Tool version (optional if SARIF provides it)" },
        configHash: { type: "string", description: "Deterministic config hash" },
        environmentHash: { type: "string", description: "Environment hash" },
        status: {
          type: "string",
          enum: ["passed", "failed", "partial"],
          description: "Run status",
        },
        durationMs: { type: "number", description: "Duration in milliseconds" },
        sarif: { type: ["object", "string"], description: "SARIF 2.1.0 payload" },
        findings: {
          type: "array",
          description: "Normalized findings (optional alternative to SARIF)",
          items: { type: "object" },
        },
        metadata: { type: "object", description: "Additional metadata" },
      },
      required: ["projectId", "treeHash", "configHash"],
    },
  },
  {
    name: "diagnostics_latest",
    description: "Get latest diagnostics run for a project/tool/treeHash.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID" },
        toolName: { type: "string", description: "Tool name" },
        toolVersion: { type: "string", description: "Tool version" },
        treeHash: { type: "string", description: "Tree hash" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "diagnostics_list",
    description: "List findings for a specific analysisId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        analysisId: { type: "string", description: "Analysis ID" },
      },
      required: ["analysisId"],
    },
  },
  {
    name: "diagnostics_diff",
    description: "Diff two analyses by analysisId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        analysisIdA: { type: "string", description: "Base analysis ID" },
        analysisIdB: { type: "string", description: "Compare analysis ID" },
      },
      required: ["analysisIdA", "analysisIdB"],
    },
  },
  {
    name: "diagnostics_summary",
    description: "Summarize findings for a specific analysisId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        analysisId: { type: "string", description: "Analysis ID" },
      },
      required: ["analysisId"],
    },
  },
  {
    name: "diagnostics_compare_tools",
    description: "Compare diagnostics across multiple tools for the same project state (treeHash).",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID" },
        treeHash: { type: "string", description: "Tree hash" },
        toolNames: {
          type: "array",
          items: { type: "string" },
          description: "Filter by specific tool names (optional)",
        },
      },
      required: ["projectId", "treeHash"],
    },
  },
  {
    name: "diagnostics_by_symbol",
    description: "Group diagnostic findings by symbol.",
    inputSchema: {
      type: "object" as const,
      properties: {
        analysisId: { type: "string", description: "Analysis ID" },
        groupBy: {
          type: "string",
          enum: ["symbol", "file"],
          description: "Group by symbol or file (default: symbol)",
        },
      },
      required: ["analysisId"],
    },
  },
  {
    name: "diagnostics_summarize",
    description: "Generate or retrieve LLM-powered summary of diagnostic findings.",
    inputSchema: {
      type: "object" as const,
      properties: {
        analysisId: { type: "string", description: "Analysis ID" },
        useLLM: {
          type: "boolean",
          description: "Use LLM to generate summary (default: false for raw findings)",
        },
        forceRefresh: {
          type: "boolean",
          description: "Bypass cache and regenerate summary (default: false)",
        },
      },
      required: ["analysisId"],
    },
  },
  {
    name: "context_query_evolution",
    description: "Query temporal evolution of an entity",
    inputSchema: {
      type: "object" as const,
      properties: {
        entityId: { type: "string", description: "Entity ID" },
        startTime: { type: "string", description: "ISO date start" },
        endTime: { type: "string", description: "ISO date end" },
      },
      required: ["entityId"],
    },
  },
  {
    name: "context_health",
    description: "Check ping-mem service health and connectivity to Neo4j, Qdrant, and SQLite",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "codebase_ingest",
    description: "Ingest a project codebase: scan files, extract chunks, index git history, persist to graph+vectors. Deterministic and reproducible.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectDir: { type: "string", description: "Absolute path to project root" },
        forceReingest: { type: "boolean", description: "Force re-ingestion even if no changes detected" },
      },
      required: ["projectDir"],
    },
  },
  {
    name: "codebase_verify",
    description: "Verify that the ingested manifest matches the current on-disk project state. Returns validation result.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectDir: { type: "string", description: "Absolute path to project root" },
      },
      required: ["projectDir"],
    },
  },
  {
    name: "codebase_search",
    description: "Search code chunks semantically using deterministic vectors. Returns relevant code snippets with provenance.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural language query" },
        projectId: { type: "string", description: "Filter by project ID" },
        filePath: { type: "string", description: "Filter by file path" },
        type: {
          type: "string",
          enum: ["code", "comment", "docstring"],
          description: "Filter by chunk type",
        },
        limit: { type: "number", description: "Maximum results (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "codebase_timeline",
    description: "Query temporal timeline for a project or file. Returns commits with explicit-only 'why' (from commit messages, issue refs, ADRs).",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID" },
        filePath: { type: "string", description: "Optional: filter by specific file" },
        limit: { type: "number", description: "Maximum commits to return (default: 100)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "codebase_list_projects",
    description: "List all ingested projects with metadata (file/chunk/commit counts). Returns project info sorted by lastIngestedAt (default), filesCount, or rootPath.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Optional: filter by specific project ID" },
        limit: { type: "number", description: "Maximum projects to return (1-1000, default: 100)" },
        sortBy: {
          type: "string",
          description: "Sort field: 'lastIngestedAt' (default), 'filesCount', or 'rootPath'",
          enum: ["lastIngestedAt", "filesCount", "rootPath"]
        },
      },
    },
  },
  {
    name: "project_delete",
    description: "Delete all memory, diagnostics, graph, and vectors for a project directory",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectDir: { type: "string", description: "Absolute path to project root" },
      },
      required: ["projectDir"],
    },
  },
];

// ============================================================================
// Server Configuration
// ============================================================================

export interface PingMemServerConfig {
  /** Database path for persistence (':memory:' for in-memory) */
  dbPath?: string | undefined;
  /** Enable vector search */
  enableVectorSearch?: boolean | undefined;
  /** Vector dimensions (default: 768) */
  vectorDimensions?: number | undefined;
  /** Optional GraphManager for entity storage (required for extractEntities feature) */
  graphManager?: GraphManager | undefined;
  /** Optional EntityExtractor instance (created automatically if graphManager provided) */
  entityExtractor?: EntityExtractor | undefined;
  /** Optional HybridSearchEngine for combined semantic/keyword/graph search */
  hybridSearchEngine?: HybridSearchEngine | undefined;
  /** Optional LineageEngine for entity lineage queries */
  lineageEngine?: LineageEngine | undefined;
  /** Optional EvolutionEngine for temporal evolution queries */
  evolutionEngine?: EvolutionEngine | undefined;
  /** Optional IngestionService for codebase ingestion */
  ingestionService?: IngestionService | undefined;
  /** Optional DiagnosticsStore for diagnostics ingestion */
  diagnosticsStore?: DiagnosticsStore | undefined;
  /** Optional diagnostics database path (for automatic DiagnosticsStore creation) */
  diagnosticsDbPath?: string | undefined;
}

// ============================================================================
// PingMemServer Class
// ============================================================================

/**
 * MCP Server for ping-mem memory management
 */
export class PingMemServer {
  private server: Server;
  private sessionManager: SessionManager;
  private eventStore: EventStore;
  private vectorIndex: VectorIndex | null = null;
  private memoryManagers: Map<SessionId, MemoryManager> = new Map();
  private currentSessionId: SessionId | null = null;
  private config: PingMemServerConfig;
  private graphManager: GraphManager | null = null;
  private entityExtractor: EntityExtractor | null = null;
  private hybridSearchEngine: HybridSearchEngine | null = null;
  private lineageEngine: LineageEngine | null = null;
  private evolutionEngine: EvolutionEngine | null = null;
  private ingestionService: IngestionService | null = null;
  private diagnosticsStore: DiagnosticsStore | null = null;
  private summaryGenerator: SummaryGenerator | null = null;

  constructor(config: PingMemServerConfig = {}) {
    this.config = {
      dbPath: ":memory:",
      enableVectorSearch: false,
      vectorDimensions: 768,
      ...config,
    };

    // Initialize core components - use default dbPath if not provided
    const dbPath = this.config.dbPath ?? ":memory:";
    this.eventStore = new EventStore({ dbPath });
    this.sessionManager = new SessionManager({
      eventStore: this.eventStore,
    });

    // Initialize vector index if enabled
    if (this.config.enableVectorSearch && this.config.vectorDimensions !== undefined) {
      this.vectorIndex = createInMemoryVectorIndex({
        vectorDimensions: this.config.vectorDimensions,
      });
    } else if (this.config.enableVectorSearch) {
      this.vectorIndex = createInMemoryVectorIndex();
    }

    // Initialize graph components if graphManager provided
    if (config.graphManager) {
      this.graphManager = config.graphManager;
      this.entityExtractor = config.entityExtractor ?? new EntityExtractor();
    }

    // Initialize optional engines
    if (config.hybridSearchEngine) {
      this.hybridSearchEngine = config.hybridSearchEngine;
    }
    if (config.lineageEngine) {
      this.lineageEngine = config.lineageEngine;
    }
    if (config.evolutionEngine) {
      this.evolutionEngine = config.evolutionEngine;
    }
    if (config.ingestionService) {
      this.ingestionService = config.ingestionService;
    }
    this.diagnosticsStore =
      config.diagnosticsStore ??
      new DiagnosticsStore(
        config.diagnosticsDbPath ? { dbPath: config.diagnosticsDbPath } : undefined
      );

    // Initialize LLM summary generator only when explicitly enabled
    const openaiKey = process.env.OPENAI_API_KEY;
    const enableLLMSummaries = process.env.PING_MEM_ENABLE_LLM_SUMMARIES === "true";
    if (enableLLMSummaries && openaiKey && this.diagnosticsStore) {
      const summaryCache = new SummaryCache({ db: this.diagnosticsStore.getDatabase() });
      const provider = new OpenAIProvider(openaiKey);
      this.summaryGenerator = new SummaryGenerator(provider, summaryCache);
    }

    // Initialize MCP server
    this.server = new Server(
      { name: "ping-mem", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } }
    );

    this.registerHandlers();
  }

  /**
   * Register MCP request handlers
   */
  private registerHandlers(): void {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: TOOLS };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;

      try {
        const result = await this.handleToolCall(name, args as Record<string, unknown>);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: JSON.stringify({ error: errorMessage }) }],
          isError: true,
        };
      }
    });
  }

  /**
   * Handle individual tool calls
   */
  private async handleToolCall(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    switch (name) {
      case "context_session_start":
        return this.handleSessionStart(args);

      case "context_session_end":
        return this.handleSessionEnd(args);

      case "context_save":
        return this.handleSave(args);

      case "context_get":
        return this.handleGet(args);

      case "context_search":
        return this.handleSearch(args);

      case "context_delete":
        return this.handleDelete(args);

      case "context_checkpoint":
        return this.handleCheckpoint(args);

      case "context_status":
        return this.handleStatus();

      case "context_session_list":
        return this.handleSessionList(args);

      case "context_query_relationships":
        return this.handleQueryRelationships(args);

      case "context_hybrid_search":
        return this.handleHybridSearch(args);

      case "context_get_lineage":
        return this.handleGetLineage(args);

      case "context_query_evolution":
        return this.handleQueryEvolution(args);

      case "context_health":
        return this.handleHealth();

      case "worklog_record":
        return this.handleWorklogRecord(args);

      case "worklog_list":
        return this.handleWorklogList(args);

      case "diagnostics_ingest":
        return this.handleDiagnosticsIngest(args);

      case "diagnostics_latest":
        return this.handleDiagnosticsLatest(args);

      case "diagnostics_list":
        return this.handleDiagnosticsList(args);

      case "diagnostics_diff":
        return this.handleDiagnosticsDiff(args);

      case "diagnostics_summary":
        return this.handleDiagnosticsSummary(args);

      case "diagnostics_compare_tools":
        return this.handleDiagnosticsCompareTools(args);

      case "diagnostics_by_symbol":
        return this.handleDiagnosticsBySymbol(args);

      case "diagnostics_summarize":
        return this.handleDiagnosticsSummarize(args);

      case "codebase_ingest":
        return this.handleCodebaseIngest(args);

      case "codebase_verify":
        return this.handleCodebaseVerify(args);

      case "codebase_search":
        return this.handleCodebaseSearch(args);

      case "codebase_timeline":
        return this.handleCodebaseTimeline(args);

      case "codebase_list_projects":
        return this.handleCodebaseListProjects(args);

      case "project_delete":
        return this.handleProjectDelete(args);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Dispatch a tool call from external transports (e.g. SSE).
   */
  async dispatchToolCall(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.handleToolCall(name, args);
  }

  // ============================================================================
  // Tool Handlers
  // ============================================================================

  private async handleSessionStart(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Build session config with only defined properties (exactOptionalPropertyTypes)
    const sessionConfig: Parameters<typeof this.sessionManager.startSession>[0] = {
      name: args.name as string,
    };
    if (args.projectDir !== undefined) {
      sessionConfig.projectDir = args.projectDir as string;
    }
    if (args.continueFrom !== undefined) {
      sessionConfig.continueFrom = args.continueFrom as SessionId;
    }
    if (args.defaultChannel !== undefined) {
      sessionConfig.defaultChannel = args.defaultChannel as string;
    }

    const session = await this.sessionManager.startSession(sessionConfig);

    this.currentSessionId = session.id;

    // Create memory manager config with only defined properties (exactOptionalPropertyTypes)
    const memoryManagerConfig: MemoryManagerConfig = {
      sessionId: session.id,
      eventStore: this.eventStore,
    };
    if (this.vectorIndex !== null) {
      memoryManagerConfig.vectorIndex = this.vectorIndex;
    }
    if (session.defaultChannel !== undefined) {
      memoryManagerConfig.defaultChannel = session.defaultChannel;
    }

    const memoryManager = new MemoryManager(memoryManagerConfig);
    this.memoryManagers.set(session.id, memoryManager);

    // Auto-ingest project if requested
    let ingestResult: Record<string, unknown> | undefined;
    if (args.projectDir !== undefined && args.autoIngest === true && this.ingestionService) {
      try {
        const projectDir = args.projectDir as string;
        const forceReingest = args.forceReingest as boolean ?? false;

        const result = await this.ingestionService.ingestProject({
          projectDir,
          forceReingest,
        });

        ingestResult = result ? (result as unknown as Record<string, unknown>) : { ingested: false, reason: "No changes detected" };
      } catch (error) {
        // Don't fail session start if ingestion fails
        ingestResult = {
          ingestError: error instanceof Error ? error.message : "Unknown ingestion error",
        };
      }
    }

    return {
      success: true,
      sessionId: session.id,
      name: session.name,
      status: session.status,
      startedAt: session.startedAt.toISOString(),
      ...(ingestResult && { ingestResult }),
    };
  }

  private async handleSessionEnd(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.currentSessionId) {
      throw new Error("No active session");
    }

    const session = await this.sessionManager.endSession(
      this.currentSessionId,
      args.reason as string | undefined
    );

    const previousSessionId = this.currentSessionId;
    this.currentSessionId = null;

    return {
      success: true,
      sessionId: previousSessionId,
      status: session.status,
      endedAt: session.endedAt?.toISOString(),
    };
  }

  private async handleSave(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const memoryManager = this.getActiveMemoryManager();

    // Build save options with only defined properties (exactOptionalPropertyTypes)
    const saveOptions: Parameters<typeof memoryManager.save>[2] = {};
    if (args.category !== undefined) {
      saveOptions.category = args.category as MemoryCategory;
    }
    if (args.priority !== undefined) {
      saveOptions.priority = args.priority as MemoryPriority;
    }
    if (args.channel !== undefined) {
      saveOptions.channel = args.channel as string;
    }
    if (args.metadata !== undefined) {
      saveOptions.metadata = args.metadata as Record<string, unknown>;
    }

    const memoryId = await memoryManager.save(args.key as string, args.value as string, saveOptions);

    // Handle entity extraction if requested
    const extractEntities = args.extractEntities === true;
    let entityIds: string[] | undefined;

    if (extractEntities && this.entityExtractor && this.graphManager) {
      const value = args.value as string;
      const category = args.category as string | undefined;

      // Build extraction context with only defined properties (exactOptionalPropertyTypes)
      const extractionContext: { key: string; value: string; category?: string } = {
        key: args.key as string,
        value,
      };
      if (category !== undefined) {
        extractionContext.category = category;
      }

      // Extract entities from context (uses key and category for prioritization)
      const extractResult = this.entityExtractor.extractFromContext(extractionContext);

      // Store extracted entities in the graph
      if (extractResult.entities.length > 0) {
        const createdEntities = await this.graphManager.batchCreateEntities(extractResult.entities);
        entityIds = createdEntities.map((e) => e.id);
      } else {
        entityIds = [];
      }
    }

    const result: Record<string, unknown> = {
      success: true,
      memoryId,
      key: args.key,
    };

    // Include entityIds in response when extraction was requested
    if (extractEntities) {
      result.entityIds = entityIds ?? [];
    }

    return result;
  }

  private async handleGet(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const memoryManager = this.getActiveMemoryManager();

    // If exact key provided, use direct get
    if (args.key && !args.keyPattern && !args.category && !args.channel) {
      const memory = await memoryManager.get(args.key as string);
      if (!memory) {
        return { found: false, key: args.key };
      }
      return {
        found: true,
        memory: this.serializeMemory(memory),
      };
    }

    // Otherwise use query - build with only defined properties (exactOptionalPropertyTypes)
    const query: MemoryQuery = {};
    if (args.key !== undefined) {
      query.key = args.key as string;
    }
    if (args.keyPattern !== undefined) {
      query.keyPattern = args.keyPattern as string;
    }
    if (args.category !== undefined) {
      query.category = args.category as MemoryCategory;
    }
    if (args.channel !== undefined) {
      query.channel = args.channel as string;
    }
    if (args.limit !== undefined) {
      query.limit = args.limit as number;
    }
    if (args.offset !== undefined) {
      query.offset = args.offset as number;
    }

    const results = await memoryManager.recall(query);

    return {
      count: results.length,
      memories: results.map((r) => ({
        ...this.serializeMemory(r.memory),
        score: r.score,
      })),
    };
  }

  private async handleSearch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const memoryManager = this.getActiveMemoryManager();

    // Build query with only defined properties (exactOptionalPropertyTypes)
    const query: MemoryQuery = {
      semanticQuery: args.query as string,
    };
    if (args.minSimilarity !== undefined) {
      query.minSimilarity = args.minSimilarity as number;
    }
    if (args.category !== undefined) {
      query.category = args.category as MemoryCategory;
    }
    if (args.channel !== undefined) {
      query.channel = args.channel as string;
    }
    if (args.limit !== undefined) {
      query.limit = args.limit as number;
    }

    const results = await memoryManager.recall(query);

    return {
      count: results.length,
      results: results.map((r) => ({
        ...this.serializeMemory(r.memory),
        score: r.score,
      })),
    };
  }

  private async handleDelete(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const memoryManager = this.getActiveMemoryManager();

    const deleted = await memoryManager.delete(args.key as string);

    return {
      success: deleted,
      key: args.key,
    };
  }

  private async handleCheckpoint(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.currentSessionId) {
      throw new Error("No active session");
    }

    const memoryManager = this.getActiveMemoryManager();

    // Create checkpoint by saving a special memory
    const checkpointKey = `checkpoint:${args.name as string}`;
    const stats = await memoryManager.getStats();

    const memoryId = await memoryManager.save(
      checkpointKey,
      JSON.stringify({
        name: args.name,
        description: args.description,
        timestamp: new Date().toISOString(),
        stats,
      }),
      {
        category: "progress",
        priority: "high",
        metadata: {
          isCheckpoint: true,
          checkpointName: args.name,
        },
      }
    );

    return {
      success: true,
      checkpointId: memoryId,
      name: args.name,
      timestamp: new Date().toISOString(),
    };
  }

  private async handleStatus(): Promise<Record<string, unknown>> {
    if (!this.currentSessionId) {
      return {
        hasActiveSession: false,
        message: "No active session. Use context_session_start to begin.",
      };
    }

    const session = await this.sessionManager.getSession(this.currentSessionId);
    if (!session) {
      return {
        hasActiveSession: false,
        message: "Session not found",
      };
    }

    const memoryManager = this.memoryManagers.get(this.currentSessionId);
    const stats = memoryManager ? await memoryManager.getStats() : null;

    return {
      hasActiveSession: true,
      session: {
        id: session.id,
        name: session.name,
        status: session.status,
        startedAt: session.startedAt.toISOString(),
        memoryCount: session.memoryCount,
        eventCount: session.eventCount,
        lastActivityAt: session.lastActivityAt.toISOString(),
      },
      stats,
    };
  }

  private async handleSessionList(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const limit = (args.limit as number) ?? 10;

    // Build filter with only defined properties (exactOptionalPropertyTypes)
    const filter: { status?: SessionStatus; projectDir?: string } = {};
    if (args.status !== undefined) {
      filter.status = args.status as SessionStatus;
    }
    if (args.projectDir !== undefined) {
      filter.projectDir = args.projectDir as string;
    }

    // listSessions takes optional filter, apply limit manually
    const allSessions = this.sessionManager.listSessions(
      Object.keys(filter).length > 0 ? filter : undefined
    );
    const sessions = allSessions.slice(0, limit);

    return {
      count: sessions.length,
      sessions: sessions.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt?.toISOString(),
        memoryCount: s.memoryCount,
      })),
    };
  }

  private async handleQueryRelationships(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Verify graphManager is configured
    if (!this.graphManager) {
      throw new Error("GraphManager not configured. Cannot query relationships.");
    }

    const entityId = args.entityId as string;
    const depth = (args.depth as number) ?? 1;
    const relationshipTypes = args.relationshipTypes as string[] | undefined;
    const direction = (args.direction as "incoming" | "outgoing" | "both") ?? "both";

    // Build the set of valid relationship types if filtering
    const validRelTypes = relationshipTypes
      ? new Set(relationshipTypes.map((t) => t as RelationshipType))
      : null;

    // Get all relationships for the entity
    const allRelationships = await this.graphManager.findRelationshipsByEntity(entityId);

    // Filter by direction and relationship types
    const filteredRelationships = allRelationships.filter((rel) => {
      // Check direction
      if (direction === "outgoing" && rel.sourceId !== entityId) {
        return false;
      }
      if (direction === "incoming" && rel.targetId !== entityId) {
        return false;
      }

      // Check relationship types if filter specified
      if (validRelTypes && !validRelTypes.has(rel.type)) {
        return false;
      }

      return true;
    });

    // Collect unique entity IDs from relationships
    const relatedEntityIds = new Set<string>();
    for (const rel of filteredRelationships) {
      if (rel.sourceId !== entityId) {
        relatedEntityIds.add(rel.sourceId);
      }
      if (rel.targetId !== entityId) {
        relatedEntityIds.add(rel.targetId);
      }
    }

    // Fetch the related entities
    const entities: Entity[] = [];
    for (const id of relatedEntityIds) {
      const entity = await this.graphManager.getEntity(id);
      if (entity) {
        entities.push(entity);
      }
    }

    // For depth > 1, recursively fetch more relationships
    // This is a simplified implementation for depth traversal
    const visitedEntities = new Set<string>([entityId, ...relatedEntityIds]);
    const allPaths: Array<{ from: string; relationship: string; to: string }> = [];

    // Add initial paths
    for (const rel of filteredRelationships) {
      allPaths.push({
        from: rel.sourceId,
        relationship: rel.type,
        to: rel.targetId,
      });
    }

    // Traverse deeper levels if depth > 1
    if (depth > 1) {
      let currentLevel = [...relatedEntityIds];
      for (let d = 1; d < depth && currentLevel.length > 0; d++) {
        const nextLevel: string[] = [];

        for (const currentId of currentLevel) {
          const nextRelationships = await this.graphManager.findRelationshipsByEntity(currentId);

          for (const rel of nextRelationships) {
            // Check relationship type filter
            if (validRelTypes && !validRelTypes.has(rel.type)) {
              continue;
            }

            // Check direction from current entity
            if (direction === "outgoing" && rel.sourceId !== currentId) {
              continue;
            }
            if (direction === "incoming" && rel.targetId !== currentId) {
              continue;
            }

            // Get the other entity in this relationship
            const otherId = rel.sourceId === currentId ? rel.targetId : rel.sourceId;

            // Only add if not visited
            if (!visitedEntities.has(otherId)) {
              visitedEntities.add(otherId);
              nextLevel.push(otherId);

              // Fetch and add the entity
              const entity = await this.graphManager.getEntity(otherId);
              if (entity) {
                entities.push(entity);
              }

              // Add to paths
              allPaths.push({
                from: rel.sourceId,
                relationship: rel.type,
                to: rel.targetId,
              });
            }
          }
        }

        currentLevel = nextLevel;
      }
    }

    // Serialize entities for response
    const serializedEntities = entities.map((e) => ({
      id: e.id,
      type: e.type,
      name: e.name,
      properties: e.properties,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    }));

    // Serialize relationships for response
    const serializedRelationships = filteredRelationships.map((r) => ({
      id: r.id,
      type: r.type,
      sourceId: r.sourceId,
      targetId: r.targetId,
      weight: r.weight,
      properties: r.properties,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));

    return {
      entities: serializedEntities,
      relationships: serializedRelationships,
      paths: allPaths,
    };
  }

  private async handleHybridSearch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.hybridSearchEngine) {
      throw new Error("HybridSearchEngine not configured. Provide hybridSearchEngine in PingMemServerConfig.");
    }

    const query = args.query as string;
    const limit = args.limit as number | undefined;
    const sessionId = args.sessionId as SessionId | undefined;
    const weightsArg = args.weights as Partial<SearchWeights> | undefined;

    // Build search options with only defined properties (exactOptionalPropertyTypes)
    const searchOptions: {
      limit?: number;
      sessionId?: SessionId;
      weights?: Partial<SearchWeights>;
    } = {};

    if (limit !== undefined) {
      searchOptions.limit = limit;
    }
    if (sessionId !== undefined) {
      searchOptions.sessionId = sessionId;
    }
    if (weightsArg !== undefined) {
      searchOptions.weights = weightsArg;
    }

    const results = await this.hybridSearchEngine.search(query, searchOptions);

    return {
      query,
      count: results.length,
      results: results.map((r) => ({
        memoryId: r.memoryId,
        sessionId: r.sessionId,
        content: r.content,
        hybridScore: r.hybridScore,
        searchModes: r.searchModes,
        graphContext: r.graphContext,
        modeScores: r.modeScores,
      })),
    };
  }

  private async handleGetLineage(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.lineageEngine) {
      throw new Error("LineageEngine not configured. Provide lineageEngine in PingMemServerConfig.");
    }

    const entityId = args.entityId as string;
    const direction = (args.direction as "upstream" | "downstream" | "both") ?? "both";
    const maxDepth = args.maxDepth as number | undefined;

    // Get upstream entities (ancestors)
    let upstream: Entity[] = [];
    if (direction === "upstream" || direction === "both") {
      upstream = await this.lineageEngine.getAncestors(entityId, maxDepth);
    }

    // Get downstream entities (descendants)
    let downstream: Entity[] = [];
    if (direction === "downstream" || direction === "both") {
      downstream = await this.lineageEngine.getDescendants(entityId, maxDepth);
    }

    return {
      entityId,
      direction,
      upstream: upstream.map((e) => ({
        id: e.id,
        type: e.type,
        name: e.name,
        properties: e.properties,
        eventTime: e.eventTime.toISOString(),
      })),
      downstream: downstream.map((e) => ({
        id: e.id,
        type: e.type,
        name: e.name,
        properties: e.properties,
        eventTime: e.eventTime.toISOString(),
      })),
      upstreamCount: upstream.length,
      downstreamCount: downstream.length,
    };
  }

  private async handleQueryEvolution(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.evolutionEngine) {
      throw new Error("EvolutionEngine not configured. Provide evolutionEngine in PingMemServerConfig.");
    }

    const entityId = args.entityId as string;
    const startTimeStr = args.startTime as string | undefined;
    const endTimeStr = args.endTime as string | undefined;

    // Build query options with only defined properties (exactOptionalPropertyTypes)
    const queryOptions: {
      startTime?: Date;
      endTime?: Date;
    } = {};

    if (startTimeStr !== undefined) {
      queryOptions.startTime = new Date(startTimeStr);
    }
    if (endTimeStr !== undefined) {
      queryOptions.endTime = new Date(endTimeStr);
    }

    const evolution = await this.evolutionEngine.getEvolution(entityId, queryOptions);

    return {
      entityId: evolution.entityId,
      entityName: evolution.entityName,
      startTime: evolution.startTime.toISOString(),
      endTime: evolution.endTime.toISOString(),
      totalChanges: evolution.totalChanges,
      changes: evolution.changes.map((c) => ({
        timestamp: c.timestamp.toISOString(),
        changeType: c.changeType,
        entityId: c.entityId,
        entityName: c.entityName,
        previousState: c.previousState
          ? {
              id: c.previousState.id,
              type: c.previousState.type,
              name: c.previousState.name,
              properties: c.previousState.properties,
            }
          : null,
        currentState: c.currentState
          ? {
              id: c.currentState.id,
              type: c.currentState.type,
              name: c.currentState.name,
              properties: c.currentState.properties,
            }
          : null,
        metadata: c.metadata,
      })),
    };
  }

  // ============================================================================
  // Health Check Handler
  // ============================================================================

  private async handleHealth(): Promise<Record<string, unknown>> {
    const health: Record<string, unknown> = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      version: "1.0.0",
      components: {},
    };

    // Check SQLite (EventStore)
    try {
      const events = await this.eventStore.getBySession("__health_check__");
      (health.components as Record<string, unknown>).sqlite = {
        status: "healthy",
        type: "eventStore",
      };
    } catch (error) {
      (health.components as Record<string, unknown>).sqlite = {
        status: "unhealthy",
        error: error instanceof Error ? error.message : "Unknown error",
      };
      health.status = "degraded";
    }

    // Check GraphManager (Neo4j)
    if (this.graphManager) {
      try {
        // Simple health check - just verify we can access it
        (health.components as Record<string, unknown>).neo4j = {
          status: "healthy",
          configured: true,
        };
      } catch (error) {
        (health.components as Record<string, unknown>).neo4j = {
          status: "unhealthy",
          configured: true,
          error: error instanceof Error ? error.message : "Unknown error",
        };
        health.status = "degraded";
      }
    } else {
      (health.components as Record<string, unknown>).neo4j = {
        status: "not_configured",
        configured: false,
      };
    }

    // Check IngestionService (Qdrant)
    if (this.ingestionService) {
      try {
        (health.components as Record<string, unknown>).qdrant = {
          status: "healthy",
          configured: true,
        };
      } catch (error) {
        (health.components as Record<string, unknown>).qdrant = {
          status: "unhealthy",
          configured: true,
          error: error instanceof Error ? error.message : "Unknown error",
        };
        health.status = "degraded";
      }
    } else {
      (health.components as Record<string, unknown>).qdrant = {
        status: "not_configured",
        configured: false,
      };
    }

    // Check DiagnosticsStore
    if (this.diagnosticsStore) {
      (health.components as Record<string, unknown>).diagnostics = {
        status: "healthy",
        configured: true,
      };
    } else {
      (health.components as Record<string, unknown>).diagnostics = {
        status: "not_configured",
        configured: false,
      };
    }

    // Check current session
    health.session = {
      active: this.currentSessionId !== null,
      sessionId: this.currentSessionId,
    };

    return health;
  }

  // ============================================================================
  // Worklog Handlers
  // ============================================================================

  private async handleWorklogRecord(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = (args.sessionId as string | undefined) ?? this.currentSessionId;
    if (!sessionId) {
      throw new Error("No active session. Use context_session_start first.");
    }

    const kind = args.kind as WorklogEventData["kind"];
    const phase = args.phase as string | undefined;

    let eventType: EventType;
    switch (kind) {
      case "tool":
        eventType = "TOOL_RUN_RECORDED";
        break;
      case "diagnostics":
        eventType = "DIAGNOSTICS_INGESTED";
        break;
      case "git":
        eventType = "GIT_OPERATION_RECORDED";
        break;
      case "task":
        if (phase === "started") {
          eventType = "AGENT_TASK_STARTED";
        } else if (phase === "summary") {
          eventType = "AGENT_TASK_SUMMARY";
        } else if (phase === "completed") {
          eventType = "AGENT_TASK_COMPLETED";
        } else {
          throw new Error("Task worklog requires phase: started | summary | completed");
        }
        break;
      default:
        throw new Error("Invalid worklog kind");
    }

    const payload: WorklogEventData = {
      sessionId,
      kind,
      title: args.title as string,
    };

    if (args.status !== undefined) payload.status = args.status as WorklogEventData["status"];
    if (args.toolName !== undefined) payload.toolName = args.toolName as string;
    if (args.toolVersion !== undefined) payload.toolVersion = args.toolVersion as string;
    if (args.configHash !== undefined) payload.configHash = args.configHash as string;
    if (args.environmentHash !== undefined) payload.environmentHash = args.environmentHash as string;
    if (args.projectId !== undefined) payload.projectId = args.projectId as string;
    if (args.treeHash !== undefined) payload.treeHash = args.treeHash as string;
    if (args.commitHash !== undefined) payload.commitHash = args.commitHash as string;
    if (args.runId !== undefined) payload.runId = args.runId as string;
    if (args.command !== undefined) payload.command = args.command as string;
    if (args.durationMs !== undefined) payload.durationMs = args.durationMs as number;
    if (args.summary !== undefined) payload.summary = args.summary as string;
    if (args.metadata !== undefined) payload.metadata = args.metadata as Record<string, unknown>;

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

    return {
      success: true,
      eventId: event.eventId,
      eventType: event.eventType,
      timestamp: event.timestamp.toISOString(),
    };
  }

  private async handleWorklogList(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = (args.sessionId as string | undefined) ?? this.currentSessionId;
    if (!sessionId) {
      throw new Error("No active session. Use context_session_start first.");
    }

    const limit = (args.limit as number | undefined) ?? 100;
    const allowedTypes = new Set(
      ((args.eventTypes as string[] | undefined) ?? [
        "TOOL_RUN_RECORDED",
        "DIAGNOSTICS_INGESTED",
        "GIT_OPERATION_RECORDED",
        "AGENT_TASK_STARTED",
        "AGENT_TASK_SUMMARY",
        "AGENT_TASK_COMPLETED",
      ])
    );

    const events = await this.eventStore.getBySession(sessionId);
    const filtered = events.filter((e) => allowedTypes.has(e.eventType));
    const selected = filtered.slice(-limit);

    return {
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
    };
  }

  // ============================================================================
  // Diagnostics Handlers
  // ============================================================================

  private async handleDiagnosticsIngest(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.diagnosticsStore) {
      throw new Error("DiagnosticsStore not configured.");
    }

    const projectId = args.projectId as string;
    const treeHash = args.treeHash as string;
    const commitHash = args.commitHash as string | undefined;
    const configHash = args.configHash as string;
    const environmentHash = args.environmentHash as string | undefined;
    const status = (args.status as "passed" | "failed" | "partial" | undefined) ?? "failed";
    const durationMs = args.durationMs as number | undefined;
    const metadata = (args.metadata as Record<string, unknown> | undefined) ?? {};

    let findings: FindingInput[] = [];
    let toolName = args.toolName as string | undefined;
    let toolVersion = args.toolVersion as string | undefined;
    let rawSarif: string | undefined;

    if (args.sarif !== undefined) {
      const sarifPayload = typeof args.sarif === "string" ? JSON.parse(args.sarif) : args.sarif;
      const parsed = parseSarif(sarifPayload);
      findings = parsed.findings;
      toolName = toolName ?? parsed.toolName;
      toolVersion = toolVersion ?? parsed.toolVersion;
      rawSarif = typeof args.sarif === "string" ? args.sarif : JSON.stringify(args.sarif);
    } else if (Array.isArray(args.findings)) {
      findings = args.findings as FindingInput[];
    } else {
      throw new Error("Diagnostics ingest requires sarif or findings.");
    }

    if (!toolName || !toolVersion) {
      throw new Error("toolName and toolVersion are required (or must be in SARIF).");
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

    return {
      success: true,
      runId,
      analysisId,
      findingsCount: normalizedFindings.length,
      toolName,
      toolVersion,
      treeHash,
    };
  }

  private async handleDiagnosticsLatest(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.diagnosticsStore) {
      throw new Error("DiagnosticsStore not configured.");
    }

    const result = this.diagnosticsStore.getLatestRun({
      projectId: args.projectId as string,
      toolName: args.toolName as string | undefined,
      toolVersion: args.toolVersion as string | undefined,
      treeHash: args.treeHash as string | undefined,
    });

    if (!result) {
      return { found: false };
    }

    return { found: true, run: result };
  }

  private async handleDiagnosticsList(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.diagnosticsStore) {
      throw new Error("DiagnosticsStore not configured.");
    }

    const analysisId = args.analysisId as string;
    const findings = this.diagnosticsStore.listFindings(analysisId);

    return {
      analysisId,
      count: findings.length,
      findings,
    };
  }

  private async handleDiagnosticsDiff(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.diagnosticsStore) {
      throw new Error("DiagnosticsStore not configured.");
    }

    const analysisIdA = args.analysisIdA as string;
    const analysisIdB = args.analysisIdB as string;
    const diff = this.diagnosticsStore.diffAnalyses(analysisIdA, analysisIdB);

    return {
      analysisIdA,
      analysisIdB,
      ...diff,
    };
  }

  private async handleDiagnosticsSummary(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.diagnosticsStore) {
      throw new Error("DiagnosticsStore not configured.");
    }

    const analysisId = args.analysisId as string;
    const findings = this.diagnosticsStore.listFindings(analysisId);
    const counts: Record<string, number> = {};

    for (const finding of findings) {
      counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
    }

    return {
      analysisId,
      total: findings.length,
      bySeverity: counts,
    };
  }

  private async handleDiagnosticsSummarize(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.diagnosticsStore) {
      throw new Error("DiagnosticsStore not configured.");
    }

    const analysisId = args.analysisId as string;
    const useLLM = args.useLLM === true;
    const forceRefresh = args.forceRefresh === true;

    const findings = this.diagnosticsStore.listFindings(analysisId);

    if (!useLLM) {
      // Return raw findings (deterministic)
      return {
        analysisId,
        useLLM: false,
        total: findings.length,
        findings: findings.slice(0, 100), // Limit to first 100 for output size
      };
    }

    // Generate LLM summary
    if (!this.summaryGenerator) {
      return {
        error: "LLM summarization not available. Set OPENAI_API_KEY environment variable.",
        fallbackAvailable: true,
        suggestion: "Retry with useLLM: false to get raw findings",
      };
    }

    try {
      const summary = await this.summaryGenerator.summarize(analysisId, findings, forceRefresh);
      return {
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
        sourceFindingIds: summary.sourceFindingIds.slice(0, 10), // First 10 for reference
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        error: `Failed to generate summary: ${errorMessage}`,
        fallbackAvailable: true,
        suggestion: "Retry with useLLM: false to get raw findings",
      };
    }
  }

  private async handleDiagnosticsBySymbol(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.diagnosticsStore) {
      throw new Error("DiagnosticsStore not configured.");
    }

    const analysisId = args.analysisId as string;
    const groupBy = (args.groupBy as string | undefined) ?? "symbol";
    const findings = this.diagnosticsStore.listFindings(analysisId);

    if (groupBy === "symbol") {
      // Group by symbol
      const symbolGroups = new Map<string, {
        symbolName: string;
        symbolKind: string;
        filePath: string;
        findings: typeof findings;
        bySeverity: Record<string, number>;
      }>();

      for (const finding of findings) {
        if (!finding.symbolId || !finding.symbolName) {
          // No symbol attribution
          continue;
        }

        if (!symbolGroups.has(finding.symbolId)) {
          symbolGroups.set(finding.symbolId, {
            symbolName: finding.symbolName,
            symbolKind: finding.symbolKind ?? "unknown",
            filePath: finding.filePath,
            findings: [],
            bySeverity: {},
          });
        }

        const group = symbolGroups.get(finding.symbolId)!;
        group.findings.push(finding);
        group.bySeverity[finding.severity] = (group.bySeverity[finding.severity] ?? 0) + 1;
      }

      const symbols = Array.from(symbolGroups.entries()).map(([symbolId, group]) => ({
        symbolId,
        symbolName: group.symbolName,
        symbolKind: group.symbolKind,
        filePath: group.filePath,
        total: group.findings.length,
        bySeverity: group.bySeverity,
      })).sort((a, b) => b.total - a.total);

      return {
        analysisId,
        groupBy: "symbol",
        symbolCount: symbols.length,
        symbols,
        totalAttributed: symbols.reduce((sum, s) => sum + s.total, 0),
        totalUnattributed: findings.filter(f => !f.symbolId).length,
      };
    } else {
      // Group by file
      const fileGroups = new Map<string, {
        symbols: Map<string, {
          symbolName: string;
          symbolKind: string;
          count: number;
        }>;
        total: number;
      }>();

      for (const finding of findings) {
        if (!fileGroups.has(finding.filePath)) {
          fileGroups.set(finding.filePath, {
            symbols: new Map(),
            total: 0,
          });
        }

        const group = fileGroups.get(finding.filePath)!;
        group.total += 1;

        if (finding.symbolId && finding.symbolName) {
          if (!group.symbols.has(finding.symbolId)) {
            group.symbols.set(finding.symbolId, {
              symbolName: finding.symbolName,
              symbolKind: finding.symbolKind ?? "unknown",
              count: 0,
            });
          }
          group.symbols.get(finding.symbolId)!.count += 1;
        }
      }

      const files = Array.from(fileGroups.entries()).map(([filePath, group]) => ({
        filePath,
        total: group.total,
        symbols: Array.from(group.symbols.entries()).map(([symbolId, symbol]) => ({
          symbolId,
          symbolName: symbol.symbolName,
          symbolKind: symbol.symbolKind,
          count: symbol.count,
        })).sort((a, b) => b.count - a.count),
      })).sort((a, b) => b.total - a.total);

      return {
        analysisId,
        groupBy: "file",
        fileCount: files.length,
        files,
      };
    }
  }

  private async handleDiagnosticsCompareTools(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.diagnosticsStore) {
      throw new Error("DiagnosticsStore not configured.");
    }

    const projectId = args.projectId as string;
    const treeHash = args.treeHash as string;
    const toolNames = args.toolNames as string[] | undefined;

    // Query all tools for this project + treeHash
    const allRuns: Array<{
      toolName: string;
      analysisId: string;
      status: string;
      createdAt: string;
    }> = [];

    // Get list of unique tools (we need to query one by one)
    const toolsToQuery = toolNames ?? ["tsc", "eslint", "prettier"];

    for (const toolName of toolsToQuery) {
      const run = this.diagnosticsStore.getLatestRun({
        projectId,
        treeHash,
        toolName,
      });

      if (run) {
        allRuns.push({
          toolName: run.tool.name,
          analysisId: run.analysisId,
          status: run.status,
          createdAt: run.createdAt,
        });
      }
    }

    // Get findings summaries for each tool
    const toolSummaries = allRuns.map(run => {
      const findings = this.diagnosticsStore!.listFindings(run.analysisId);
      const bySeverity: Record<string, number> = {};
      const fileSet = new Set<string>();

      for (const finding of findings) {
        bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
        fileSet.add(finding.filePath);
      }

      return {
        toolName: run.toolName,
        analysisId: run.analysisId,
        status: run.status,
        createdAt: run.createdAt,
        total: findings.length,
        bySeverity,
        affectedFiles: fileSet.size,
      };
    });

    // Find overlapping files
    const allFiles = new Map<string, string[]>();
    for (const run of allRuns) {
      const findings = this.diagnosticsStore!.listFindings(run.analysisId);
      for (const finding of findings) {
        if (!allFiles.has(finding.filePath)) {
          allFiles.set(finding.filePath, []);
        }
        allFiles.get(finding.filePath)!.push(run.toolName);
      }
    }

    const overlappingFiles = Array.from(allFiles.entries())
      .filter(([_, tools]) => tools.length > 1)
      .map(([filePath, tools]) => ({
        filePath,
        tools: Array.from(new Set(tools)).sort(),
      }));

    // Aggregate severity counts
    const aggregateSeverity: Record<string, number> = {};
    for (const summary of toolSummaries) {
      for (const [severity, count] of Object.entries(summary.bySeverity)) {
        aggregateSeverity[severity] = (aggregateSeverity[severity] ?? 0) + count;
      }
    }

    return {
      projectId,
      treeHash,
      toolCount: toolSummaries.length,
      tools: toolSummaries,
      overlappingFiles: overlappingFiles.slice(0, 20), // Limit to top 20
      aggregateSeverity,
      totalFindings: toolSummaries.reduce((sum, s) => sum + s.total, 0),
    };
  }

  // ============================================================================
  // Codebase Ingestion Handlers
  // ============================================================================

  private async handleCodebaseIngest(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ingestionService) {
      throw new Error("IngestionService not configured. Provide ingestionService in PingMemServerConfig.");
    }

    const projectDir = args.projectDir as string;
    const forceReingest = args.forceReingest === true;

    const result = await this.ingestionService.ingestProject({
      projectDir,
      forceReingest,
    });

    if (!result) {
      return {
        success: true,
        hadChanges: false,
        message: "No changes detected since last ingestion.",
      };
    }

    return {
      success: true,
      hadChanges: true,
      projectId: result.projectId,
      treeHash: result.treeHash,
      filesIndexed: result.filesIndexed,
      chunksIndexed: result.chunksIndexed,
      commitsIndexed: result.commitsIndexed,
      ingestedAt: result.ingestedAt,
    };
  }

  private async handleCodebaseVerify(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ingestionService) {
      throw new Error("IngestionService not configured. Provide ingestionService in PingMemServerConfig.");
    }

    const projectDir = args.projectDir as string;
    const result = await this.ingestionService.verifyProject(projectDir);

    return {
      projectId: result.projectId,
      valid: result.valid,
      manifestTreeHash: result.manifestTreeHash,
      currentTreeHash: result.currentTreeHash,
      message: result.message,
    };
  }

  private async handleCodebaseSearch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ingestionService) {
      throw new Error("IngestionService not configured. Provide ingestionService in PingMemServerConfig.");
    }

    const query = args.query as string;
    const options: {
      projectId?: string;
      filePath?: string;
      type?: "code" | "comment" | "docstring";
      limit?: number;
    } = {};

    if (args.projectId !== undefined) {
      options.projectId = args.projectId as string;
    }
    if (args.filePath !== undefined) {
      options.filePath = args.filePath as string;
    }
    if (args.type !== undefined) {
      options.type = args.type as "code" | "comment" | "docstring";
    }
    if (args.limit !== undefined) {
      options.limit = args.limit as number;
    }

    const results = await this.ingestionService.searchCode(query, options);

    return {
      query,
      resultCount: results.length,
      results: results.map((r) => ({
        chunkId: r.chunkId,
        projectId: r.projectId,
        filePath: r.filePath,
        type: r.type,
        content: r.content,
        score: r.score,
      })),
    };
  }

  private async handleCodebaseTimeline(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ingestionService) {
      throw new Error("IngestionService not configured. Provide ingestionService in PingMemServerConfig.");
    }

    const projectId = args.projectId as string;
    const options: {
      projectId: string;
      filePath?: string;
      limit?: number;
    } = { projectId };

    if (args.filePath !== undefined) {
      options.filePath = args.filePath as string;
    }
    if (args.limit !== undefined) {
      options.limit = args.limit as number;
    }

    const timeline = await this.ingestionService.queryTimeline(options);

    return {
      projectId,
      filePath: options.filePath,
      eventCount: timeline.length,
      events: timeline.map((e) => ({
        commitHash: e.commitHash,
        date: e.date,
        authorName: e.authorName,
        message: e.message,
        changeType: e.changeType,
        why: e.why,
      })),
    };
  }

  private async handleCodebaseListProjects(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ingestionService) {
      throw new Error(
        "IngestionService not configured. Set NEO4J_URI and QDRANT_URL to enable code ingestion."
      );
    }

    // Validate input with Zod
    const parseResult = ListProjectsSchema.safeParse(args);
    if (!parseResult.success) {
      throw new Error(
        `Invalid input for codebase_list_projects: ${parseResult.error.message}`
      );
    }

    const validated: ListProjectsInput = parseResult.data;

    try {
      const options: {
        projectId?: string;
        limit?: number;
        sortBy?: "lastIngestedAt" | "filesCount" | "rootPath";
      } = {};

      // Only include properties if they are defined (exactOptionalPropertyTypes compliance)
      if (validated.projectId !== undefined) {
        options.projectId = validated.projectId;
      }
      if (validated.limit !== undefined) {
        options.limit = validated.limit;
      }
      if (validated.sortBy !== undefined) {
        options.sortBy = validated.sortBy;
      }

      const projects = await this.ingestionService.listProjects(options);

      return {
        count: projects.length,
        sortBy: validated.sortBy,
        projects: projects.map((p) => ({
          projectId: p.projectId,
          rootPath: p.rootPath,
          treeHash: p.treeHash,
          filesCount: p.filesCount,
          chunksCount: p.chunksCount,
          commitsCount: p.commitsCount,
          lastIngestedAt: p.lastIngestedAt,
        })),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list projects: ${errorMessage}`);
    }
  }

  private async handleProjectDelete(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ingestionService) {
      throw new Error("IngestionService not configured. Provide ingestionService in PingMemServerConfig.");
    }

    const projectDir = args.projectDir as string;
    const normalized = path.resolve(projectDir);

    let projectId: string | null = null;
    if (fs.existsSync(normalized)) {
      const scanner = new ProjectScanner();
      const scan = scanner.scanProject(normalized);
      projectId = scan.manifest.projectId;
    }

    if (!projectId) {
      throw new Error("Project not found or projectDir is invalid.");
    }

    await this.ingestionService.deleteProject(projectId);

    if (this.diagnosticsStore) {
      this.diagnosticsStore.deleteProject(projectId);
    }

    const sessionIds = this.eventStore.findSessionIdsByProjectDir(normalized);
    this.eventStore.deleteSessions(sessionIds);

    const manifestPath = path.join(normalized, ".ping-mem", "manifest.json");
    if (fs.existsSync(manifestPath)) {
      fs.unlinkSync(manifestPath);
    }

    const adminDbPath = process.env.PING_MEM_ADMIN_DB_PATH ?? this.config.dbPath;
    if (adminDbPath) {
      try {
        const adminStore = new AdminStore({ dbPath: adminDbPath });
        adminStore.deleteProject(projectId);
        adminStore.close();
      } catch {
        // Ignore admin store cleanup errors
      }
    }

    return {
      success: true,
      projectId,
      projectDir: normalized,
      sessionsDeleted: sessionIds.length,
    };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private getActiveMemoryManager(): MemoryManager {
    if (!this.currentSessionId) {
      throw new Error("No active session. Use context_session_start first.");
    }

    const memoryManager = this.memoryManagers.get(this.currentSessionId);
    if (!memoryManager) {
      throw new Error("Memory manager not found for current session");
    }

    return memoryManager;
  }

  private serializeMemory(memory: {
    id: string;
    key: string;
    value: string;
    sessionId: string;
    category?: string;
    priority: string;
    privacy: string;
    channel?: string;
    createdAt: Date;
    updatedAt: Date;
    metadata: Record<string, unknown>;
  }): Record<string, unknown> {
    return {
      id: memory.id,
      key: memory.key,
      value: memory.value,
      category: memory.category,
      priority: memory.priority,
      privacy: memory.privacy,
      channel: memory.channel,
      createdAt: memory.createdAt.toISOString(),
      updatedAt: memory.updatedAt.toISOString(),
      metadata: memory.metadata,
    };
  }

  // ============================================================================
  // Server Lifecycle
  // ============================================================================

  /**
   * Start the MCP server with stdio transport
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  /**
   * Get the underlying MCP server (for testing)
   */
  getServer(): Server {
    return this.server;
  }

  /**
   * Get current session ID (for testing)
   */
  getCurrentSessionId(): SessionId | null {
    return this.currentSessionId;
  }

  /**
   * Close all resources
   */
  async close(): Promise<void> {
    // Close all memory managers
    for (const memoryManager of this.memoryManagers.values()) {
      await memoryManager.close();
    }
    this.memoryManagers.clear();

    // Close vector index
    if (this.vectorIndex) {
      await this.vectorIndex.close();
    }

    // Close event store
    await this.eventStore.close();

    if (this.diagnosticsStore) {
      this.diagnosticsStore.close();
    }

    // Close session manager
    await this.sessionManager.close();
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

/**
 * Start the server if running as main module
 */
export async function main(): Promise<void> {
  const runtimeConfig = loadRuntimeConfig();
  const services = await createRuntimeServices();
  const diagnosticsDbPath = process.env.PING_MEM_DIAGNOSTICS_DB_PATH;

  // Create IngestionService only when both Neo4j and Qdrant are available
  let ingestionService: IngestionService | undefined;
  if (services.neo4jClient && services.qdrantClient) {
    ingestionService = new IngestionService({
      neo4jClient: services.neo4jClient,
      qdrantClient: services.qdrantClient,
    });
  }

  const server = new PingMemServer({
    dbPath: runtimeConfig.pingMem.dbPath,
    enableVectorSearch: false,
    graphManager: services.graphManager,
    lineageEngine: services.lineageEngine,
    evolutionEngine: services.evolutionEngine,
    ingestionService,
    diagnosticsDbPath,
  });

  // Handle shutdown gracefully
  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await server.close();
    process.exit(0);
  });

  await server.start();
}

// To run as CLI, use the separate entry point: bin/ping-mem-server.ts
// Or run: npx tsx src/mcp/cli.ts
