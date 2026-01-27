/**
 * Lineage Engine for Entity Lineage Tracking
 *
 * Provides lineage tracking capabilities for entities in the Neo4j-backed
 * knowledge graph, including ancestor/descendant queries, lineage path
 * finding, and evolution timeline tracking via DERIVED_FROM relationships.
 *
 * @module graph/LineageEngine
 * @version 1.0.0
 */

import type { Neo4jClient } from "./Neo4jClient.js";
import type { Entity, EntityType } from "../types/graph.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Default maximum depth for lineage queries
 */
const DEFAULT_MAX_DEPTH = 10;

/**
 * Default depth for lineage graph building
 */
const DEFAULT_GRAPH_DEPTH = 3;

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Error thrown when a lineage operation fails
 */
export class LineageEngineError extends Error {
  public readonly operation: string;
  public override readonly cause: Error | undefined;

  constructor(message: string, operation: string, cause?: Error) {
    super(message);
    this.name = "LineageEngineError";
    this.operation = operation;
    this.cause = cause ?? undefined;
    Object.setPrototypeOf(this, LineageEngineError.prototype);
  }
}

/**
 * Error thrown when an entity is not found during lineage operations
 */
export class LineageEntityNotFoundError extends LineageEngineError {
  public readonly entityId: string;

  constructor(entityId: string, operation: string) {
    super(`Entity not found: ${entityId}`, operation);
    this.name = "LineageEntityNotFoundError";
    this.entityId = entityId;
    Object.setPrototypeOf(this, LineageEntityNotFoundError.prototype);
  }
}

/**
 * Error thrown when no path exists between two entities
 */
export class LineagePathNotFoundError extends LineageEngineError {
  public readonly fromId: string;
  public readonly toId: string;

  constructor(fromId: string, toId: string) {
    super(`No lineage path found from ${fromId} to ${toId}`, "getLineagePath");
    this.name = "LineagePathNotFoundError";
    this.fromId = fromId;
    this.toId = toId;
    Object.setPrototypeOf(this, LineagePathNotFoundError.prototype);
  }
}

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Entry in an entity's evolution timeline
 */
export interface EntityEvolutionEntry {
  /** The entity at this point in time */
  entity: Entity;
  /** Generation number (0 = root ancestor, higher = more derived) */
  generation: number;
  /** The relationship that created this derivation (null for root) */
  derivationRelationship: {
    id: string;
    properties: Record<string, unknown>;
    weight: number;
    eventTime: Date;
  } | null;
}

/**
 * Node in a lineage graph for visualization
 */
export interface LineageGraphNode {
  /** Entity at this node */
  entity: Entity;
  /** Depth from the center entity (0 = center, negative = ancestors, positive = descendants) */
  depth: number;
}

/**
 * Edge in a lineage graph for visualization
 */
export interface LineageGraphEdge {
  /** Source entity ID (the derived entity) */
  sourceId: string;
  /** Target entity ID (the parent entity) */
  targetId: string;
  /** Relationship properties */
  properties: Record<string, unknown>;
  /** Relationship weight */
  weight: number;
}

/**
 * Complete lineage graph for visualization
 */
export interface LineageGraph {
  /** Center entity of the graph */
  centerEntityId: string;
  /** All nodes in the lineage graph */
  nodes: LineageGraphNode[];
  /** All edges (DERIVED_FROM relationships) in the graph */
  edges: LineageGraphEdge[];
  /** Total ancestor count */
  ancestorCount: number;
  /** Total descendant count */
  descendantCount: number;
}

// ============================================================================
// LineageEngine Implementation
// ============================================================================

/**
 * LineageEngine provides lineage tracking capabilities for entities
 * in the Neo4j-backed knowledge graph via DERIVED_FROM relationships.
 *
 * @example
 * ```typescript
 * const engine = new LineageEngine(myNeo4jClient);
 *
 * // Get all ancestors of an entity
 * const ancestors = await engine.getAncestors('entity-id');
 *
 * // Find the lineage path between two entities
 * const path = await engine.getLineagePath('derived-id', 'original-id');
 *
 * // Build a visualization graph
 * const graph = await engine.buildLineageGraph('entity-id', 3);
 * ```
 */
