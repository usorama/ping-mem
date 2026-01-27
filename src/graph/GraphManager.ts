/**
 * Graph Manager for Entity and Relationship CRUD Operations
 *
 * Provides high-level CRUD operations for entities and relationships
 * in the Neo4j-backed knowledge graph, including batch operations
 * and auto-merge functionality.
 *
 * @module graph/GraphManager
 * @version 1.0.0
 */

import { randomUUID } from "crypto";
import type { Neo4jClient } from "./Neo4jClient.js";
import type { Entity, Relationship, EntityType, RelationshipType } from "../types/graph.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for the GraphManager
 */
export interface GraphManagerConfig {
  /** Neo4j client instance for database operations */
  neo4jClient: Neo4jClient;
  /** Default batch size for bulk operations (default: 100) */
  defaultBatchSize?: number;
  /** Enable automatic entity merging on upsert (default: true) */
  enableAutoMerge?: boolean;
}

/**
 * Internal configuration with resolved defaults
 */
interface ResolvedGraphManagerConfig {
  neo4jClient: Neo4jClient;
  defaultBatchSize: number;
  enableAutoMerge: boolean;
}

/** Default batch size for bulk operations */
const DEFAULT_BATCH_SIZE = 100;

/** Default auto-merge setting */
const DEFAULT_ENABLE_AUTO_MERGE = true;

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Error thrown when a graph operation fails
 */
export class GraphManagerError extends Error {
  public readonly operation: string;
  public override readonly cause: Error | undefined;

  constructor(message: string, operation: string, cause?: Error) {
    super(message);
    this.name = "GraphManagerError";
    this.operation = operation;
    this.cause = cause ?? undefined;
    Object.setPrototypeOf(this, GraphManagerError.prototype);
  }
}

/**
 * Error thrown when an entity is not found
 */
export class EntityNotFoundError extends GraphManagerError {
  public readonly entityId: string;

  constructor(entityId: string) {
    super(`Entity not found: ${entityId}`, "getEntity");
    this.name = "EntityNotFoundError";
    this.entityId = entityId;
    Object.setPrototypeOf(this, EntityNotFoundError.prototype);
  }
}

/**
 * Error thrown when a relationship is not found
 */
export class RelationshipNotFoundError extends GraphManagerError {
  public readonly relationshipId: string;

  constructor(relationshipId: string) {
    super(`Relationship not found: ${relationshipId}`, "getRelationship");
    this.name = "RelationshipNotFoundError";
    this.relationshipId = relationshipId;
    Object.setPrototypeOf(this, RelationshipNotFoundError.prototype);
  }
}

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Input type for creating a new entity (without auto-generated fields)
 */
export type CreateEntityInput = Omit<Entity, "id" | "createdAt" | "updatedAt">;

/**
 * Input type for creating a new relationship (without auto-generated fields)
 */
export type CreateRelationshipInput = Omit<Relationship, "id" | "createdAt" | "updatedAt">;

/**
 * Input type for updating an entity (partial)
 */
export type UpdateEntityInput = Partial<Omit<Entity, "id" | "createdAt">>;

// ============================================================================
// GraphManager Implementation
// ============================================================================

/**
 * GraphManager provides high-level CRUD operations for entities and relationships
 * in the Neo4j-backed knowledge graph.
 *
 * @example
 * ```typescript
 * const manager = new GraphManager({
 *   neo4jClient: myNeo4jClient,
 *   defaultBatchSize: 50,
 *   enableAutoMerge: true
 * });
 *
 * const entity = await manager.createEntity({
 *   type: EntityType.CONCEPT,
 *   name: 'Test Concept',
 *   properties: { description: 'A test concept' },
 *   eventTime: new Date(),
 *   ingestionTime: new Date()
 * });
 * ```
 */
export class GraphManager {
  private readonly config: ResolvedGraphManagerConfig;

  constructor(config: GraphManagerConfig) {
    this.config = {
      neo4jClient: config.neo4jClient,
      defaultBatchSize: config.defaultBatchSize ?? DEFAULT_BATCH_SIZE,
      enableAutoMerge: config.enableAutoMerge ?? DEFAULT_ENABLE_AUTO_MERGE,
    };
  }

  // ==========================================================================
  // Entity CRUD Operations
  // ==========================================================================

