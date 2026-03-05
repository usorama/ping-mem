/**
 * Causal Graph Manager for discovering and traversing cause-effect relationships
 *
 * Provides methods to add, query, and traverse causal links between entities
 * in the knowledge graph using the CAUSES relationship type.
 *
 * @module graph/CausalGraphManager
 * @version 1.0.0
 */

import type { GraphManager } from "./GraphManager.js";
import { RelationshipType } from "../types/graph.js";
import type { Entity, Relationship } from "../types/graph.js";

// ============================================================================
// Types
// ============================================================================

/**
 * A causal link between two entities with confidence and evidence
 */
export interface CausalLink {
  causeId: string;
  causeName: string;
  effectId: string;
  effectName: string;
  confidence: number;
  evidence: string;
  relationship: Relationship;
}

/**
 * A single node in a causal chain traversal
 */
export interface CausalChainLink {
  entity: Entity;
  relationship: Relationship | null; // null for the starting entity
}

/**
 * Configuration for CausalGraphManager
 */
export interface CausalGraphManagerConfig {
  graphManager: GraphManager;
  minConfidence?: number; // default: 0.5
}

// ============================================================================
// Constants
// ============================================================================

/** Default minimum confidence threshold for filtering causal links */
const DEFAULT_MIN_CONFIDENCE = 0.5;

/** Default result limit for queries */
const DEFAULT_LIMIT = 10;

/** Maximum BFS depth for causal chain traversal */
const MAX_CHAIN_DEPTH = 5;

// ============================================================================
// Implementation
// ============================================================================

/**
 * Manages causal relationships (CAUSES edges) in the knowledge graph.
 *
 * Supports:
 * - Adding causal links with confidence and evidence
 * - Querying causes of an entity (what leads to it)
 * - Querying effects of an entity (what it causes)
 * - BFS traversal for causal chains between two entities
 *
 * @example
 * ```typescript
 * const causalManager = new CausalGraphManager({
 *   graphManager: myGraphManager,
 *   minConfidence: 0.6,
 * });
 *
 * await causalManager.addCausalLink({
 *   causeEntityId: "entity-a",
 *   effectEntityId: "entity-b",
 *   confidence: 0.9,
 *   evidence: "A directly triggers B in the pipeline",
 * });
 *
 * const causes = await causalManager.getCausesOf("entity-b");
 * ```
 */
export class CausalGraphManager {
  private readonly graphManager: GraphManager;
  private readonly minConfidence: number;

  constructor(config: CausalGraphManagerConfig) {
    this.graphManager = config.graphManager;
    this.minConfidence = config.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  }

  /**
   * Add a causal link between two entities.
   * Creates a CAUSES relationship with confidence and evidence metadata.
   *
   * @param params - Causal link parameters
   * @returns The created CAUSES relationship
   */
  async addCausalLink(params: {
    causeEntityId: string;
    effectEntityId: string;
    confidence: number;
    evidence: string;
  }): Promise<Relationship> {
    const now = new Date();
    return this.graphManager.createRelationship({
      type: RelationshipType.CAUSES,
      sourceId: params.causeEntityId,
      targetId: params.effectEntityId,
      weight: params.confidence,
      properties: {
        confidence: params.confidence,
        evidence: params.evidence,
      },
      eventTime: now,
      ingestionTime: now,
    });
  }

  /**
   * Get all causes of an entity (incoming CAUSES relationships).
   *
   * Finds entities that have a CAUSES relationship pointing TO the given entity.
   * Results are filtered by minConfidence and sorted by confidence descending.
   *
   * @param entityId - The entity to find causes for
   * @param options - Query options
   * @returns Array of causal links sorted by confidence descending
   */
  async getCausesOf(
    entityId: string,
    options?: { limit?: number },
  ): Promise<CausalLink[]> {
    const limit = options?.limit ?? DEFAULT_LIMIT;

    const relationships =
      await this.graphManager.findRelationshipsByEntity(entityId);

    // Filter: CAUSES relationships where this entity is the target (effect)
    const causalRels = relationships.filter(
      (rel) =>
        rel.type === RelationshipType.CAUSES &&
        rel.targetId === entityId &&
        this.getConfidence(rel) >= this.minConfidence,
    );

    // Sort by confidence descending
    causalRels.sort(
      (a, b) => this.getConfidence(b) - this.getConfidence(a),
    );

    // Apply limit
    const limited = causalRels.slice(0, limit);

    // Resolve entity names
    return this.resolveCausalLinks(limited);
  }

