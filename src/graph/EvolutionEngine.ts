/**
 * Evolution Engine for Querying Temporal Evolution of Entities
 *
 * Provides temporal evolution queries for entities in the Neo4j-backed
 * knowledge graph, tracking changes over time including creation, updates,
 * deletions, and related entity changes.
 *
 * @module graph/EvolutionEngine
 * @version 1.0.0
 */

import type { TemporalStore, BiTemporalMeta } from "./TemporalStore.js";
import type { GraphManager } from "./GraphManager.js";
import type { Entity } from "../types/graph.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Default maximum timeline depth for evolution queries
 */
const DEFAULT_MAX_TIMELINE_DEPTH = 100;

/**
 * Configuration for the EvolutionEngine
 */
export interface EvolutionEngineConfig {
  /** TemporalStore instance for time-based entity queries */
  temporalStore: TemporalStore;
  /** Optional GraphManager for related entity changes */
  graphManager?: GraphManager;
  /** Maximum number of changes to return in a timeline (default: 100) */
  maxTimelineDepth?: number;
}

/**
 * Internal configuration with resolved defaults
 */
interface ResolvedConfig {
  temporalStore: TemporalStore;
  graphManager: GraphManager | null;
  maxTimelineDepth: number;
}

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Base error class for EvolutionEngine operations
 */
export class EvolutionEngineError extends Error {
  public readonly operation: string;
  public override readonly cause: Error | undefined;

  constructor(message: string, operation: string, cause?: Error) {
    super(message);
    this.name = "EvolutionEngineError";
    this.operation = operation;
    this.cause = cause ?? undefined;
    Object.setPrototypeOf(this, EvolutionEngineError.prototype);
  }
}

/**
 * Error thrown when an entity's evolution cannot be found
 */
export class EntityEvolutionNotFoundError extends EvolutionEngineError {
  public readonly entityId: string;

  constructor(entityId: string, operation: string) {
    super(`Entity evolution not found: ${entityId}`, operation);
    this.name = "EntityEvolutionNotFoundError";
    this.entityId = entityId;
    Object.setPrototypeOf(this, EntityEvolutionNotFoundError.prototype);
  }
}

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Types of changes that can occur to an entity
 */
export type ChangeType = "created" | "updated" | "deleted" | "related_changed";

/**
 * Represents a change to a related entity
 */
export interface RelatedChange {
  /** ID of the related entity */
  entityId: string;
  /** Name of the related entity */
  entityName: string;
  /** Type of relationship to the primary entity */
  relationshipType: string;
  /** Type of change that occurred */
  changeType: string;
  /** When the change occurred */
  timestamp: Date;
}

/**
 * Represents a single change to an entity
 */
export interface EntityChange {
  /** When the change occurred */
  timestamp: Date;
  /** Type of change */
  changeType: ChangeType;
  /** ID of the entity that changed */
  entityId: string;
  /** Name of the entity */
  entityName: string;
  /** Entity state before the change (null for created) */
  previousState: Entity | null;
  /** Entity state after the change (null for deleted) */
  currentState: Entity | null;
  /** Related entity changes (optional) */
  relatedEntities?: RelatedChange[];
  /** Additional metadata about the change */
  metadata?: Record<string, unknown>;
}

/**
 * Complete evolution timeline for an entity
 */
export interface EvolutionTimeline {
  /** ID of the entity */
  entityId: string;
  /** Name of the entity */
  entityName: string;
  /** Start of the timeline */
  startTime: Date;
  /** End of the timeline */
  endTime: Date;
  /** List of changes in chronological order */
  changes: EntityChange[];
  /** Total number of changes */
  totalChanges: number;
}

/**
 * Comparison of evolution between two entities
 */
export interface EvolutionComparison {
  /** First entity's evolution timeline */
  entity1: EvolutionTimeline;
  /** Second entity's evolution timeline */
  entity2: EvolutionTimeline;
  /** Changes that occurred around the same time in both entities */
  correlatedChanges: Array<{
    entity1Change: EntityChange;
    entity2Change: EntityChange;
    timeDifferenceMs: number;
  }>;
  /** Entities that are common in related changes */
  commonRelatedEntities: string[];
}

/**
 * Options for evolution queries
 */
export interface EvolutionQueryOptions {
  /** Start of the time range to query */
  startTime?: Date;
  /** End of the time range to query */
  endTime?: Date;
  /** Include related entity changes (default: false) */
  includeRelated?: boolean;
  /** Maximum depth for related entity traversal */
  maxDepth?: number;
  /** Filter by specific change types */
  changeTypes?: ChangeType[];
}

// ============================================================================
// EvolutionEngine Implementation
// ============================================================================