export class LineageEngine {
  private readonly neo4jClient: Neo4jClient;

  constructor(neo4jClient: Neo4jClient) {
    this.neo4jClient = neo4jClient;
  }

  // ==========================================================================
  // Ancestor/Descendant Queries
  // ==========================================================================

  /**
   * Get all ancestors of an entity (entities it was derived from)
   *
   * @param entityId - The entity ID to find ancestors for
   * @param maxDepth - Maximum depth to traverse (default: 10)
   * @returns Array of ancestor entities, ordered from nearest to furthest
   * @throws {LineageEngineError} If the operation fails
   */
  async getAncestors(entityId: string, maxDepth: number = DEFAULT_MAX_DEPTH): Promise<Entity[]> {
    const cypher = `
      MATCH (start:Entity {id: $entityId})
      MATCH path = (start)-[:DERIVED_FROM*1..${maxDepth}]->(ancestor:Entity)
      WITH ancestor, length(path) as depth
      ORDER BY depth ASC
      RETURN DISTINCT ancestor.id as id, ancestor.type as type, ancestor.name as name,
             ancestor.properties as properties, ancestor.createdAt as createdAt,
             ancestor.updatedAt as updatedAt, ancestor.eventTime as eventTime,
             ancestor.ingestionTime as ingestionTime
    `;

    try {
      const results = await this.neo4jClient.executeQuery<{
        id: string;
        type: string;
        name: string;
        properties: string;
        createdAt: string;
        updatedAt: string;
        eventTime: string;
        ingestionTime: string;
      }>(cypher, { entityId });

      return results.map((result) => this.mapToEntity(result));
    } catch (error) {
      throw new LineageEngineError(
        `Failed to get ancestors: ${error instanceof Error ? error.message : String(error)}`,
        "getAncestors",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get all descendants of an entity (entities derived from it)
   *
   * @param entityId - The entity ID to find descendants for
   * @param maxDepth - Maximum depth to traverse (default: 10)
   * @returns Array of descendant entities, ordered from nearest to furthest
   * @throws {LineageEngineError} If the operation fails
   */
  async getDescendants(entityId: string, maxDepth: number = DEFAULT_MAX_DEPTH): Promise<Entity[]> {
    const cypher = `
      MATCH (start:Entity {id: $entityId})
      MATCH path = (descendant:Entity)-[:DERIVED_FROM*1..${maxDepth}]->(start)
      WITH descendant, length(path) as depth
      ORDER BY depth ASC
      RETURN DISTINCT descendant.id as id, descendant.type as type, descendant.name as name,
             descendant.properties as properties, descendant.createdAt as createdAt,
             descendant.updatedAt as updatedAt, descendant.eventTime as eventTime,
             descendant.ingestionTime as ingestionTime
    `;

    try {
      const results = await this.neo4jClient.executeQuery<{
        id: string;
        type: string;
        name: string;
        properties: string;
        createdAt: string;
        updatedAt: string;
        eventTime: string;
        ingestionTime: string;
      }>(cypher, { entityId });

      return results.map((result) => this.mapToEntity(result));
    } catch (error) {
      throw new LineageEngineError(
        `Failed to get descendants: ${error instanceof Error ? error.message : String(error)}`,
        "getDescendants",
        error instanceof Error ? error : undefined
      );
    }
  }

  // ==========================================================================
  // Path Finding
  // ==========================================================================

  /**
   * Get the lineage path between two entities
   *
   * @param fromId - The starting entity ID (derived entity)
   * @param toId - The ending entity ID (ancestor entity)
   * @returns Array of entities in the path from start to end
   * @throws {LineagePathNotFoundError} If no path exists
   * @throws {LineageEngineError} If the operation fails
   */
  async getLineagePath(fromId: string, toId: string): Promise<Entity[]> {
    const cypher = `
      MATCH path = shortestPath((start:Entity {id: $fromId})-[:DERIVED_FROM*]->(end:Entity {id: $toId}))
      UNWIND nodes(path) as node
      RETURN node.id as id, node.type as type, node.name as name,
             node.properties as properties, node.createdAt as createdAt,
             node.updatedAt as updatedAt, node.eventTime as eventTime,
             node.ingestionTime as ingestionTime
    `;

    try {
      const results = await this.neo4jClient.executeQuery<{
        id: string;
        type: string;
        name: string;
        properties: string;
        createdAt: string;
        updatedAt: string;
        eventTime: string;
        ingestionTime: string;
      }>(cypher, { fromId, toId });

      if (results.length === 0) {
        throw new LineagePathNotFoundError(fromId, toId);
      }

      return results.map((result) => this.mapToEntity(result));
    } catch (error) {
      if (error instanceof LineagePathNotFoundError) {
        throw error;
      }
      throw new LineageEngineError(
        `Failed to get lineage path: ${error instanceof Error ? error.message : String(error)}`,
        "getLineagePath",
        error instanceof Error ? error : undefined
      );
    }
  }

  // ==========================================================================
  // Root Ancestor Queries
  // ==========================================================================

  /**
   * Get root ancestors of an entity (entities with no parents)
   *
   * @param entityId - The entity ID to find root ancestors for
   * @returns Array of root ancestor entities
   * @throws {LineageEngineError} If the operation fails
   */
  async getRootAncestors(entityId: string): Promise<Entity[]> {
    const cypher = `
      MATCH (start:Entity {id: $entityId})
      MATCH path = (start)-[:DERIVED_FROM*]->(ancestor:Entity)
      WHERE NOT (ancestor)-[:DERIVED_FROM]->()
      RETURN DISTINCT ancestor.id as id, ancestor.type as type, ancestor.name as name,
             ancestor.properties as properties, ancestor.createdAt as createdAt,
             ancestor.updatedAt as updatedAt, ancestor.eventTime as eventTime,
             ancestor.ingestionTime as ingestionTime
    `;

    try {
      const results = await this.neo4jClient.executeQuery<{
        id: string;
        type: string;
        name: string;
        properties: string;
        createdAt: string;
        updatedAt: string;
        eventTime: string;
        ingestionTime: string;
      }>(cypher, { entityId });

      return results.map((result) => this.mapToEntity(result));
    } catch (error) {
      throw new LineageEngineError(
        `Failed to get root ancestors: ${error instanceof Error ? error.message : String(error)}`,
        "getRootAncestors",
        error instanceof Error ? error : undefined
      );
    }
  }

  // ==========================================================================
  // Evolution Timeline
  // ==========================================================================

  /**
   * Get the evolution timeline of an entity (from root ancestors to latest descendants)
   *
   * @param entityId - The entity ID to get evolution timeline for
   * @returns Array of evolution entries ordered by generation
   * @throws {LineageEngineError} If the operation fails
   */
  async getEvolutionTimeline(entityId: string): Promise<EntityEvolutionEntry[]> {
    // First get ancestors (will be negative generations relative to our entity)
    const ancestorCypher = `
      MATCH (start:Entity {id: $entityId})
      OPTIONAL MATCH path = (start)-[:DERIVED_FROM*]->(ancestor:Entity)
      WITH start, ancestor,
           CASE WHEN ancestor IS NOT NULL THEN length(path) ELSE 0 END as depth
      OPTIONAL MATCH (prevEntity:Entity)-[r:DERIVED_FROM]->(ancestor)
      WHERE prevEntity <> start OR ancestor IS NULL
      WITH start, ancestor, depth, r, prevEntity
      ORDER BY depth DESC
      RETURN
        CASE WHEN ancestor IS NOT NULL THEN ancestor.id ELSE start.id END as id,
        CASE WHEN ancestor IS NOT NULL THEN ancestor.type ELSE start.type END as type,
        CASE WHEN ancestor IS NOT NULL THEN ancestor.name ELSE start.name END as name,
        CASE WHEN ancestor IS NOT NULL THEN ancestor.properties ELSE start.properties END as properties,
        CASE WHEN ancestor IS NOT NULL THEN ancestor.createdAt ELSE start.createdAt END as createdAt,
        CASE WHEN ancestor IS NOT NULL THEN ancestor.updatedAt ELSE start.updatedAt END as updatedAt,
        CASE WHEN ancestor IS NOT NULL THEN ancestor.eventTime ELSE start.eventTime END as eventTime,
        CASE WHEN ancestor IS NOT NULL THEN ancestor.ingestionTime ELSE start.ingestionTime END as ingestionTime,
        depth as generation,
        r.id as relId,
        r.properties as relProperties,
        r.weight as relWeight,
        r.eventTime as relEventTime
    `;

    // Then get descendants (will be positive generations relative to our entity)
    const descendantCypher = `
      MATCH (start:Entity {id: $entityId})
      OPTIONAL MATCH path = (descendant:Entity)-[:DERIVED_FROM*]->(start)
      WITH descendant, length(path) as depth
      WHERE descendant IS NOT NULL
      OPTIONAL MATCH (descendant)-[r:DERIVED_FROM]->(parent:Entity)
      ORDER BY depth ASC
      RETURN
        descendant.id as id,
        descendant.type as type,
        descendant.name as name,
        descendant.properties as properties,
        descendant.createdAt as createdAt,
        descendant.updatedAt as updatedAt,
        descendant.eventTime as eventTime,
        descendant.ingestionTime as ingestionTime,
        depth as generation,
        r.id as relId,
        r.properties as relProperties,
        r.weight as relWeight,
        r.eventTime as relEventTime
    `;

    try {
      // Get the entity itself first
      const selfCypher = `
        MATCH (e:Entity {id: $entityId})
        OPTIONAL MATCH (e)-[r:DERIVED_FROM]->(parent:Entity)
        RETURN e.id as id, e.type as type, e.name as name, e.properties as properties,
               e.createdAt as createdAt, e.updatedAt as updatedAt,
               e.eventTime as eventTime, e.ingestionTime as ingestionTime,
               0 as generation,
               r.id as relId, r.properties as relProperties,
               r.weight as relWeight, r.eventTime as relEventTime
      `;

      const [selfResults, ancestorResults, descendantResults] = await Promise.all([
        this.neo4jClient.executeQuery<{
          id: string;
          type: string;
          name: string;
          properties: string;
          createdAt: string;
          updatedAt: string;
          eventTime: string;
          ingestionTime: string;
          generation: number;
          relId: string | null;
          relProperties: string | null;
          relWeight: number | null;
          relEventTime: string | null;
        }>(selfCypher, { entityId }),
        this.neo4jClient.executeQuery<{
          id: string;
          type: string;
          name: string;
          properties: string;
          createdAt: string;
          updatedAt: string;
          eventTime: string;
          ingestionTime: string;
          generation: number;
          relId: string | null;
          relProperties: string | null;
          relWeight: number | null;
          relEventTime: string | null;
        }>(ancestorCypher, { entityId }),
        this.neo4jClient.executeQuery<{
          id: string;
          type: string;
          name: string;
          properties: string;
          createdAt: string;
          updatedAt: string;
          eventTime: string;
          ingestionTime: string;
          generation: number;
          relId: string | null;
          relProperties: string | null;
          relWeight: number | null;
          relEventTime: string | null;
        }>(descendantCypher, { entityId }),
      ]);

      // Combine and deduplicate results
      const seenIds = new Set<string>();
      const timeline: EntityEvolutionEntry[] = [];

      // Add ancestors with negative generations
      for (const result of ancestorResults.reverse()) {
        if (!seenIds.has(result.id)) {
          seenIds.add(result.id);
          timeline.push(this.mapToEvolutionEntry(result, -result.generation));
        }
      }

      // Add self
      for (const result of selfResults) {
        if (!seenIds.has(result.id)) {
          seenIds.add(result.id);
          timeline.push(this.mapToEvolutionEntry(result, 0));
        }
      }

      // Add descendants with positive generations
      for (const result of descendantResults) {
        if (!seenIds.has(result.id)) {
          seenIds.add(result.id);
          timeline.push(this.mapToEvolutionEntry(result, result.generation));
        }
      }

      // Sort by generation
      return timeline.sort((a, b) => a.generation - b.generation);
    } catch (error) {
      throw new LineageEngineError(
        `Failed to get evolution timeline: ${error instanceof Error ? error.message : String(error)}`,
        "getEvolutionTimeline",
        error instanceof Error ? error : undefined
      );
    }
  }

  // ==========================================================================
  // Lineage Graph Building
  // ==========================================================================

  /**
   * Build a lineage graph for visualization centered on an entity
   *
   * @param entityId - The center entity ID
   * @param depth - Depth to traverse in both directions (default: 3)
   * @returns LineageGraph object for visualization
   * @throws {LineageEngineError} If the operation fails
   */
  async buildLineageGraph(entityId: string, depth: number = DEFAULT_GRAPH_DEPTH): Promise<LineageGraph> {
    const cypher = `
      MATCH (center:Entity {id: $entityId})

      // Get ancestors
      OPTIONAL MATCH ancestorPath = (center)-[:DERIVED_FROM*1..${depth}]->(ancestor:Entity)

      // Get descendants
      OPTIONAL MATCH descendantPath = (descendant:Entity)-[:DERIVED_FROM*1..${depth}]->(center)

      // Collect all entities
      WITH center,
           collect(DISTINCT {entity: ancestor, depth: -length(ancestorPath)}) as ancestors,
           collect(DISTINCT {entity: descendant, depth: length(descendantPath)}) as descendants

      // Return center entity
      RETURN center.id as id, center.type as type, center.name as name,
             center.properties as properties, center.createdAt as createdAt,
             center.updatedAt as updatedAt, center.eventTime as eventTime,
             center.ingestionTime as ingestionTime,
             0 as depth,
             size(ancestors) as ancestorCount,
             size(descendants) as descendantCount
    `;

    const nodesCypher = `
      MATCH (center:Entity {id: $entityId})

      // Get ancestors with depth
      OPTIONAL MATCH ancestorPath = (center)-[:DERIVED_FROM*1..${depth}]->(ancestor:Entity)
      WITH center, ancestor,
           CASE WHEN ancestor IS NOT NULL THEN -length(ancestorPath) ELSE null END as ancestorDepth

      // Get descendants with depth
      OPTIONAL MATCH descendantPath = (descendant:Entity)-[:DERIVED_FROM*1..${depth}]->(center)

      // Combine into union of all nodes
      WITH center,
           collect(DISTINCT {
             id: ancestor.id, type: ancestor.type, name: ancestor.name,
             properties: ancestor.properties, createdAt: ancestor.createdAt,
             updatedAt: ancestor.updatedAt, eventTime: ancestor.eventTime,
             ingestionTime: ancestor.ingestionTime, depth: ancestorDepth
           }) as ancestorNodes,
           collect(DISTINCT {
             id: descendant.id, type: descendant.type, name: descendant.name,
             properties: descendant.properties, createdAt: descendant.createdAt,
             updatedAt: descendant.updatedAt, eventTime: descendant.eventTime,
             ingestionTime: descendant.ingestionTime, depth: length(descendantPath)
           }) as descendantNodes

      // Return center + all nodes
      WITH [{
        id: center.id, type: center.type, name: center.name,
        properties: center.properties, createdAt: center.createdAt,
        updatedAt: center.updatedAt, eventTime: center.eventTime,
        ingestionTime: center.ingestionTime, depth: 0
      }] + [n IN ancestorNodes WHERE n.id IS NOT NULL] + [n IN descendantNodes WHERE n.id IS NOT NULL] as allNodes
      UNWIND allNodes as node
      RETURN DISTINCT node.id as id, node.type as type, node.name as name,
             node.properties as properties, node.createdAt as createdAt,
             node.updatedAt as updatedAt, node.eventTime as eventTime,
             node.ingestionTime as ingestionTime, node.depth as depth
    `;

    const edgesCypher = `
      MATCH (center:Entity {id: $entityId})

      // Get all DERIVED_FROM relationships within depth range
      OPTIONAL MATCH (source:Entity)-[r:DERIVED_FROM]->(target:Entity)
      WHERE (source)-[:DERIVED_FROM*0..${depth}]->(center) OR (center)-[:DERIVED_FROM*0..${depth}]->(source)
         OR (target)-[:DERIVED_FROM*0..${depth}]->(center) OR (center)-[:DERIVED_FROM*0..${depth}]->(target)

      RETURN DISTINCT source.id as sourceId, target.id as targetId,
             r.properties as properties, r.weight as weight
    `;

    try {
      const [centerResults, nodeResults, edgeResults] = await Promise.all([
        this.neo4jClient.executeQuery<{
          id: string;
          type: string;
          name: string;
          properties: string;
          createdAt: string;
          updatedAt: string;
          eventTime: string;
          ingestionTime: string;
          depth: number;
          ancestorCount: number;
          descendantCount: number;
        }>(cypher, { entityId }),
        this.neo4jClient.executeQuery<{
          id: string;
          type: string;
          name: string;
          properties: string;
          createdAt: string;
          updatedAt: string;
          eventTime: string;
          ingestionTime: string;
          depth: number;
        }>(nodesCypher, { entityId }),
        this.neo4jClient.executeQuery<{
          sourceId: string;
          targetId: string;
          properties: string;
          weight: number;
        }>(edgesCypher, { entityId }),
      ]);

      const centerResult = centerResults[0];
      if (!centerResult) {
        throw new LineageEntityNotFoundError(entityId, "buildLineageGraph");
      }

      // Build nodes, filtering out nulls
      const nodes: LineageGraphNode[] = nodeResults
        .filter((n) => n.id !== null)
        .map((n) => ({
          entity: this.mapToEntity(n),
          depth: n.depth,
        }));

      // Build edges, filtering out nulls
      const edges: LineageGraphEdge[] = edgeResults
        .filter((e) => e.sourceId !== null && e.targetId !== null)
        .map((e) => ({
          sourceId: e.sourceId,
          targetId: e.targetId,
          properties: this.parseProperties(e.properties),
          weight: e.weight,
        }));

      return {
        centerEntityId: entityId,
        nodes,
        edges,
        ancestorCount: centerResult.ancestorCount,
        descendantCount: centerResult.descendantCount,
      };
    } catch (error) {
      if (error instanceof LineageEntityNotFoundError) {
        throw error;
      }
      throw new LineageEngineError(
        `Failed to build lineage graph: ${error instanceof Error ? error.message : String(error)}`,
        "buildLineageGraph",
        error instanceof Error ? error : undefined
      );
    }
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Map a query result to an Entity object
   */
  private mapToEntity(result: {
    id: string;
    type: string;
    name: string;
    properties: string;
    createdAt: string;
    updatedAt: string;
    eventTime: string;
    ingestionTime: string;
  }): Entity {
    return {
      id: result.id,
      type: result.type as EntityType,
      name: result.name,
      properties: this.parseProperties(result.properties),
      createdAt: new Date(result.createdAt),
      updatedAt: new Date(result.updatedAt),
      eventTime: new Date(result.eventTime),
      ingestionTime: new Date(result.ingestionTime),
    };
  }

  /**
   * Map a query result to an EntityEvolutionEntry
   */
  private mapToEvolutionEntry(
    result: {
      id: string;
      type: string;
      name: string;
      properties: string;
      createdAt: string;
      updatedAt: string;
      eventTime: string;
      ingestionTime: string;
      relId: string | null;
      relProperties: string | null;
      relWeight: number | null;
      relEventTime: string | null;
    },
    generation: number
  ): EntityEvolutionEntry {
    return {
      entity: this.mapToEntity(result),
      generation,
      derivationRelationship:
        result.relId !== null
          ? {
              id: result.relId,
              properties: this.parseProperties(result.relProperties ?? "{}"),
              weight: result.relWeight ?? 1.0,
              eventTime: new Date(result.relEventTime ?? Date.now()),
            }
          : null,
    };
  }

  /**
   * Parse properties from JSON string
   */
  private parseProperties(properties: string): Record<string, unknown> {
    try {
      return JSON.parse(properties) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

/**
 * Create a LineageEngine with the given Neo4j client
 *
 * @param neo4jClient - Neo4j client instance
 * @returns Configured LineageEngine instance
 */
export function createLineageEngine(neo4jClient: Neo4jClient): LineageEngine {
  return new LineageEngine(neo4jClient);
}
