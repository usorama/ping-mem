/**
 * Mining and Dreaming tool handlers.
 *
 * Tools: transcript_mine, dreaming_run, insights_list
 *
 * @module mcp/handlers/MiningToolModule
 */

import type { ToolDefinition, ToolModule } from "../types.js";
import type { SessionState } from "./shared.js";
import { getActiveMemoryManager } from "./shared.js";
import { TranscriptMiner } from "../../mining/TranscriptMiner.js";
import { DreamingEngine } from "../../dreaming/DreamingEngine.js";
import { UserProfileStore } from "../../profile/UserProfile.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("MiningToolModule");

// ============================================================================
// Tool Schemas
// ============================================================================

export const MINING_TOOLS: ToolDefinition[] = [
  {
    name: "transcript_mine",
    description:
      "Scan Claude Code transcript files (~/.claude/projects/) to extract user facts and save them as memories. " +
      "Respects mining_progress state to avoid reprocessing already-mined sessions.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
      type: "object" as const,
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
// Module
// ============================================================================

export class MiningToolModule implements ToolModule {
  readonly tools: ToolDefinition[] = MINING_TOOLS;
  private readonly state: SessionState;

  constructor(state: SessionState) {
    this.state = state;
  }

  handle(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> | undefined {
    switch (name) {
      case "transcript_mine":
        return this.handleTranscriptMine(args);
      case "dreaming_run":
        return this.handleDreamingRun(args);
      case "insights_list":
        return this.handleInsightsList(args);
      default:
        return undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  private async handleTranscriptMine(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const memoryManager = getActiveMemoryManager(this.state);
    const db = this.state.eventStore.getDatabase();
    const userProfile = new UserProfileStore();

    const miner = new TranscriptMiner(db, memoryManager, userProfile);

    const mineOptions: { limit?: number; project?: string } = {};
    if (typeof args.limit === "number") {
      mineOptions.limit = args.limit;
    }
    if (typeof args.project === "string") {
      mineOptions.project = args.project;
    }

    log.info("Starting transcript mining", mineOptions);
    const result = await miner.mine(mineOptions);
    log.info("Transcript mining complete", {
      sessionsProcessed: result.sessionsProcessed,
      factsExtracted: result.factsExtracted,
    });

    return {
      success: result.errors.length === 0,
      sessionsScanned: result.sessionsScanned,
      sessionsProcessed: result.sessionsProcessed,
      factsExtracted: result.factsExtracted,
      profileUpdates: result.profileUpdates,
      errors: result.errors,
      durationMs: result.durationMs,
      ...(result.costEstimate && { costEstimate: result.costEstimate }),
    };
  }

  private async handleDreamingRun(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    // Default dream=true; only skip if explicitly false
    const shouldDream = args.dream !== false;
    if (!shouldDream) {
      return { success: false, skipped: true, reason: "dream=false — no action taken" };
    }

    const memoryManager = getActiveMemoryManager(this.state);
    const sessionId = this.state.currentSessionId;
    if (!sessionId) {
      throw new Error("No active session. Use context_session_start first.");
    }

    const userProfile = new UserProfileStore();

    const engine = new DreamingEngine(
      memoryManager,
      this.state.contradictionDetector,
      userProfile,
      this.state.eventStore,
      {
        maxMemoriesPerCycle: 200,
        minMemoriesForDreaming: 20,
        deductionEnabled: true,
        generalizationEnabled: true,
      }
    );

    log.info("Starting dreaming cycle", { sessionId });
    const result = await engine.dream(sessionId);
    log.info("Dreaming cycle complete", {
      deductions: result.deductions,
      generalizations: result.generalizations,
    });

    return {
      success: result.errors.length === 0,
      deductions: result.deductions,
      generalizations: result.generalizations,
      contradictions: result.contradictions,
      profileUpdates: result.profileUpdates,
      durationMs: result.durationMs,
      errors: result.errors,
      ...(result.costEstimate && { costEstimate: result.costEstimate }),
    };
  }

  private async handleInsightsList(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const memoryManager = getActiveMemoryManager(this.state);
    const limit = typeof args.limit === "number" ? args.limit : 20;

    const results = await memoryManager.recall({
      category: "derived_insight" as import("../../types/index.js").MemoryCategory,
      limit,
    });

    return {
      count: results.length,
      insights: results.map((r) => ({
        id: r.memory.id,
        key: r.memory.key,
        value: r.memory.value,
        createdAt: r.memory.createdAt.toISOString(),
        updatedAt: r.memory.updatedAt.toISOString(),
        score: r.score,
      })),
    };
  }
}
