/**
 * MCP Server for ping-mem
 *
 * Provides memory management tools via Model Context Protocol,
 * enabling AI agents to persist and recall context across sessions.
 *
 * Delegates tool handling to modular ToolModule classes in ./handlers/.
 *
 * @module mcp/PingMemServer
 * @version 2.0.0
 */

import { createLogger } from "../util/logger.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { SessionManager } from "../session/SessionManager.js";
import { MemoryManager } from "../memory/MemoryManager.js";
import { EventStore } from "../storage/EventStore.js";
import { VectorIndex, createInMemoryVectorIndex } from "../search/VectorIndex.js";
import { EntityExtractor } from "../graph/EntityExtractor.js";
import type { GraphManager } from "../graph/GraphManager.js";
import type { HybridSearchEngine } from "../search/HybridSearchEngine.js";
import type { LineageEngine } from "../graph/LineageEngine.js";
import type { EvolutionEngine } from "../graph/EvolutionEngine.js";
import type { CausalGraphManager } from "../graph/CausalGraphManager.js";
import type { CausalDiscoveryAgent } from "../graph/CausalDiscoveryAgent.js";
import type { QdrantClientWrapper } from "../search/QdrantClient.js";
import type { LLMEntityExtractor } from "../graph/LLMEntityExtractor.js";
import type { SessionId } from "../types/index.js";
import { createRuntimeServices, loadRuntimeConfig } from "../config/runtime.js";
import { IngestionService } from "../ingest/IngestionService.js";
import { DiagnosticsStore } from "../diagnostics/index.js";
import { SummaryGenerator, OpenAIProvider } from "../diagnostics/SummaryGenerator.js";
import { SummaryCache } from "../diagnostics/SummaryCache.js";
import { RelevanceEngine } from "../memory/RelevanceEngine.js";

import type { ToolModule, ToolDefinition } from "./types.js";
import type { SessionState } from "./handlers/shared.js";

const log = createLogger("PingMemServer");
import {
  ContextToolModule,
  GraphToolModule,
  WorklogToolModule,
  DiagnosticsToolModule,
  CodebaseToolModule,
  MemoryToolModule,
  CausalToolModule,
  KnowledgeToolModule,
  AgentToolModule,
} from "./handlers/index.js";
import { CONTEXT_TOOLS } from "./handlers/ContextToolModule.js";
import { GRAPH_TOOLS } from "./handlers/GraphToolModule.js";
import { WORKLOG_TOOLS } from "./handlers/WorklogToolModule.js";
import { DIAGNOSTICS_TOOLS } from "./handlers/DiagnosticsToolModule.js";
import { CODEBASE_TOOLS } from "./handlers/CodebaseToolModule.js";
import { MEMORY_TOOLS } from "./handlers/MemoryToolModule.js";
import { CAUSAL_TOOLS } from "./handlers/CausalToolModule.js";
import { KNOWLEDGE_TOOLS } from "./handlers/KnowledgeToolModule.js";
import { AGENT_TOOLS } from "./handlers/AgentToolModule.js";
import { KnowledgeStore } from "../knowledge/index.js";
import { MemoryPubSub } from "../pubsub/index.js";

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
  /** Optional LLM entity extractor for high-value memories */
  llmEntityExtractor?: LLMEntityExtractor | undefined;
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
  /** Optional CausalGraphManager for causal relationship queries */
  causalGraphManager?: CausalGraphManager | undefined;
  /** Optional CausalDiscoveryAgent for LLM-based causal extraction */
  causalDiscoveryAgent?: CausalDiscoveryAgent | undefined;
  /** Optional QdrantClientWrapper for health checks */
  qdrantClient?: QdrantClientWrapper | undefined;
  /** Optional pre-created EventStore to share with the health monitor (avoids dual SQLite connections) */
  eventStore?: import("../storage/EventStore.js").EventStore | undefined;
}

// ============================================================================
// Aggregated TOOLS array — collected from all modules
// ============================================================================

