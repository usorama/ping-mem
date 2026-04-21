/**
 * Knowledge tool handlers -- search and ingest knowledge entries.
 *
 * Tools: knowledge_search, knowledge_ingest
 *
 * @module mcp/handlers/KnowledgeToolModule
 */

import type { ToolDefinition, ToolModule } from "../types.js";
import type { SessionState } from "./shared.js";

// ============================================================================
// Tool Schemas
// ============================================================================

export const KNOWLEDGE_TOOLS: ToolDefinition[] = [
  {
    name: "knowledge_search",
    description:
      "Search knowledge entries using full-text search. Supports cross-project queries and tag filtering.",
    inputSchema: {
      type: "object" as const,
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
          description:
            "If true, search across all projects (default: false)",
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
      type: "object" as const,
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
// Module
// ============================================================================

export class KnowledgeToolModule implements ToolModule {
  readonly tools: ToolDefinition[] = KNOWLEDGE_TOOLS;
  private readonly state: SessionState;

  constructor(state: SessionState) {
    this.state = state;
  }

  handle(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> | undefined {
    switch (name) {
      case "knowledge_search":
        return this.handleSearch(args);
      case "knowledge_ingest":
        return this.handleIngest(args);
      default:
        return undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  private async handleSearch(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (!this.state.knowledgeStore) {
      throw new Error("KnowledgeStore not initialized. Requires Neo4j (NEO4J_URI) and Qdrant (QDRANT_URL) to be configured.");
    }

    const query = args.query as string;

    // Build search options with only defined properties (exactOptionalPropertyTypes)
    const searchOpts: import("../../knowledge/index.js").KnowledgeSearchOptions = { query };
    if (args.projectId !== undefined) {
      searchOpts.projectId = args.projectId as string;
    }
    if (args.crossProject !== undefined) {
      searchOpts.crossProject = args.crossProject as boolean;
    }
    if (args.tags !== undefined) {
      searchOpts.tags = args.tags as string[];
    }
    if (args.limit !== undefined) {
      searchOpts.limit = args.limit as number;
    }

    const results = this.state.knowledgeStore.search(searchOpts);

    return {
      success: true,
      count: results.length,
      results: results.map((r) => ({
        ...r.entry,
        rank: r.rank,
      })),
    };
  }

  private async handleIngest(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (!this.state.knowledgeStore) {
      throw new Error("KnowledgeStore not initialized. Requires Neo4j (NEO4J_URI) and Qdrant (QDRANT_URL) to be configured.");
    }

    // Build ingest entry with only defined properties (exactOptionalPropertyTypes)
    const ingestEntry: Omit<import("../../knowledge/index.js").KnowledgeEntry, "id" | "createdAt" | "updatedAt"> = {
      projectId: args.projectId as string,
      title: args.title as string,
      solution: args.solution as string,
      tags: (args.tags as string[] | undefined) ?? [],
    };
    if (args.symptoms !== undefined) {
      ingestEntry.symptoms = args.symptoms as string;
    }
    if (args.rootCause !== undefined) {
      ingestEntry.rootCause = args.rootCause as string;
    }

    const entry = this.state.knowledgeStore.ingest(ingestEntry);

    return {
      success: true,
      entry,
    };
  }
}
