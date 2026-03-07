/**
 * Graph tool handlers — relationship queries, hybrid search, lineage, evolution, health.
 *
 * Tools: context_query_relationships, context_hybrid_search,
 * context_get_lineage, context_query_evolution, context_health
 *
 * @module mcp/handlers/GraphToolModule
 */

import type { ToolDefinition, ToolModule } from "../types.js";
import type { SessionState } from "./shared.js";
import type {
  SessionId,
  Entity,
} from "../../types/index.js";
import { RelationshipType } from "../../types/index.js";
import type { SearchWeights } from "../../search/HybridSearchEngine.js";

// ============================================================================
// Tool Schemas
// ============================================================================

export const GRAPH_TOOLS: ToolDefinition[] = [
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
    name: "context_health",
    description: "Check ping-mem service health and connectivity to Neo4j, Qdrant, and SQLite",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// ============================================================================
// Module
// ============================================================================

export class GraphToolModule implements ToolModule {
  readonly tools: ToolDefinition[] = GRAPH_TOOLS;
  private readonly state: SessionState;

  constructor(state: SessionState) {
    this.state = state;
  }

  handle(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> | undefined {
    switch (name) {
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
      default:
        return undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Handlers (moved verbatim from PingMemServer)
  // --------------------------------------------------------------------------

  private async handleQueryRelationships(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Verify graphManager is configured
    if (!this.state.graphManager) {
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
    const allRelationships = await this.state.graphManager.findRelationshipsByEntity(entityId);

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
      const entity = await this.state.graphManager.getEntity(id);
      if (entity) {
        entities.push(entity);
      }
    }

    // For depth > 1, recursively fetch more relationships
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
          const nextRelationships = await this.state.graphManager.findRelationshipsByEntity(currentId);

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
              const entity = await this.state.graphManager.getEntity(otherId);
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
    if (!this.state.hybridSearchEngine) {
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

    const results = await this.state.hybridSearchEngine.search(query, searchOptions);

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
    if (!this.state.lineageEngine) {
      throw new Error("LineageEngine not configured. Provide lineageEngine in PingMemServerConfig.");
    }

    const entityId = args.entityId as string;
    const direction = (args.direction as "upstream" | "downstream" | "both") ?? "both";
    const maxDepth = args.maxDepth as number | undefined;

    // Get upstream entities (ancestors)
    let upstream: Entity[] = [];
    if (direction === "upstream" || direction === "both") {
      upstream = await this.state.lineageEngine.getAncestors(entityId, maxDepth);
    }

    // Get downstream entities (descendants)
    let downstream: Entity[] = [];
    if (direction === "downstream" || direction === "both") {
      downstream = await this.state.lineageEngine.getDescendants(entityId, maxDepth);
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
    if (!this.state.evolutionEngine) {
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

    const evolution = await this.state.evolutionEngine.getEvolution(entityId, queryOptions);

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

  private async handleHealth(): Promise<Record<string, unknown>> {
    const health: Record<string, unknown> = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      version: "1.0.0",
      components: {},
    };

    // Check SQLite (EventStore)
    try {
      await this.state.eventStore.getBySession("__health_check__");
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

    // Check GraphManager (Neo4j) — actual connectivity check
    if (this.state.graphManager) {
      try {
        // Real connectivity check: attempt a lightweight query against Neo4j
        await this.state.graphManager.getEntity("__health_check_nonexistent__");
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

    // Check Qdrant — actual health check ping
    if (this.state.qdrantClient) {
      try {
        const healthy = await this.state.qdrantClient.healthCheck();
        (health.components as Record<string, unknown>).qdrant = {
          status: healthy ? "healthy" : "unhealthy",
          configured: true,
        };
        if (!healthy) {
          health.status = "degraded";
        }
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
    if (this.state.diagnosticsStore) {
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
      active: this.state.currentSessionId !== null,
      sessionId: this.state.currentSessionId,
    };

    return health;
  }
}