  /**
   * Get all effects of an entity (outgoing CAUSES relationships).
   *
   * Finds entities that this entity CAUSES (relationship points FROM the given entity).
   * Results are filtered by minConfidence and sorted by confidence descending.
   *
   * @param entityId - The entity to find effects for
   * @param options - Query options
   * @returns Array of causal links sorted by confidence descending
   */
  async getEffectsOf(
    entityId: string,
    options?: { limit?: number },
  ): Promise<CausalLink[]> {
    const limit = options?.limit ?? DEFAULT_LIMIT;

    const relationships =
      await this.graphManager.findRelationshipsByEntity(entityId);

    // Filter: CAUSES relationships where this entity is the source (cause)
    const causalRels = relationships.filter(
      (rel) =>
        rel.type === RelationshipType.CAUSES &&
        rel.sourceId === entityId &&
        this.getConfidence(rel) >= this.minConfidence,
    );

    // Sort by confidence descending
    causalRels.sort(
      (a, b) => this.getConfidence(b) - this.getConfidence(a),
    );

    // Apply limit
    const limited = causalRels.slice(0, limit);

    // Resolve entity names
    return this.resolveCausalLinks(limited);
  }

  /**
   * Get a causal chain between two entities using BFS.
   *
   * Traverses CAUSES relationships (sourceId -> targetId) from startEntityId,
   * searching for a path to endEntityId. Maximum depth: 5.
   *
   * @param startEntityId - The starting entity (cause end)
   * @param endEntityId - The target entity (effect end)
   * @returns Array of causal links forming the chain, or empty if no path exists
   */
  async getCausalChain(
    startEntityId: string,
    endEntityId: string,
  ): Promise<CausalLink[]> {
    if (startEntityId === endEntityId) {
      return [];
    }

    // BFS state
    const visited = new Set<string>();
    // Map from entityId to { parentId, relationship }
    const parentMap = new Map<
      string,
      { parentId: string; relationship: Relationship }
    >();

    let queue: string[] = [startEntityId];
    visited.add(startEntityId);

    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
      if (queue.length === 0) break;

      const nextQueue: string[] = [];

      for (const currentId of queue) {
        const relationships =
          await this.graphManager.findRelationshipsByEntity(currentId);

        // Follow outgoing CAUSES relationships
        const outgoing = relationships.filter(
          (rel) =>
            rel.type === RelationshipType.CAUSES &&
            rel.sourceId === currentId &&
            this.getConfidence(rel) >= this.minConfidence,
        );

        for (const rel of outgoing) {
          if (visited.has(rel.targetId)) continue;

          visited.add(rel.targetId);
          parentMap.set(rel.targetId, {
            parentId: currentId,
            relationship: rel,
          });

          if (rel.targetId === endEntityId) {
            // Found the path - reconstruct
            return this.reconstructChain(
              startEntityId,
              endEntityId,
              parentMap,
            );
          }

          nextQueue.push(rel.targetId);
        }
      }

      queue = nextQueue;
    }

    // No path found
    return [];
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Extract confidence from a relationship's properties
   */
  private getConfidence(rel: Relationship): number {
    const confidence = rel.properties.confidence;
    return typeof confidence === "number" ? confidence : rel.weight;
  }

  /**
   * Resolve an array of CAUSES relationships into CausalLink objects
   * by fetching entity names
   */
  private async resolveCausalLinks(
    relationships: Relationship[],
  ): Promise<CausalLink[]> {
    if (relationships.length === 0) {
      return [];
    }

    // Batch-fetch all entity names in a single query (avoids N+1)
    const allIds = relationships.flatMap((rel) => [rel.sourceId, rel.targetId]);
    const entityMap = await this.graphManager.getEntitiesByIds(allIds);

    return relationships.map((rel) => ({
      causeId: rel.sourceId,
      causeName: entityMap.get(rel.sourceId)?.name ?? rel.sourceId,
      effectId: rel.targetId,
      effectName: entityMap.get(rel.targetId)?.name ?? rel.targetId,
      confidence: this.getConfidence(rel),
      evidence: (rel.properties.evidence as string) ?? "",
      relationship: rel,
    }));
  }

  /**
   * Reconstruct a causal chain from the BFS parent map
   */
  private async reconstructChain(
    startEntityId: string,
    endEntityId: string,
    parentMap: Map<string, { parentId: string; relationship: Relationship }>,
  ): Promise<CausalLink[]> {
    // First pass: collect all chain entries and IDs
    const orderedEntries: Array<{ parentId: string; currentId: string; relationship: Relationship }> = [];
    let currentId = endEntityId;

    while (currentId !== startEntityId) {
      const entry = parentMap.get(currentId);
      if (!entry) break;
      orderedEntries.unshift({ parentId: entry.parentId, currentId, relationship: entry.relationship });
      currentId = entry.parentId;
    }

    if (orderedEntries.length === 0) {
      return [];
    }

    // Batch-fetch all entity names in a single query (avoids N+1)
    const allIds = orderedEntries.flatMap((e) => [e.parentId, e.currentId]);
    const entityMap = await this.graphManager.getEntitiesByIds(allIds);

    return orderedEntries.map(({ parentId, currentId: effId, relationship }) => ({
      causeId: parentId,
      causeName: entityMap.get(parentId)?.name ?? parentId,
      effectId: effId,
      effectName: entityMap.get(effId)?.name ?? effId,
      confidence: this.getConfidence(relationship),
      evidence: (relationship.properties.evidence as string) ?? "",
      relationship,
    }));
  }
}
