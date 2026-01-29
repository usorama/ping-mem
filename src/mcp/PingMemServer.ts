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
  MemoryCategory,
  MemoryPriority,
  MemoryPrivacy,
  MemoryQuery,
  Entity,
  Relationship,
} from "../types/index.js";
import { RelationshipType } from "../types/index.js";
import { createRuntimeServices, loadRuntimeConfig } from "../config/runtime.js";
import { IngestionService } from "../ingest/IngestionService.js";

// ============================================================================
// Tool Schemas
// ============================================================================

export const TOOLS = [
  {
    name: "context_session_start",
    description: "Start a new memory session with optional configuration",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Session name" },
        projectDir: { type: "string", description: "Project directory for context isolation" },
        continueFrom: { type: "string", description: "Session ID to continue from" },
        defaultChannel: { type: "string", description: "Default channel for memories" },
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
];

// ============================================================================
// Server Configuration
// ============================================================================

export interface PingMemServerConfig {
  /** Database path for persistence (':memory:' for in-memory) */
  dbPath?: string;
  /** Enable vector search */
  enableVectorSearch?: boolean;
  /** Vector dimensions (default: 768) */
  vectorDimensions?: number;
  /** Optional GraphManager for entity storage (required for extractEntities feature) */
  graphManager?: GraphManager;
  /** Optional EntityExtractor instance (created automatically if graphManager provided) */
  entityExtractor?: EntityExtractor;
  /** Optional HybridSearchEngine for combined semantic/keyword/graph search */
  hybridSearchEngine?: HybridSearchEngine;
  /** Optional LineageEngine for entity lineage queries */
  lineageEngine?: LineageEngine;
  /** Optional EvolutionEngine for temporal evolution queries */
  evolutionEngine?: EvolutionEngine;
  /** Optional IngestionService for codebase ingestion */
  ingestionService?: IngestionService;
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

      case "codebase_ingest":
        return this.handleCodebaseIngest(args);

      case "codebase_verify":
        return this.handleCodebaseVerify(args);

      case "codebase_search":
        return this.handleCodebaseSearch(args);

      case "codebase_timeline":
        return this.handleCodebaseTimeline(args);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
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

    return {
      success: true,
      sessionId: session.id,
      name: session.name,
      status: session.status,
      startedAt: session.startedAt.toISOString(),
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

  // Create IngestionService
  const ingestionService = new IngestionService({
    neo4jClient: services.neo4jClient,
    qdrantClient: services.qdrantClient,
  });

  const server = new PingMemServer({
    dbPath: runtimeConfig.pingMem.dbPath,
    enableVectorSearch: false,
    graphManager: services.graphManager,
    lineageEngine: services.lineageEngine,
    evolutionEngine: services.evolutionEngine,
    ingestionService,
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
