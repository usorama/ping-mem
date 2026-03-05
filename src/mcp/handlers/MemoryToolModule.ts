/**
 * Memory tool handlers — stats and consolidation.
 *
 * Tools: memory_stats, memory_consolidate
 *
 * @module mcp/handlers/MemoryToolModule
 */

import type { ToolDefinition, ToolModule } from "../types.js";
import type { SessionState } from "./shared.js";

// ============================================================================
// Tool Schemas
// ============================================================================

const MEMORY_TOOLS: ToolDefinition[] = [
  {
    name: "memory_stats",
    description: "Show relevance decay distribution, stale count, total tracked memories, and average relevance score",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "memory_consolidate",
    description: "Archive stale memories (low relevance, old access) into digest entries. Groups by channel/category, creates summaries, and moves originals to archived_memories table.",
    inputSchema: {
      type: "object" as const,
      properties: {
        maxScore: { type: "number", description: "Maximum relevance score for consolidation (default: 0.3)" },
        minDaysOld: { type: "number", description: "Minimum days since last access (default: 30)" },
      },
    },
  },
];

// ============================================================================
// Module
// ============================================================================

export class MemoryToolModule implements ToolModule {
  readonly tools: ToolDefinition[] = MEMORY_TOOLS;
  private readonly state: SessionState;

  constructor(state: SessionState) {
    this.state = state;
  }

  handle(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> | undefined {
    switch (name) {
      case "memory_stats":
        return this.handleMemoryStats();
      case "memory_consolidate":
        return this.handleMemoryConsolidate(args);
      default:
        return undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Handlers (moved verbatim from PingMemServer)
  // --------------------------------------------------------------------------

  private async handleMemoryStats(): Promise<Record<string, unknown>> {
    if (!this.state.relevanceEngine) {
      throw new Error("RelevanceEngine not available.");
    }

    const stats = this.state.relevanceEngine.getStats();
    return { stats };
  }

  private async handleMemoryConsolidate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.relevanceEngine) {
      throw new Error("RelevanceEngine not available.");
    }

    const options: Parameters<typeof this.state.relevanceEngine.consolidate>[0] = {};
    if (typeof args.maxScore === "number") {
      options.maxScore = args.maxScore;
    }
    if (typeof args.minDaysOld === "number") {
      options.minDaysOld = args.minDaysOld;
    }

    const result = this.state.relevanceEngine.consolidate(options);
    return { result };
  }
}
