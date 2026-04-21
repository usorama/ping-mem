/**
 * Causal tool handlers — causal graph queries and discovery.
 *
 * Tools: search_causes, search_effects, get_causal_chain,
 * trigger_causal_discovery
 *
 * @module mcp/handlers/CausalToolModule
 */

import type { ToolDefinition, ToolModule } from "../types.js";
import type { SessionState } from "./shared.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("MCP:CausalTools");

// ============================================================================
// Tool Schemas
// ============================================================================

export const CAUSAL_TOOLS: ToolDefinition[] = [
  {
    name: "search_causes",
    description: "Find what causes a given entity. Returns entities that have CAUSES relationships pointing to the target. Note: entity name resolution is not yet implemented — entityId is required.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
      type: "object" as const,
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
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Text to analyze for causal relationships" },
        persist: { type: "boolean", description: "Whether to persist discovered links to the graph (default: false)" },
      },
      required: ["text"],
    },
  },
];

// ============================================================================
// Module
// ============================================================================

export class CausalToolModule implements ToolModule {
  readonly tools: ToolDefinition[] = CAUSAL_TOOLS;
  private readonly state: SessionState;

  constructor(state: SessionState) {
    this.state = state;
  }

  handle(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> | undefined {
    switch (name) {
      case "search_causes":
        return this.handleSearchCauses(args);
      case "search_effects":
        return this.handleSearchEffects(args);
      case "get_causal_chain":
        return this.handleGetCausalChain(args);
      case "trigger_causal_discovery":
        return this.handleTriggerCausalDiscovery(args);
      default:
        return undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Handlers (moved verbatim from PingMemServer)
  // --------------------------------------------------------------------------

  private async handleSearchCauses(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.causalGraphManager) {
      throw new Error("Causal graph not configured. Provide causalGraphManager in PingMemServerConfig.");
    }
    const query = (args.query as string | undefined) ?? "";
    const entityId = args.entityId as string | undefined;
    const limit = (args.limit as number) ?? 10;

    // If entityId provided, use directly; otherwise need entity resolution
    // For now, if no entityId, return message to provide one
    if (!entityId) {
      log.warn("search_causes: entityId required", { query });
      throw new Error("entityId required (entity name resolution not yet implemented)");
    }

    const causes = await this.state.causalGraphManager.getCausesOf(entityId, { limit });
    return { query, causes };
  }

  private async handleSearchEffects(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.causalGraphManager) {
      throw new Error("Causal graph not configured. Provide causalGraphManager in PingMemServerConfig.");
    }
    const query = (args.query as string | undefined) ?? "";
    const entityId = args.entityId as string | undefined;
    const limit = (args.limit as number) ?? 10;

    if (!entityId) {
      log.warn("search_effects: entityId required", { query });
      throw new Error("entityId required (entity name resolution not yet implemented)");
    }

    const effects = await this.state.causalGraphManager.getEffectsOf(entityId, { limit });
    return { query, effects };
  }

  private async handleGetCausalChain(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.causalGraphManager) {
      throw new Error("Causal graph not configured. Provide causalGraphManager in PingMemServerConfig.");
    }
    const startEntityId = args.startEntityId as string;
    const endEntityId = args.endEntityId as string;

    const chain = await this.state.causalGraphManager.getCausalChain(startEntityId, endEntityId);
    return { startEntityId, endEntityId, chain };
  }

  private async handleTriggerCausalDiscovery(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.causalDiscoveryAgent) {
      throw new Error("Causal discovery agent not configured. Set OLLAMA_URL (primary) or OPENAI_API_KEY (fallback) to enable.");
    }
    const text = args.text as string | undefined;
    if (!text || typeof text !== "string") {
      throw new Error("text is required and must be a string");
    }
    if (text.length > 50_000) {
      throw new Error("Text exceeds maximum length of 50000 characters");
    }
    const persist = (args.persist as boolean) ?? false;

    if (persist) {
      throw new Error("Persistence is not yet supported for causal discovery. Use persist=false or omit the parameter.");
    }

    try {
      const links = await this.state.causalDiscoveryAgent.discover(text);
      return { discovered: links.length, links, persisted: false };
    } catch (error) {
      log.error('Causal discovery failed', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      throw new Error('Causal discovery failed', { cause: error });
    }
  }
}