  /**
   * Create a new entity in the knowledge graph
   *
   * @param entity - Entity data (without id, createdAt, updatedAt)
   * @returns The created entity with generated id and timestamps
   * @throws {GraphManagerError} If the operation fails
   */
  async createEntity(entity: CreateEntityInput): Promise<Entity> {
    const id = randomUUID();
    const now = new Date();

    const cypher = `
      CREATE (e:Entity {
        id: $id,
        type: $type,
        name: $name,
        properties: $properties,
        createdAt: datetime($createdAt),
        updatedAt: datetime($updatedAt),
        eventTime: datetime($eventTime),
        ingestionTime: datetime($ingestionTime)
      })
      RETURN e.id as id, e.type as type, e.name as name, e.properties as properties,
             e.createdAt as createdAt, e.updatedAt as updatedAt,
             e.eventTime as eventTime, e.ingestionTime as ingestionTime
    `;

    const params = {
      id,
      type: entity.type,
      name: entity.name,
      properties: JSON.stringify(entity.properties),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      eventTime: entity.eventTime.toISOString(),
      ingestionTime: entity.ingestionTime.toISOString(),
    };

    try {
      const result = await this.config.neo4jClient.executeWrite<{
        id: string;
        type: string;
        name: string;
        properties: string;
        createdAt: string;
        updatedAt: string;
        eventTime: string;
        ingestionTime: string;
      }>(cypher, params);

      return this.mapToEntity(result);
    } catch (error) {
      throw new GraphManagerError(
        `Failed to create entity: ${error instanceof Error ? error.message : String(error)}`,
        "createEntity",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get an entity by its ID
   *
   * @param id - Entity ID
   * @returns The entity or null if not found
   * @throws {GraphManagerError} If the operation fails
   */
  async getEntity(id: string): Promise<Entity | null> {
    const cypher = `
      MATCH (e:Entity {id: $id})
      RETURN e.id as id, e.type as type, e.name as name, e.properties as properties,
             e.createdAt as createdAt, e.updatedAt as updatedAt,
             e.eventTime as eventTime, e.ingestionTime as ingestionTime
    `;

    try {
      const results = await this.config.neo4jClient.executeQuery<{
        id: string;
        type: string;
        name: string;
        properties: string;
        createdAt: string;
        updatedAt: string;
        eventTime: string;
        ingestionTime: string;
      }>(cypher, { id });

      if (results.length === 0) {
        return null;
      }

      const result = results[0];
      if (!result) {
        return null;
      }

      return this.mapToEntity(result);
    } catch (error) {
      throw new GraphManagerError(
        `Failed to get entity: ${error instanceof Error ? error.message : String(error)}`,
        "getEntity",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Update an existing entity
   *
   * @param id - Entity ID to update
   * @param updates - Partial entity updates
   * @returns The updated entity
   * @throws {EntityNotFoundError} If the entity doesn't exist
   * @throws {GraphManagerError} If the operation fails
   */
  async updateEntity(id: string, updates: UpdateEntityInput): Promise<Entity> {
    const now = new Date();

    // Build dynamic SET clause
    const setClause: string[] = ["e.updatedAt = datetime($updatedAt)"];
    const params: Record<string, unknown> = { id, updatedAt: now.toISOString() };

    if (updates.type !== undefined) {
      setClause.push("e.type = $type");
      params.type = updates.type;
    }
    if (updates.name !== undefined) {
      setClause.push("e.name = $name");
      params.name = updates.name;
    }
    if (updates.properties !== undefined) {
      setClause.push("e.properties = $properties");
      params.properties = JSON.stringify(updates.properties);
    }
    if (updates.eventTime !== undefined) {
      setClause.push("e.eventTime = datetime($eventTime)");
      params.eventTime = updates.eventTime.toISOString();
    }
    if (updates.ingestionTime !== undefined) {
      setClause.push("e.ingestionTime = datetime($ingestionTime)");
      params.ingestionTime = updates.ingestionTime.toISOString();
    }

    const cypher = `
      MATCH (e:Entity {id: $id})
      SET ${setClause.join(", ")}
      RETURN e.id as id, e.type as type, e.name as name, e.properties as properties,
             e.createdAt as createdAt, e.updatedAt as updatedAt,
             e.eventTime as eventTime, e.ingestionTime as ingestionTime
    `;

    try {
      const result = await this.config.neo4jClient.executeWrite<{
        id: string;
        type: string;
        name: string;
        properties: string;
        createdAt: string;
        updatedAt: string;
        eventTime: string;
        ingestionTime: string;
      }>(cypher, params);

      // Check if the result contains actual entity data
      if (!result.id) {
        throw new EntityNotFoundError(id);
      }

      return this.mapToEntity(result);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw error;
      }
      throw new GraphManagerError(
        `Failed to update entity: ${error instanceof Error ? error.message : String(error)}`,
        "updateEntity",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Delete an entity by its ID
   *
   * @param id - Entity ID to delete
   * @returns true if deleted, false if not found
   * @throws {GraphManagerError} If the operation fails
   */
  async deleteEntity(id: string): Promise<boolean> {
    const cypher = `
      MATCH (e:Entity {id: $id})
      DETACH DELETE e
      RETURN count(e) as deleted
    `;

    try {
      const result = await this.config.neo4jClient.executeWrite<{ deleted: number }>(
        cypher,
        { id }
      );

      return result.deleted > 0;
    } catch (error) {
      throw new GraphManagerError(
        `Failed to delete entity: ${error instanceof Error ? error.message : String(error)}`,
        "deleteEntity",
        error instanceof Error ? error : undefined
      );
    }
  }

  // ==========================================================================
  // Relationship CRUD Operations
  // ==========================================================================

  /**
   * Create a new relationship between entities
   *
   * @param rel - Relationship data (without id, createdAt, updatedAt)
   * @returns The created relationship with generated id and timestamps
   * @throws {GraphManagerError} If the operation fails
   */
  async createRelationship(rel: CreateRelationshipInput): Promise<Relationship> {
    const id = randomUUID();
    const now = new Date();

    const cypher = `
      MATCH (source:Entity {id: $sourceId})
      MATCH (target:Entity {id: $targetId})
      CREATE (source)-[r:RELATIONSHIP {
        id: $id,
        type: $type,
        properties: $properties,
        weight: $weight,
        createdAt: datetime($createdAt),
        updatedAt: datetime($updatedAt),
        eventTime: datetime($eventTime),
        ingestionTime: datetime($ingestionTime)
      }]->(target)
      RETURN r.id as id, r.type as type, $sourceId as sourceId, $targetId as targetId,
             r.properties as properties, r.weight as weight,
             r.createdAt as createdAt, r.updatedAt as updatedAt,
             r.eventTime as eventTime, r.ingestionTime as ingestionTime
    `;

    const params = {
      id,
      type: rel.type,
      sourceId: rel.sourceId,
      targetId: rel.targetId,
      properties: JSON.stringify(rel.properties),
      weight: rel.weight,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      eventTime: rel.eventTime.toISOString(),
      ingestionTime: rel.ingestionTime.toISOString(),
    };

    try {
      const result = await this.config.neo4jClient.executeWrite<{
        id: string;
        type: string;
        sourceId: string;
        targetId: string;
        properties: string;
        weight: number;
        createdAt: string;
        updatedAt: string;
        eventTime: string;
        ingestionTime: string;
      }>(cypher, params);

      return this.mapToRelationship(result);
    } catch (error) {
      throw new GraphManagerError(
        `Failed to create relationship: ${error instanceof Error ? error.message : String(error)}`,
        "createRelationship",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get a relationship by its ID
   *
   * @param id - Relationship ID
   * @returns The relationship or null if not found
   * @throws {GraphManagerError} If the operation fails
   */
  async getRelationship(id: string): Promise<Relationship | null> {
    const cypher = `
      MATCH (source:Entity)-[r:RELATIONSHIP {id: $id}]->(target:Entity)
      RETURN r.id as id, r.type as type, source.id as sourceId, target.id as targetId,
             r.properties as properties, r.weight as weight,
             r.createdAt as createdAt, r.updatedAt as updatedAt,
             r.eventTime as eventTime, r.ingestionTime as ingestionTime
    `;

    try {
      const results = await this.config.neo4jClient.executeQuery<{
        id: string;
        type: string;
        sourceId: string;
        targetId: string;
        properties: string;
        weight: number;
        createdAt: string;
        updatedAt: string;
        eventTime: string;
        ingestionTime: string;
      }>(cypher, { id });

      if (results.length === 0) {
        return null;
      }

      const result = results[0];
      if (!result) {
        return null;
      }

      return this.mapToRelationship(result);
    } catch (error) {
      throw new GraphManagerError(
        `Failed to get relationship: ${error instanceof Error ? error.message : String(error)}`,
        "getRelationship",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Delete a relationship by its ID
   *
   * @param id - Relationship ID to delete
   * @returns true if deleted, false if not found
   * @throws {GraphManagerError} If the operation fails
   */
  async deleteRelationship(id: string): Promise<boolean> {
    const cypher = `
      MATCH ()-[r:RELATIONSHIP {id: $id}]->()
      DELETE r
      RETURN count(r) as deleted
    `;

    try {
      const result = await this.config.neo4jClient.executeWrite<{ deleted: number }>(
        cypher,
        { id }
      );

      return result.deleted > 0;
    } catch (error) {
      throw new GraphManagerError(
        `Failed to delete relationship: ${error instanceof Error ? error.message : String(error)}`,
        "deleteRelationship",
        error instanceof Error ? error : undefined
      );
    }
  }

  // ==========================================================================
  // Query Operations
  // ==========================================================================

  /**
   * Find all entities of a specific type
   *
   * @param type - Entity type to filter by
   * @returns Array of matching entities
   * @throws {GraphManagerError} If the operation fails
   */
  async findEntitiesByType(type: EntityType): Promise<Entity[]> {
    const cypher = `
      MATCH (e:Entity {type: $type})
      RETURN e.id as id, e.type as type, e.name as name, e.properties as properties,
             e.createdAt as createdAt, e.updatedAt as updatedAt,
             e.eventTime as eventTime, e.ingestionTime as ingestionTime
      ORDER BY e.createdAt DESC
    `;

    try {
      const results = await this.config.neo4jClient.executeQuery<{
        id: string;
        type: string;
        name: string;
        properties: string;
        createdAt: string;
        updatedAt: string;
        eventTime: string;
        ingestionTime: string;
      }>(cypher, { type });

      return results.map((result) => this.mapToEntity(result));
    } catch (error) {
      throw new GraphManagerError(
        `Failed to find entities by type: ${error instanceof Error ? error.message : String(error)}`,
        "findEntitiesByType",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Find all relationships connected to an entity
   *
   * @param entityId - Entity ID to find relationships for
   * @returns Array of relationships (both incoming and outgoing)
   * @throws {GraphManagerError} If the operation fails
   */
  async findRelationshipsByEntity(entityId: string): Promise<Relationship[]> {
    const cypher = `
      MATCH (source:Entity)-[r:RELATIONSHIP]->(target:Entity)
      WHERE source.id = $entityId OR target.id = $entityId
      RETURN r.id as id, r.type as type, source.id as sourceId, target.id as targetId,
             r.properties as properties, r.weight as weight,
             r.createdAt as createdAt, r.updatedAt as updatedAt,
             r.eventTime as eventTime, r.ingestionTime as ingestionTime
      ORDER BY r.createdAt DESC
    `;

    try {
      const results = await this.config.neo4jClient.executeQuery<{
        id: string;
        type: string;
        sourceId: string;
        targetId: string;
        properties: string;
        weight: number;
        createdAt: string;
        updatedAt: string;
        eventTime: string;
        ingestionTime: string;
      }>(cypher, { entityId });

      return results.map((result) => this.mapToRelationship(result));
    } catch (error) {
      throw new GraphManagerError(
        `Failed to find relationships by entity: ${error instanceof Error ? error.message : String(error)}`,
        "findRelationshipsByEntity",
        error instanceof Error ? error : undefined
      );
    }
  }

  // ==========================================================================
  // Merge and Batch Operations
  // ==========================================================================

  /**
   * Merge (upsert) an entity - creates if not exists, updates if exists
   * Uses the entity name and type as the merge key
   *
   * @param entity - Full entity data to merge
   * @returns The merged entity
   * @throws {GraphManagerError} If the operation fails
   */
  async mergeEntity(entity: Entity): Promise<Entity> {
    if (!this.config.enableAutoMerge) {
      // If auto-merge is disabled, try to update, or create if not exists
      const existing = await this.getEntity(entity.id);
      if (existing) {
        return this.updateEntity(entity.id, {
          type: entity.type,
          name: entity.name,
          properties: entity.properties,
          eventTime: entity.eventTime,
          ingestionTime: entity.ingestionTime,
        });
      }
      return this.createEntity({
        type: entity.type,
        name: entity.name,
        properties: entity.properties,
        eventTime: entity.eventTime,
        ingestionTime: entity.ingestionTime,
      });
    }

    const now = new Date();

    const cypher = `
      MERGE (e:Entity {name: $name, type: $type})
      ON CREATE SET
        e.id = $id,
        e.properties = $properties,
        e.createdAt = datetime($createdAt),
        e.updatedAt = datetime($updatedAt),
        e.eventTime = datetime($eventTime),
        e.ingestionTime = datetime($ingestionTime)
      ON MATCH SET
        e.properties = $properties,
        e.updatedAt = datetime($updatedAt),
        e.eventTime = datetime($eventTime),
        e.ingestionTime = datetime($ingestionTime)
      RETURN e.id as id, e.type as type, e.name as name, e.properties as properties,
             e.createdAt as createdAt, e.updatedAt as updatedAt,
             e.eventTime as eventTime, e.ingestionTime as ingestionTime
    `;

    const params = {
      id: entity.id,
      type: entity.type,
      name: entity.name,
      properties: JSON.stringify(entity.properties),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      eventTime: entity.eventTime.toISOString(),
      ingestionTime: entity.ingestionTime.toISOString(),
    };

    try {
      const result = await this.config.neo4jClient.executeWrite<{
        id: string;
        type: string;
        name: string;
        properties: string;
        createdAt: string;
        updatedAt: string;
        eventTime: string;
        ingestionTime: string;
      }>(cypher, params);

      return this.mapToEntity(result);
    } catch (error) {
      throw new GraphManagerError(
        `Failed to merge entity: ${error instanceof Error ? error.message : String(error)}`,
        "mergeEntity",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Create multiple entities in batch
   *
   * @param entities - Array of entities to create
   * @returns Array of created entities
   * @throws {GraphManagerError} If the operation fails
   */
  async batchCreateEntities(entities: Entity[]): Promise<Entity[]> {
    if (entities.length === 0) {
      return [];
    }

    const batchSize = this.config.defaultBatchSize;
    const results: Entity[] = [];

    // Process in batches
    for (let i = 0; i < entities.length; i += batchSize) {
      const batch = entities.slice(i, i + batchSize);

      const cypher = `
        UNWIND $entities as entity
        CREATE (e:Entity {
          id: entity.id,
          type: entity.type,
          name: entity.name,
          properties: entity.properties,
          createdAt: datetime(entity.createdAt),
          updatedAt: datetime(entity.updatedAt),
          eventTime: datetime(entity.eventTime),
          ingestionTime: datetime(entity.ingestionTime)
        })
        RETURN e.id as id, e.type as type, e.name as name, e.properties as properties,
               e.createdAt as createdAt, e.updatedAt as updatedAt,
               e.eventTime as eventTime, e.ingestionTime as ingestionTime
      `;

      const now = new Date();
      const params = {
        entities: batch.map((entity) => ({
          id: entity.id || randomUUID(),
          type: entity.type,
          name: entity.name,
          properties: JSON.stringify(entity.properties),
          createdAt: entity.createdAt?.toISOString() ?? now.toISOString(),
          updatedAt: entity.updatedAt?.toISOString() ?? now.toISOString(),
          eventTime: entity.eventTime.toISOString(),
          ingestionTime: entity.ingestionTime.toISOString(),
        })),
      };

      try {
        const batchResults = await this.config.neo4jClient.executeQuery<{
          id: string;
          type: string;
          name: string;
          properties: string;
          createdAt: string;
          updatedAt: string;
          eventTime: string;
          ingestionTime: string;
        }>(cypher, params);

        results.push(...batchResults.map((result) => this.mapToEntity(result)));
      } catch (error) {
        throw new GraphManagerError(
          `Failed to batch create entities: ${error instanceof Error ? error.message : String(error)}`,
          "batchCreateEntities",
          error instanceof Error ? error : undefined
        );
      }
    }

    return results;
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
   * Map a query result to a Relationship object
   */
  private mapToRelationship(result: {
    id: string;
    type: string;
    sourceId: string;
    targetId: string;
    properties: string;
    weight: number;
    createdAt: string;
    updatedAt: string;
    eventTime: string;
    ingestionTime: string;
  }): Relationship {
    return {
      id: result.id,
      type: result.type as RelationshipType,
      sourceId: result.sourceId,
      targetId: result.targetId,
      properties: this.parseProperties(result.properties),
      weight: result.weight,
      createdAt: new Date(result.createdAt),
      updatedAt: new Date(result.updatedAt),
      eventTime: new Date(result.eventTime),
      ingestionTime: new Date(result.ingestionTime),
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
 * Create a GraphManager with the given configuration
 *
 * @param config - GraphManager configuration
 * @returns Configured GraphManager instance
 */
export function createGraphManager(config: GraphManagerConfig): GraphManager {
  return new GraphManager(config);
}
