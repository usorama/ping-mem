/**
 * Memory tool handlers — stats and consolidation.
 *
 * Tools: memory_stats, memory_consolidate
 *
 * @module mcp/handlers/MemoryToolModule
 */

import type { ToolDefinition, ToolModule } from "../types.js";
import type { SessionState } from "./shared.js";
import { getActiveMemoryManager } from "./shared.js";
import { SemanticCompressor } from "../../memory/SemanticCompressor.js";
import type { MemoryCategory } from "../../types/index.js";

// ============================================================================
// Tool Schemas
// ============================================================================

export const MEMORY_TOOLS: ToolDefinition[] = [
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
  {
    name: "memory_subscribe",
    description: "Subscribe to real-time memory change events (save, update, delete). Returns a subscriptionId for later unsubscription.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
      type: "object" as const,
      properties: {
        channel: { type: "string", description: "Compress memories in this channel only" },
        category: { type: "string", description: "Compress memories in this category only" },
        maxCount: { type: "number", description: "Maximum number of memories to compress (default: 100)" },
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
      case "memory_subscribe":
        return this.handleMemorySubscribe(args);
      case "memory_unsubscribe":
        return this.handleMemoryUnsubscribe(args);
      case "memory_compress":
        return this.handleMemoryCompress(args);
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

    const result = await this.state.relevanceEngine.consolidate(options);
    return { result };
  }

  private async handleMemorySubscribe(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.pubsub) {
      throw new Error("MemoryPubSub not available.");
    }

    const options: import("../../pubsub/index.js").SubscriptionOptions = {};
    if (typeof args.channel === "string") {
      options.channel = args.channel;
    }
    if (typeof args.category === "string") {
      options.category = args.category;
    }

    // Subscribe with a no-op handler for MCP tool subscriptions.
    // The real delivery mechanism uses the SSE stream endpoint.
    const subscriptionId = this.state.pubsub.subscribe(options, () => {
      // Events delivered via SSE stream, not MCP tool responses
    });

    return { subscriptionId, subscriberCount: this.state.pubsub.subscriberCount };
  }

  private async handleMemoryUnsubscribe(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.pubsub) {
      throw new Error("MemoryPubSub not available.");
    }

    const subscriptionId = args.subscriptionId;
    if (typeof subscriptionId !== "string") {
      throw new Error("subscriptionId is required and must be a string.");
    }

    const success = this.state.pubsub.unsubscribe(subscriptionId);
    return { success, subscriberCount: this.state.pubsub.subscriberCount };
  }

  private async handleMemoryCompress(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const memoryManager = getActiveMemoryManager(this.state);

    // Build list options from args
    const listOptions: { limit?: number; category?: MemoryCategory; channel?: string } = {};
    if (typeof args.category === "string") {
      listOptions.category = args.category;
    }
    if (typeof args.channel === "string") {
      listOptions.channel = args.channel;
    }
    const maxCount = typeof args.maxCount === "number" ? args.maxCount : 100;
    listOptions.limit = maxCount;

    // Get memories to compress
    const memories = memoryManager.list(listOptions);

    if (memories.length === 0) {
      return {
        result: {
          facts: [],
          sourceCount: 0,
          compressionRatio: 1,
          strategy: "heuristic",
          digestSaved: false,
        },
      };
    }

    // Create compressor and compress
    const compressor = new SemanticCompressor();
    const compressionResult = await compressor.compress(memories);

    // If facts were produced, save a digest entry
    let digestSaved = false;
    if (compressionResult.facts.length > 0) {
      const digestKey = `digest::${args.channel ?? "all"}::${args.category ?? "all"}::${new Date().toISOString()}`;
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

    return {
      result: {
        facts: compressionResult.facts,
        sourceCount: compressionResult.sourceCount,
        compressionRatio: compressionResult.compressionRatio,
        strategy: compressionResult.strategy,
        costEstimate: compressionResult.costEstimate,
        digestSaved,
      },
    };
  }
}