// Aggregated tool definitions from all modules — static arrays, no instantiation needed
export const TOOLS: ToolDefinition[] = [
  ...CONTEXT_TOOLS,
  ...GRAPH_TOOLS,
  ...WORKLOG_TOOLS,
  ...DIAGNOSTICS_TOOLS,
  ...CODEBASE_TOOLS,
  ...MEMORY_TOOLS,
  ...CAUSAL_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...AGENT_TOOLS,
];

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
  private diagnosticsStore: DiagnosticsStore | null = null;
  private modules: ToolModule[] = [];
  private state: SessionState;

  constructor(config: PingMemServerConfig = {}) {
    const resolved = {
      dbPath: config.dbPath ?? ":memory:",
      enableVectorSearch: config.enableVectorSearch ?? false,
      vectorDimensions: config.vectorDimensions ?? 768,
    };

    // Initialize core components
    this.eventStore = new EventStore({ dbPath: resolved.dbPath });
    this.sessionManager = new SessionManager({
      eventStore: this.eventStore,
    });

    // Initialize relevance engine using EventStore's database
    const relevanceEngine = new RelevanceEngine(this.eventStore.getDatabase());

    // Initialize vector index if enabled
    if (resolved.enableVectorSearch && resolved.vectorDimensions !== undefined) {
      this.vectorIndex = createInMemoryVectorIndex({
        vectorDimensions: resolved.vectorDimensions,
      });
    } else if (resolved.enableVectorSearch) {
      this.vectorIndex = createInMemoryVectorIndex();
    }

    // Initialize graph components if graphManager provided
    const graphManager = config.graphManager ?? null;
    const entityExtractor = config.graphManager
      ? (config.entityExtractor ?? new EntityExtractor())
      : null;
    const llmEntityExtractor = config.llmEntityExtractor ?? null;

    // Initialize diagnostics
    this.diagnosticsStore =
      config.diagnosticsStore ??
      new DiagnosticsStore(
        config.diagnosticsDbPath ? { dbPath: config.diagnosticsDbPath } : undefined
      );

    // Initialize LLM summary generator only when explicitly enabled
    let summaryGenerator: SummaryGenerator | null = null;
    const openaiKey = process.env.OPENAI_API_KEY;
    const enableLLMSummaries = process.env.PING_MEM_ENABLE_LLM_SUMMARIES === "true";
    if (enableLLMSummaries && openaiKey && this.diagnosticsStore) {
      const summaryCache = new SummaryCache({ db: this.diagnosticsStore.getDatabase() });
      const provider = new OpenAIProvider(openaiKey);
      summaryGenerator = new SummaryGenerator(provider, summaryCache);
    }

    // Build shared state — passed by reference to all modules
    this.state = {
      currentSessionId: null,
      memoryManagers: new Map(),
      sessionManager: this.sessionManager,
      eventStore: this.eventStore,
      vectorIndex: this.vectorIndex,
      graphManager,
      entityExtractor,
      llmEntityExtractor,
      hybridSearchEngine: config.hybridSearchEngine ?? null,
      lineageEngine: config.lineageEngine ?? null,
      evolutionEngine: config.evolutionEngine ?? null,
      ingestionService: config.ingestionService ?? null,
      diagnosticsStore: this.diagnosticsStore,
      summaryGenerator,
      relevanceEngine,
      causalGraphManager: config.causalGraphManager ?? null,
      causalDiscoveryAgent: config.causalDiscoveryAgent ?? null,
      pubsub: new MemoryPubSub(),
      knowledgeStore: new KnowledgeStore(this.eventStore.getDatabase()),
      qdrantClient: config.qdrantClient ?? null,
    };

    // Register modules
    this.modules = [
      new ContextToolModule(this.state),
      new GraphToolModule(this.state),
      new WorklogToolModule(this.state),
      new DiagnosticsToolModule(this.state),
      new CodebaseToolModule(this.state),
      new MemoryToolModule(this.state),
      new CausalToolModule(this.state),
      new KnowledgeToolModule(this.state),
      new AgentToolModule(this.state),
    ];

    // Initialize MCP server
    this.server = new Server(
      { name: "ping-mem", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } }
    );

    this.registerHandlers();
  }

  // --------------------------------------------------------------------------
  // MCP handler registration
  // --------------------------------------------------------------------------

  private registerHandlers(): void {
    // Handle tool listing — flatMap all module tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: TOOLS };
    });

    // Handle tool calls — dispatch to first module that handles the name
    this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;

      try {
        const result = await this.handleToolCall(name, args as Record<string, unknown>);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        log.error("Tool call failed", { tool: name, error: errorMessage });
        return {
          content: [{ type: "text", text: JSON.stringify({ error: errorMessage }) }],
          isError: true,
        };
      }
    });
  }

  // --------------------------------------------------------------------------
  // Tool dispatch
  // --------------------------------------------------------------------------

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    for (const mod of this.modules) {
      if (mod.tools.some(t => t.name === name)) {
        const result = mod.handle(name, args);
        if (result !== undefined) {
          return result;
        }
      }
    }
    throw new Error(`Unknown tool: ${name}`);
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

  // --------------------------------------------------------------------------
  // Server lifecycle & accessors
  // --------------------------------------------------------------------------

  /** Start the MCP server with stdio transport */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  /** Get the underlying MCP server (for testing) */
  getServer(): Server {
    return this.server;
  }

  /** Get current session ID (for testing) */
  getCurrentSessionId(): SessionId | null {
    return this.state.currentSessionId;
  }

  /** Close all resources */
  async close(): Promise<void> {
    // Close all memory managers
    for (const memoryManager of this.state.memoryManagers.values()) {
      await memoryManager.close();
    }
    this.state.memoryManagers.clear();

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
    try {
      await ingestionService.ensureConstraints();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Failed to create Neo4j constraints. Check Neo4j version, permissions, and connectivity.", { error: message });
      throw new Error(`Neo4j constraint setup failed: ${message}`);
    }
  }

  const server = new PingMemServer({
    dbPath: runtimeConfig.pingMem.dbPath,
    enableVectorSearch: false,
    graphManager: services.graphManager,
    lineageEngine: services.lineageEngine,
    evolutionEngine: services.evolutionEngine,
    ingestionService,
    diagnosticsDbPath,
    qdrantClient: services.qdrantClient,
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
