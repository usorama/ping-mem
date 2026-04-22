/**
 * Static tool schema definitions for the MCP proxy.
 *
 * This file has ZERO imports from storage, memory, graph, or any service classes.
 * It exists so the proxy-cli.ts can import tool schemas without transitively
 * pulling in Database, EventStore, MemoryManager, or any other service.
 *
 * IMPORTANT: When adding or modifying tools, keep this file in sync with
 * the corresponding handler modules in ./handlers/.
 *
 * @module mcp/tool-schemas
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ============================================================================
// Context Tools (from ContextToolModule.ts)
// ============================================================================

const CONTEXT_TOOLS: ToolDefinition[] = [
  {
    name: "context_session_start",
    description: "Start a new memory session with optional configuration. If projectDir is provided with autoIngest=true, automatically ingests the project codebase.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name" },
        projectDir: { type: "string", description: "Project directory for context isolation and automatic code ingestion" },
        continueFrom: { type: "string", description: "Session ID to continue from" },
        defaultChannel: { type: "string", description: "Default channel for memories" },
        autoIngest: { type: "boolean", description: "Automatically ingest project codebase when projectDir is provided (default: false)" },
        agentId: { type: "string", description: "Agent identity for multi-agent scoping (stored in session metadata)" },
      },
      required: ["name"],
    },
  },
  {
    name: "context_session_end",
    description: "End the current session",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Reason for ending session" },
      },
    },
  },
  {
    name: "context_save",
    description: "Save or update a memory item. If the key already exists, the old value is archived and replaced (upsert behavior). Keys are exact-match. 'my-key' and 'my_key' are different keys. Use consistent naming.",
    inputSchema: {
      type: "object",
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
          description: "Entity extraction is ON by default. Set false to skip extraction.",
        },
        skipProactiveRecall: {
          type: "boolean",
          description: "When true, skip proactive recall of related memories on save (default: false)",
        },
        agentScope: {
          type: "string",
          enum: ["private", "role", "shared", "public"],
          description: "Visibility scope for multi-agent access control (default: public)",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "context_get",
    description: "Retrieve memories by key or query parameters. Keys are exact-match. 'my-key' and 'my_key' are different keys. Use consistent naming.",
    inputSchema: {
      type: "object",
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
    description: "Search memories by keyword matching. Returns memories whose key or value contain words from the query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        minSimilarity: { type: "number", description: "Minimum similarity score (0-1)" },
        category: { type: "string", description: "Filter by category" },
        channel: { type: "string", description: "Filter by channel" },
        limit: { type: "number", description: "Maximum results" },
        compact: { type: "boolean", description: "When true, return snippets (first 80 chars) instead of full memory values" },
      },
      required: ["query"],
    },
  },
  {
    name: "context_delete",
    description: "Delete a memory by key",
    inputSchema: {
      type: "object",
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
      type: "object",
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
      type: "object",
      properties: {},
    },
  },
  {
    name: "context_session_list",
    description: "List recent sessions",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum sessions to return" },
      },
    },
  },
  {
    name: "context_auto_recall",
    description:
      "Deterministic memory recall for pre-prompt context injection. " +
      "Returns formatted context from relevant memories matching the query. " +
      "Designed for hook-driven or instruction-driven recall — call before processing any substantive user message.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The user's message or keywords to search for relevant memories",
        },
        limit: {
          type: "number",
          description: "Maximum number of memories to return (default: 5)",
        },
        minScore: {
          type: "number",
          description: "Minimum relevance score threshold 0-1 (default: 0.1)",
        },
      },
      required: ["query"],
    },
  },
];

// ============================================================================
// Graph Tools (from GraphToolModule.ts)
// ============================================================================

const GRAPH_TOOLS: ToolDefinition[] = [
  {
    name: "context_query_relationships",
    description: "Query relationships for an entity",
    inputSchema: {
      type: "object",
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
      type: "object",
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
      type: "object",
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
      type: "object",
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
      type: "object",
      properties: {},
    },
  },
];

// ============================================================================
// Worklog Tools (from WorklogToolModule.ts)
// ============================================================================

const WORKLOG_TOOLS: ToolDefinition[] = [
  {
    name: "worklog_record",
    description: "Record a deterministic worklog event (tool, diagnostics, git, task)",
    inputSchema: {
      type: "object",
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
      type: "object",
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
];

// ============================================================================
// Diagnostics Tools (from DiagnosticsToolModule.ts)
// ============================================================================

const DIAGNOSTICS_TOOLS: ToolDefinition[] = [
  {
    name: "diagnostics_ingest",
    description: "Ingest diagnostics results (SARIF 2.1.0 or normalized findings).",
    inputSchema: {
      type: "object",
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
      type: "object",
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
      type: "object",
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
      type: "object",
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
      type: "object",
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
      type: "object",
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
      type: "object",
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
      type: "object",
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
];

// ============================================================================
// Codebase Tools (from CodebaseToolModule.ts)
// ============================================================================

const CODEBASE_TOOLS: ToolDefinition[] = [
  {
    name: "codebase_ingest",
    description: "Ingest a project codebase: scan files, extract chunks, index git history, persist to graph+vectors. Deterministic and reproducible.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string", description: "Absolute path to project root" },
        forceReingest: { type: "boolean", description: "Force re-ingestion even if no changes detected" },
        maxCommits: { type: "number", description: "Max git commits to ingest. Use 0 or omit for full history." },
        maxCommitAgeDays: { type: "number", description: "Only include commits from the last N days. Use 0 or omit for full history." },
      },
      required: ["projectDir"],
    },
  },
  {
    name: "codebase_verify",
    description: "Verify that the ingested manifest matches the current on-disk project state. Returns validation result.",
    inputSchema: {
      type: "object",
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
      type: "object",
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
      type: "object",
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
    description: "List ingested projects with metadata (file/chunk/commit counts). Defaults to the registered/canonical set; pass scope='all' to include stale or ad hoc ingests.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Optional: filter by specific project ID" },
        limit: { type: "number", description: "Maximum projects to return (1-1000, default: 100)" },
        sortBy: {
          type: "string",
          description: "Sort field: 'lastIngestedAt' (default), 'filesCount', or 'rootPath'",
          enum: ["lastIngestedAt", "filesCount", "rootPath"],
        },
        scope: {
          type: "string",
          description: "Project inventory scope: 'registered' (default) for the canonical set, or 'all' to include stale/ad hoc ingests",
          enum: ["registered", "all"],
        },
      },
    },
  },
  {
    name: "project_delete",
    description: "Delete all memory, diagnostics, graph, and vectors for a project directory",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string", description: "Absolute path to project root" },
      },
      required: ["projectDir"],
    },
  },
];

// ============================================================================
// Structural Tools (from StructuralToolModule.ts)
// ============================================================================

const STRUCTURAL_TOOLS: ToolDefinition[] = [
  {
    name: "codebase_impact",
    description:
      "Impact analysis: find all files that would be affected by changing the given file. " +
      "Traverses the reverse import graph to find upstream dependents. " +
      "Returns files sorted by distance (closest dependents first).",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Project ID (from codebase_list_projects)",
        },
        filePath: {
          type: "string",
          description: "File path (relative to project root) to analyze impact for",
        },
        maxDepth: {
          type: "number",
          description: "Maximum traversal depth (default: 5, max: 10)",
        },
        maxResults: {
          type: "number",
          description: "Maximum results to return before truncation is flagged (default: 500, max: 2000)",
        },
      },
      required: ["projectId", "filePath"],
    },
  },
  {
    name: "codebase_blast_radius",
    description:
      "Blast radius: find all files that are transitively depended upon by the given file. " +
      "Traverses the forward import graph to find all downstream dependencies.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Project ID (from codebase_list_projects)",
        },
        filePath: {
          type: "string",
          description: "File path (relative to project root) to analyze",
        },
        maxDepth: {
          type: "number",
          description: "Maximum traversal depth (default: 5, max: 10)",
        },
        maxResults: {
          type: "number",
          description: "Maximum results to return before truncation is flagged (default: 500, max: 2000)",
        },
      },
      required: ["projectId", "filePath"],
    },
  },
  {
    name: "codebase_dependency_map",
    description:
      "Full dependency map: return the import graph for a project as an adjacency list. " +
      "Shows which files import which other files, with symbol names.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Project ID (from codebase_list_projects)",
        },
        includeExternal: {
          type: "boolean",
          description: "Include external (node_modules) dependencies (default: false)",
        },
      },
      required: ["projectId"],
    },
  },
];

// ============================================================================
// Memory Tools (from MemoryToolModule.ts)
// ============================================================================

const MEMORY_TOOLS: ToolDefinition[] = [
  {
    name: "memory_stats",
    description: "Show relevance decay distribution, stale count, total tracked memories, and average relevance score",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "memory_consolidate",
    description: "Archive stale memories (low relevance, old access) into digest entries. Groups by channel/category, creates summaries, and moves originals to archived_memories table.",
    inputSchema: {
      type: "object",
      properties: {
        maxScore: { type: "number", description: "Maximum relevance score for consolidation (default: 0.3)" },
        minDaysOld: { type: "number", description: "Minimum days since last access (default: 30)" },
      },
    },
  },
  {
    name: "memory_subscribe",
    description: "Subscribe to real-time memory change events (save, update, delete). Returns a subscriptionId for later unsubscription.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Filter events by channel" },
        category: { type: "string", description: "Filter events by category" },
      },
    },
  },
  {
    name: "memory_unsubscribe",
    description: "Unsubscribe from memory change events using a subscriptionId.",
    inputSchema: {
      type: "object",
      properties: {
        subscriptionId: { type: "string", description: "Subscription ID returned from memory_subscribe" },
      },
      required: ["subscriptionId"],
    },
  },
  {
    name: "memory_compress",
    description: "Compress stale memories into digest entries using LLM (when available) or heuristic deduplication. Returns extracted facts and compression ratio.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Compress memories in this channel only" },
        category: { type: "string", description: "Compress memories in this category only" },
        maxCount: { type: "number", description: "Maximum number of memories to compress (default: 100)" },
      },
    },
  },
  {
    name: "memory_maintain",
    description: "Run full maintenance cycle: dedup near-duplicates, consolidate stale memories, prune low-relevance unused memories, vacuum WAL. Supports dryRun preview mode.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", description: "Preview what would be done without modifying (default: false)" },
        dedupThreshold: { type: "number", description: "Similarity threshold for dedup (default: 0.95)" },
        pruneThreshold: { type: "number", description: "Relevance threshold below which memories are pruned (default: 0.2)" },
        pruneMinAgeDays: { type: "number", description: "Minimum age in days for pruning (default: 30)" },
        exportDir: { type: "string", description: "Directory to export high-relevance memories as native markdown files" },
      },
    },
  },
  {
    name: "memory_conflicts",
    description: "List or resolve memory contradictions. Lists memories flagged with contradiction metadata, or resolves a specific contradiction by ID.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Action: 'list' (default) to show unresolved contradictions, 'resolve' to mark one as resolved",
          enum: ["list", "resolve"],
        },
        memoryId: { type: "string", description: "Memory ID to resolve (required when action is 'resolve')" },
      },
    },
  },
];

// ============================================================================
// Causal Tools (from CausalToolModule.ts)
// ============================================================================

const CAUSAL_TOOLS: ToolDefinition[] = [
  {
    name: "search_causes",
    description: "Find what causes a given entity. Returns entities that have CAUSES relationships pointing to the target. Note: entity name resolution is not yet implemented — entityId is required.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Entity name or concept (for reference only; entityId is required)" },
        entityId: { type: "string", description: "Entity ID to find causes for (required)" },
        limit: { type: "number", description: "Maximum results (default: 10)" },
      },
      required: ["entityId"],
    },
  },
  {
    name: "search_effects",
    description: "Find what a given entity causes/affects. Returns entities that are effects of the source. Note: entity name resolution is not yet implemented — entityId is required.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Entity name or concept (for reference only; entityId is required)" },
        entityId: { type: "string", description: "Entity ID to find effects for (required)" },
        limit: { type: "number", description: "Maximum results (default: 10)" },
      },
      required: ["entityId"],
    },
  },
  {
    name: "get_causal_chain",
    description: "Find the causal chain between two entities. Returns the shortest path of CAUSES relationships.",
    inputSchema: {
      type: "object",
      properties: {
        startEntityId: { type: "string", description: "Starting entity ID" },
        endEntityId: { type: "string", description: "Ending entity ID" },
      },
      required: ["startEntityId", "endEntityId"],
    },
  },
  {
    name: "trigger_causal_discovery",
    description: "Trigger LLM-based causal relationship discovery on provided text. Extracts cause-effect pairs and optionally persists them.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to analyze for causal relationships" },
        persist: { type: "boolean", description: "Whether to persist discovered links to the graph (default: false)" },
      },
      required: ["text"],
    },
  },
];

// ============================================================================
// Knowledge Tools (from KnowledgeToolModule.ts)
// ============================================================================

const KNOWLEDGE_TOOLS: ToolDefinition[] = [
  {
    name: "knowledge_search",
    description:
      "Search knowledge entries using full-text search. Supports cross-project queries and tag filtering.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Full-text search query",
        },
        projectId: {
          type: "string",
          description: "Filter results to this project ID",
        },
        crossProject: {
          type: "boolean",
          description: "If true, search across all projects (default: false)",
        },
        tags: {
          type: "array",
          description: "Filter by tags (entries must contain all specified tags)",
          items: { type: "string" },
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 20)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "knowledge_ingest",
    description:
      "Ingest a knowledge entry (upsert). ID is deterministically computed from projectId + title.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Project identifier for scoping",
        },
        title: {
          type: "string",
          description: "Title of the knowledge entry (used for deduplication)",
        },
        solution: {
          type: "string",
          description: "The solution or answer",
        },
        symptoms: {
          type: "string",
          description: "Observable symptoms or indicators",
        },
        rootCause: {
          type: "string",
          description: "Root cause analysis",
        },
        tags: {
          type: "array",
          description: "Tags for categorization",
          items: { type: "string" },
        },
      },
      required: ["projectId", "title", "solution"],
    },
  },
];

// ============================================================================
// Agent Tools (from AgentToolModule.ts)
// ============================================================================

const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: "agent_register",
    description:
      "Register or update an agent identity with quota and TTL. Upserts into the agent_quotas table.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "Unique agent identifier (1-256 characters)",
        },
        role: {
          type: "string",
          description: 'Free-form agent role (e.g. "researcher", "coder", "reviewer")',
        },
        admin: {
          type: "boolean",
          description: "Whether this agent has admin privileges (default: false)",
        },
        ttlMs: {
          type: "number",
          description: "Time-to-live for registration in milliseconds (default: 86400000 = 24h)",
        },
        quotaBytes: {
          type: "number",
          description: "Maximum memory storage in bytes (default: 10485760 = 10MB)",
        },
        quotaCount: {
          type: "number",
          description: "Maximum number of memory entries (default: 10000)",
        },
        metadata: {
          type: "object",
          description: "Arbitrary metadata attached to this agent",
        },
      },
      required: ["agentId", "role"],
    },
  },
  {
    name: "agent_quota_status",
    description:
      "Get current quota usage for a registered agent. Returns bytes/count consumed and limits.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "Agent identifier to query",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "agent_deregister",
    description: "Remove an agent registration and release all its write locks.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "Agent identifier to deregister",
        },
      },
      required: ["agentId"],
    },
  },
];

// ============================================================================
// Mining Tools (from MiningToolModule.ts)
// ============================================================================

const MINING_TOOLS: ToolDefinition[] = [
  {
    name: "transcript_mine",
    description:
      "Scan Claude Code transcript files (~/.claude/projects/) to extract user facts and save them as memories. " +
      "Respects mining_progress state to avoid reprocessing already-mined sessions.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of sessions to process per run (default: 10)",
        },
        project: {
          type: "string",
          description: "Restrict mining to transcripts from a specific project directory name",
        },
      },
    },
  },
  {
    name: "dreaming_run",
    description:
      "Run a dreaming cycle: deduce implicit facts from memory clusters, generalize patterns into " +
      "personality traits, and invalidate stale derived insights. Requires an active session.",
    inputSchema: {
      type: "object",
      properties: {
        dream: {
          type: "boolean",
          description: "Set to true to trigger the dreaming cycle (default: true)",
        },
      },
    },
  },
  {
    name: "insights_list",
    description:
      "List derived insights — memories with category='derived_insight' produced by the dreaming engine.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of insights to return (default: 20)",
        },
      },
    },
  },
];

// ============================================================================
// Aggregated TOOLS array — same order as PingMemServer.ts
// ============================================================================

export const TOOLS: ToolDefinition[] = [
  ...CONTEXT_TOOLS,
  ...GRAPH_TOOLS,
  ...WORKLOG_TOOLS,
  ...DIAGNOSTICS_TOOLS,
  ...CODEBASE_TOOLS,
  ...STRUCTURAL_TOOLS,
  ...MEMORY_TOOLS,
  ...CAUSAL_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...AGENT_TOOLS,
  ...MINING_TOOLS,
];
