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
import { MaintenanceRunner } from "../../maintenance/MaintenanceRunner.js";
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
  {
    name: "memory_maintain",
    description: "Run full maintenance cycle: dedup near-duplicates, consolidate stale memories, prune low-relevance unused memories, vacuum WAL. Supports dryRun preview mode.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
      case "memory_maintain":
        return this.handleMemoryMaintain(args);
      case "memory_conflicts":
        return this.handleMemoryConflicts(args);
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

  private async handleMemorySubscribe(_args: Record<string, unknown>): Promise<Record<string, unknown>> {
    // MCP tool calls are request-response — creating a real subscription
    // here would leak a zombie listener with a no-op handler.
    // Direct callers to the SSE endpoint instead.
    return {
      content: [{ type: "text", text: JSON.stringify({
        success: false,
        message: "MCP subscriptions are not supported. Use the SSE endpoint /api/v1/events/stream for real-time events.",
      }) }],
    };
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

  private async handleMemoryMaintain(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const runner = new MaintenanceRunner({
      eventStore: this.state.eventStore,
      relevanceEngine: this.state.relevanceEngine,
      ccMemoryBridge: this.state.ccMemoryBridge,
    });

    const runOpts: import("../../maintenance/MaintenanceRunner.js").MaintenanceOptions = {
      dryRun: args.dryRun === true,
    };
    if (typeof args.dedupThreshold === "number") runOpts.dedupThreshold = args.dedupThreshold;
    if (typeof args.pruneThreshold === "number") runOpts.pruneThreshold = args.pruneThreshold;
    if (typeof args.pruneMinAgeDays === "number") runOpts.pruneMinAgeDays = args.pruneMinAgeDays;
    if (typeof args.exportDir === "string") runOpts.exportDir = args.exportDir;

    const result = await runner.run(runOpts);

    return { success: true, result };
  }

  private async handleMemoryConflicts(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = (args.action as string) ?? "list";
    const db = this.state.eventStore.getDatabase();

    if (action === "resolve") {
      const memoryId = args.memoryId as string;
      if (!memoryId) {
        throw new Error("memoryId is required for resolve action");
      }

      type EventRow = { id: string; payload: string };
      const event = db.prepare(
        `SELECT event_id as id, payload FROM events
         WHERE event_type = 'CONTEXT_SAVED'
         AND json_extract(payload, '$.memoryId') = ?
         LIMIT 1`
      ).get(memoryId) as EventRow | null;

      if (!event) {
        throw new Error(`Memory not found: ${memoryId}`);
      }

      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      const metadata = (payload.metadata ?? {}) as Record<string, unknown>;
      metadata.contradictionResolved = true;
      payload.metadata = metadata;

      // Parameterized update to prevent SQL injection
      db.prepare(
        `UPDATE events SET payload = ? WHERE event_id = ?`
      ).run(JSON.stringify(payload), event.id);

      return { success: true, memoryId, resolved: true };
    }

    // List unresolved contradictions
    type ConflictRow = { id: string; payload: string; created_at: string };
    const conflicts = db.prepare(
      `SELECT event_id as id, payload, timestamp as created_at FROM events
       WHERE event_type = 'CONTEXT_SAVED'
       AND json_extract(payload, '$.metadata.contradicts') IS NOT NULL
       AND (json_extract(payload, '$.metadata.contradictionResolved') IS NULL
            OR json_extract(payload, '$.metadata.contradictionResolved') = 0)
       ORDER BY created_at DESC
       LIMIT 50`
    ).all() as ConflictRow[];

    const items = conflicts.map((row: ConflictRow) => {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const metadata = (payload.metadata ?? {}) as Record<string, unknown>;
      return {
        memoryId: payload.memoryId ?? row.id,
        key: payload.key,
        value: payload.value,
        contradicts: metadata.contradicts,
        contradictionMessage: metadata.contradictionMessage,
        createdAt: row.created_at,
      };
    });

    return { conflicts: items, count: items.length };
  }
}