/**
 * EvolutionEngine provides temporal evolution queries for entities
 * in the Neo4j-backed knowledge graph.
 *
 * Features:
 * - Query evolution of individual entities over time
 * - Track related entity changes
 * - Compare evolution between multiple entities
 * - Filter by time range and change types
 *
 * @example
 * ```typescript
 * const engine = createEvolutionEngine({
 *   temporalStore: myTemporalStore,
 *   graphManager: myGraphManager,
 *   maxTimelineDepth: 100,
 * });
 *
 * // Get evolution of an entity
 * const timeline = await engine.getEvolution('entity-id', {
 *   startTime: new Date('2024-01-01'),
 *   includeRelated: true,
 * });
 *
 * // Compare evolution of two entities
 * const comparison = await engine.compareEvolution('entity-1', 'entity-2');
 * ```
 */
export class EvolutionEngine {
  private readonly config: ResolvedConfig;

  constructor(config: EvolutionEngineConfig) {
    this.config = {
      temporalStore: config.temporalStore,
      graphManager: config.graphManager ?? null,
      maxTimelineDepth: config.maxTimelineDepth ?? DEFAULT_MAX_TIMELINE_DEPTH,
    };
  }

  // ==========================================================================
  // Public Methods
  // ==========================================================================

  /**
   * Get the evolution timeline of an entity by ID
   *
   * @param entityId - ID of the entity to get evolution for
   * @param options - Query options
   * @returns Evolution timeline for the entity
   * @throws {EntityEvolutionNotFoundError} If entity not found
   * @throws {EvolutionEngineError} If operation fails
   */
  async getEvolution(
    entityId: string,
    options: EvolutionQueryOptions = {}
  ): Promise<EvolutionTimeline> {
    try {
      // Get entity history from temporal store
      const history = await this.config.temporalStore.getEntityHistory(entityId);

      if (history.length === 0) {
        throw new EntityEvolutionNotFoundError(entityId, "getEvolution");
      }

      // Build changes from history
      const changes = this.buildChangesFromHistory(history, options);

      // Filter by time range if specified
      const filteredChanges = this.filterByTimeRange(changes, options);

      // Filter by change types if specified
      const finalChanges = this.filterByChangeTypes(filteredChanges, options);

      // Limit to maxTimelineDepth
      const limitedChanges = finalChanges.slice(0, this.config.maxTimelineDepth);

      // Get related entity changes if requested
      if (options.includeRelated && this.config.graphManager) {
        await this.enrichWithRelatedChanges(limitedChanges, options);
      }

      // Determine timeline boundaries
      const startTime = limitedChanges.length > 0
        ? limitedChanges[0]!.timestamp
        : new Date();
      const endTime = limitedChanges.length > 0
        ? limitedChanges[limitedChanges.length - 1]!.timestamp
        : new Date();

      // Get entity name from most recent state
      const latestEntity = history[0];
      const entityName = latestEntity?.name ?? entityId;

      return {
        entityId,
        entityName,
        startTime,
        endTime,
        changes: limitedChanges,
        totalChanges: limitedChanges.length,
      };
    } catch (error) {
      if (error instanceof EntityEvolutionNotFoundError) {
        throw error;
      }
      throw new EvolutionEngineError(
        `Failed to get evolution for entity ${entityId}: ${error instanceof Error ? error.message : String(error)}`,
        "getEvolution",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get the evolution timeline of an entity by name
   *
   * Note: This requires the GraphManager to look up the entity ID by name
   *
   * @param entityName - Name of the entity to get evolution for
   * @param options - Query options
   * @returns Evolution timeline for the entity
   * @throws {EntityEvolutionNotFoundError} If entity not found
   * @throws {EvolutionEngineError} If operation fails or GraphManager not configured
   */
  async getEvolutionByName(
    entityName: string,
    options: EvolutionQueryOptions = {}
  ): Promise<EvolutionTimeline> {
    if (!this.config.graphManager) {
      throw new EvolutionEngineError(
        "GraphManager is required for getEvolutionByName",
        "getEvolutionByName"
      );
    }

    try {
      // Look up entity by name using GraphManager
      // Note: This assumes GraphManager has a way to find entities by name
      // For now, we'll throw an error indicating this is a limitation
      throw new EvolutionEngineError(
        `Entity lookup by name '${entityName}' is not yet implemented`,
        "getEvolutionByName"
      );
    } catch (error) {
      if (error instanceof EvolutionEngineError) {
        throw error;
      }
      throw new EvolutionEngineError(
        `Failed to get evolution for entity by name ${entityName}: ${error instanceof Error ? error.message : String(error)}`,
        "getEvolutionByName",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get evolution timelines for all entities related to a given entity
   *
   * @param entityId - ID of the entity to get related evolution for
   * @param options - Query options
   * @returns Array of evolution timelines for related entities
   * @throws {EvolutionEngineError} If operation fails or GraphManager not configured
   */
  async getRelatedEvolution(
    entityId: string,
    options: EvolutionQueryOptions = {}
  ): Promise<EvolutionTimeline[]> {
    if (!this.config.graphManager) {
      throw new EvolutionEngineError(
        "GraphManager is required for getRelatedEvolution",
        "getRelatedEvolution"
      );
    }

    try {
      // Get relationships for the entity
      const relationships = await this.config.graphManager.findRelationshipsByEntity(entityId);

      // Extract unique related entity IDs
      const relatedEntityIds = new Set<string>();
      for (const rel of relationships) {
        if (rel.sourceId !== entityId) {
          relatedEntityIds.add(rel.sourceId);
        }
        if (rel.targetId !== entityId) {
          relatedEntityIds.add(rel.targetId);
        }
      }

      // Get evolution for each related entity
      const evolutions: EvolutionTimeline[] = [];
      for (const relatedId of relatedEntityIds) {
        try {
          const evolution = await this.getEvolution(relatedId, options);
          evolutions.push(evolution);
        } catch (error) {
          // Skip entities that don't have evolution history
          if (!(error instanceof EntityEvolutionNotFoundError)) {
            throw error;
          }
        }
      }

      return evolutions;
    } catch (error) {
      if (error instanceof EvolutionEngineError) {
        throw error;
      }
      throw new EvolutionEngineError(
        `Failed to get related evolution for entity ${entityId}: ${error instanceof Error ? error.message : String(error)}`,
        "getRelatedEvolution",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Compare the evolution of two entities
   *
   * @param entityId1 - ID of the first entity
   * @param entityId2 - ID of the second entity
   * @param options - Query options
   * @returns Comparison of the two entities' evolution
   * @throws {EntityEvolutionNotFoundError} If either entity not found
   * @throws {EvolutionEngineError} If operation fails
   */
  async compareEvolution(
    entityId1: string,
    entityId2: string,
    options: EvolutionQueryOptions = {}
  ): Promise<EvolutionComparison> {
    try {
      // Get evolution for both entities
      const [evolution1, evolution2] = await Promise.all([
        this.getEvolution(entityId1, options),
        this.getEvolution(entityId2, options),
      ]);

      // Find correlated changes (changes that happened around the same time)
      const correlatedChanges = this.findCorrelatedChanges(
        evolution1.changes,
        evolution2.changes
      );

      // Find common related entities
      const commonRelatedEntities = this.findCommonRelatedEntities(
        evolution1.changes,
        evolution2.changes
      );

      return {
        entity1: evolution1,
        entity2: evolution2,
        correlatedChanges,
        commonRelatedEntities,
      };
    } catch (error) {
      if (error instanceof EntityEvolutionNotFoundError) {
        throw error;
      }
      throw new EvolutionEngineError(
        `Failed to compare evolution for entities ${entityId1} and ${entityId2}: ${error instanceof Error ? error.message : String(error)}`,
        "compareEvolution",
        error instanceof Error ? error : undefined
      );
    }
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  /**
   * Build EntityChange objects from entity history
   */
  private buildChangesFromHistory(
    history: Array<Entity & BiTemporalMeta>,
    _options: EvolutionQueryOptions
  ): EntityChange[] {
    const changes: EntityChange[] = [];

    // History is ordered newest to oldest, so reverse for chronological order
    const chronologicalHistory = [...history].reverse();

    for (let i = 0; i < chronologicalHistory.length; i++) {
      const current = chronologicalHistory[i]!;
      const previous = i > 0 ? chronologicalHistory[i - 1] : null;

      // Determine change type
      let changeType: ChangeType;
      if (i === 0) {
        changeType = "created";
      } else if (current.validTo !== null) {
        changeType = "deleted";
      } else {
        changeType = "updated";
      }

      changes.push({
        timestamp: current.eventTime,
        changeType,
        entityId: current.id,
        entityName: current.name,
        previousState: previous ? this.entityWithoutBiTemporal(previous) : null,
        currentState: changeType === "deleted" ? null : this.entityWithoutBiTemporal(current),
        metadata: {
          version: current.version,
          validFrom: current.validFrom,
          validTo: current.validTo,
          ingestionTime: current.ingestionTime,
        },
      });
    }

    return changes;
  }

  /**
   * Strip bi-temporal metadata from entity
   */
  private entityWithoutBiTemporal(entityWithMeta: Entity & BiTemporalMeta): Entity {
    return {
      id: entityWithMeta.id,
      type: entityWithMeta.type,
      name: entityWithMeta.name,
      properties: entityWithMeta.properties,
      createdAt: entityWithMeta.createdAt,
      updatedAt: entityWithMeta.updatedAt,
      eventTime: entityWithMeta.eventTime,
      ingestionTime: entityWithMeta.ingestionTime,
    };
  }

  /**
   * Filter changes by time range
   */
  private filterByTimeRange(
    changes: EntityChange[],
    options: EvolutionQueryOptions
  ): EntityChange[] {
    if (!options.startTime && !options.endTime) {
      return changes;
    }

    return changes.filter((change) => {
      if (options.startTime && change.timestamp < options.startTime) {
        return false;
      }
      if (options.endTime && change.timestamp > options.endTime) {
        return false;
      }
      return true;
    });
  }

  /**
   * Filter changes by change types
   */
  private filterByChangeTypes(
    changes: EntityChange[],
    options: EvolutionQueryOptions
  ): EntityChange[] {
    if (!options.changeTypes || options.changeTypes.length === 0) {
      return changes;
    }

    return changes.filter((change) =>
      options.changeTypes!.includes(change.changeType)
    );
  }

  /**
   * Enrich changes with related entity change information
   */
  private async enrichWithRelatedChanges(
    changes: EntityChange[],
    options: EvolutionQueryOptions
  ): Promise<void> {
    if (!this.config.graphManager) {
      return;
    }

    const maxDepth = options.maxDepth ?? 1;

    for (const change of changes) {
      try {
        const relationships = await this.config.graphManager.findRelationshipsByEntity(
          change.entityId
        );

        const relatedChanges: RelatedChange[] = [];

        for (const rel of relationships) {
          const relatedId = rel.sourceId === change.entityId ? rel.targetId : rel.sourceId;

          // Get history for related entity
          try {
            const relatedHistory = await this.config.temporalStore.getEntityHistory(relatedId);

            // Find changes around the same time as this change
            for (const relatedVersion of relatedHistory) {
              const timeDiff = Math.abs(
                relatedVersion.eventTime.getTime() - change.timestamp.getTime()
              );

              // Consider changes within 1 hour as related
              if (timeDiff <= 3600000) {
                relatedChanges.push({
                  entityId: relatedId,
                  entityName: relatedVersion.name,
                  relationshipType: rel.type,
                  changeType: relatedVersion.version === 1 ? "created" : "updated",
                  timestamp: relatedVersion.eventTime,
                });
              }
            }
          } catch {
            // Skip entities without history
          }
        }

        if (relatedChanges.length > 0) {
          change.relatedEntities = relatedChanges.slice(0, maxDepth * 10);
        }
      } catch {
        // Skip if unable to get related changes
      }
    }
  }

  /**
   * Find changes that occurred around the same time in both entities
   */
  private findCorrelatedChanges(
    changes1: EntityChange[],
    changes2: EntityChange[]
  ): Array<{
    entity1Change: EntityChange;
    entity2Change: EntityChange;
    timeDifferenceMs: number;
  }> {
    const correlations: Array<{
      entity1Change: EntityChange;
      entity2Change: EntityChange;
      timeDifferenceMs: number;
    }> = [];

    // Consider changes within 1 hour as potentially correlated
    const maxTimeDiffMs = 3600000;

    for (const change1 of changes1) {
      for (const change2 of changes2) {
        const timeDiff = Math.abs(
          change1.timestamp.getTime() - change2.timestamp.getTime()
        );

        if (timeDiff <= maxTimeDiffMs) {
          correlations.push({
            entity1Change: change1,
            entity2Change: change2,
            timeDifferenceMs: timeDiff,
          });
        }
      }
    }

    // Sort by time difference (closest first)
    return correlations.sort((a, b) => a.timeDifferenceMs - b.timeDifferenceMs);
  }

  /**
   * Find entity IDs that appear in related changes of both timelines
   */
  private findCommonRelatedEntities(
    changes1: EntityChange[],
    changes2: EntityChange[]
  ): string[] {
    const related1 = new Set<string>();
    const related2 = new Set<string>();

    for (const change of changes1) {
      if (change.relatedEntities) {
        for (const related of change.relatedEntities) {
          related1.add(related.entityId);
        }
      }
    }

    for (const change of changes2) {
      if (change.relatedEntities) {
        for (const related of change.relatedEntities) {
          related2.add(related.entityId);
        }
      }
    }

    // Find intersection
    const common: string[] = [];
    for (const id of related1) {
      if (related2.has(id)) {
        common.push(id);
      }
    }

    return common;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an EvolutionEngine with the given configuration
 *
 * @param config - EvolutionEngine configuration
 * @returns Configured EvolutionEngine instance
 */
export function createEvolutionEngine(config: EvolutionEngineConfig): EvolutionEngine {
  return new EvolutionEngine(config);
}
