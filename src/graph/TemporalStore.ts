/**
 * Temporal Store with Bi-Temporal Tracking for Graphiti Integration
 *
 * Provides bi-temporal storage for entities and relationships in Neo4j,
 * supporting both event time (when facts occurred) and ingestion time
 * (when facts were recorded).
 *
 * @module graph/TemporalStore
 * @version 1.0.0
 */

import type { Neo4jClient } from "./Neo4jClient.js";
import type { Entity, Relationship, EntityType } from "../types/graph.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for the TemporalStore
 */
export interface TemporalStoreConfig {
  /** Neo4j client instance for database operations */
  neo4jClient: Neo4jClient;
  /** Default retention period in days (default: 365) */
  defaultRetentionDays?: number;
  /** Enable version tracking for entities (default: true) */
  enableVersioning?: boolean;
}

/**
 * Internal configuration with resolved defaults
 */
interface ResolvedConfig {
  neo4jClient: Neo4jClient;
  defaultRetentionDays: number;
  enableVersioning: boolean;
}

// ============================================================================
// Bi-Temporal Metadata
// ============================================================================

/**
 * Bi-temporal metadata for entities and relationships.
 *
 * Supports two time dimensions:
 * - Event time: When the fact occurred in the real world (business time)
 * - Ingestion time: When the fact was recorded in the system (system time)
 *
 * Plus validity period for tracking when records are active.
 */
export interface BiTemporalMeta {
  /** When the fact occurred in the real world (business time) */
  eventTime: Date;
  /** When the fact was recorded in the system (system time) */
  ingestionTime: Date;
  /** Start of validity period */
  validFrom: Date;
  /** End of validity period (null = still valid/current) */
  validTo: Date | null;
  /** Version number for this record */
  version: number;
}

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Error thrown when temporal store operations fail
 */
export class TemporalStoreError extends Error {
  public readonly code: string | undefined;
  public override readonly cause: Error | undefined;

  constructor(message: string, code?: string, cause?: Error) {
    super(message);
    this.name = "TemporalStoreError";
    this.code = code ?? undefined;
    this.cause = cause ?? undefined;
    Object.setPrototypeOf(this, TemporalStoreError.prototype);
  }
}

// ============================================================================
// Default Values
// ============================================================================

const DEFAULT_RETENTION_DAYS = 365;
const DEFAULT_ENABLE_VERSIONING = true;

// ============================================================================
// Temporal Store Implementation
// ============================================================================

/**
 * Temporal Store provides bi-temporal storage for entities and relationships.
 *
 * Features:
 * - Bi-temporal tracking (event time + ingestion time)
 * - Version history for entities
 * - Point-in-time queries
 * - Validity period management
 *
 * @example
 * ```typescript
 * const store = new TemporalStore({
 *   neo4jClient: client,
 *   defaultRetentionDays: 365,
 *   enableVersioning: true,
 * });
 *
 * // Store entity with event time
 * const id = await store.storeEntity(entity, new Date('2024-01-15'));
 *
 * // Query entity at specific point in time
 * const historical = await store.getEntityAtTime(id, new Date('2024-01-20'));
 *
 * // Get full version history
 * const history = await store.getEntityHistory(id);
 * ```
 */
export class TemporalStore {
  private readonly config: ResolvedConfig;

  constructor(config: TemporalStoreConfig) {
    this.config = {
      neo4jClient: config.neo4jClient,
      defaultRetentionDays: config.defaultRetentionDays ?? DEFAULT_RETENTION_DAYS,
      enableVersioning: config.enableVersioning ?? DEFAULT_ENABLE_VERSIONING,
    };
  }

  /**
   * Store an entity with bi-temporal metadata.
   *
   * @param entity - Entity to store
   * @param eventTime - When the fact occurred (defaults to now)
   * @returns Entity ID
   * @throws {TemporalStoreError} If storage fails
   */
  async storeEntity(entity: Entity, eventTime?: Date): Promise<string> {
    const now = new Date();
    const resolvedEventTime = eventTime ?? now;

    const cypher = `
      CREATE (e:Entity {
        id: $id,
        entityType: $entityType,
        name: $name,
        properties: $properties,
        createdAt: datetime($createdAt),
        updatedAt: datetime($updatedAt),
        eventTime: datetime($eventTime),
        ingestionTime: datetime($ingestionTime),
        validFrom: datetime($validFrom),
        validTo: $validTo,
        version: $version
      })
      RETURN e.id as id
    `;

    const params = {
      id: entity.id,
      entityType: entity.type,
      name: entity.name,
      properties: JSON.stringify(entity.properties),
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      eventTime: resolvedEventTime.toISOString(),
      ingestionTime: now.toISOString(),
      validFrom: now.toISOString(),
      validTo: null,
      version: 1,
    };

    try {
      const result = await this.config.neo4jClient.executeWrite<{ id: string }>(
        cypher,
        params
      );
      return result.id;
    } catch (error) {
      throw new TemporalStoreError(
        `Failed to store entity ${entity.id}: ${error instanceof Error ? error.message : String(error)}`,
        "STORE_ENTITY_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get an entity as it was at a specific point in time.
   *
   * Uses bi-temporal query to find the entity version that was valid
   * at the given asOfTime, considering both event time and validity period.
   *
   * @param id - Entity ID
   * @param asOfTime - Point in time to query
   * @returns Entity if found, null otherwise
   * @throws {TemporalStoreError} If query fails
   */
  async getEntityAtTime(id: string, asOfTime: Date): Promise<Entity | null> {
    const cypher = `
      MATCH (e:Entity {id: $id})
      WHERE datetime($asOfTime) >= e.validFrom
        AND (e.validTo IS NULL OR datetime($asOfTime) < e.validTo)
        AND datetime($asOfTime) >= e.eventTime
      RETURN e.id as id,
             e.entityType as entityType,
             e.name as name,
             e.properties as properties,
             e.createdAt as createdAt,
             e.updatedAt as updatedAt,
             e.eventTime as eventTime,
             e.ingestionTime as ingestionTime
      ORDER BY e.version DESC
      LIMIT 1
    `;

    const params = {
      id,
      asOfTime: asOfTime.toISOString(),
    };

    try {
      const results = await this.config.neo4jClient.executeQuery<{
        id: string;
        entityType: EntityType;
        name: string;
        properties: string;
        createdAt: string;
        updatedAt: string;
        eventTime: string;
        ingestionTime: string;
      }>(cypher, params);

      if (results.length === 0) {
        return null;
      }

      const row = results[0];
      if (row === undefined) {
        return null;
      }

      return {
        id: row.id,
        type: row.entityType,
        name: row.name,
        properties: JSON.parse(row.properties),
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
        eventTime: new Date(row.eventTime),
        ingestionTime: new Date(row.ingestionTime),
      };
    } catch (error) {
      throw new TemporalStoreError(
        `Failed to get entity ${id} at time ${asOfTime.toISOString()}: ${error instanceof Error ? error.message : String(error)}`,
        "GET_ENTITY_AT_TIME_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get the complete version history of an entity.
   *
   * Returns all versions of the entity, including bi-temporal metadata,
   * ordered by version number descending (newest first).
   *
   * @param id - Entity ID
   * @returns Array of entity versions with bi-temporal metadata
   * @throws {TemporalStoreError} If query fails
   */
  async getEntityHistory(id: string): Promise<Array<Entity & BiTemporalMeta>> {
    const cypher = `
      MATCH (e:Entity {id: $id})
      RETURN e.id as id,
             e.entityType as entityType,
             e.name as name,
             e.properties as properties,
             e.createdAt as createdAt,
             e.updatedAt as updatedAt,
             e.eventTime as eventTime,
             e.ingestionTime as ingestionTime,
             e.validFrom as validFrom,
             e.validTo as validTo,
             e.version as version
      ORDER BY e.version DESC
    `;

    const params = { id };

    try {
      const results = await this.config.neo4jClient.executeQuery<{
        id: string;
        entityType: EntityType;
        name: string;
        properties: string;
        createdAt: string;
        updatedAt: string;
        eventTime: string;
        ingestionTime: string;
        validFrom: string;
        validTo: string | null;
        version: number;
      }>(cypher, params);

      return results.map((row) => ({
        id: row.id,
        type: row.entityType,
        name: row.name,
        properties: JSON.parse(row.properties),
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
        eventTime: new Date(row.eventTime),
        ingestionTime: new Date(row.ingestionTime),
        validFrom: new Date(row.validFrom),
        validTo: row.validTo !== null ? new Date(row.validTo) : null,
        version: row.version,
      }));
    } catch (error) {
      throw new TemporalStoreError(
        `Failed to get history for entity ${id}: ${error instanceof Error ? error.message : String(error)}`,
        "GET_ENTITY_HISTORY_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Store a relationship with bi-temporal metadata.
   *
   * @param relationship - Relationship to store
   * @param eventTime - When the relationship occurred (defaults to now)
   * @returns Relationship ID
   * @throws {TemporalStoreError} If storage fails
   */
  async storeRelationship(
    relationship: Relationship,
    eventTime?: Date
  ): Promise<string> {
    const now = new Date();
    const resolvedEventTime = eventTime ?? now;

    const cypher = `
      MATCH (source:Entity {id: $sourceId})
      MATCH (target:Entity {id: $targetId})
      CREATE (source)-[r:RELATES_TO {
        id: $id,
        relType: $relType,
        sourceId: $sourceId,
        targetId: $targetId,
        properties: $properties,
        weight: $weight,
        createdAt: datetime($createdAt),
        updatedAt: datetime($updatedAt),
        eventTime: datetime($eventTime),
        ingestionTime: datetime($ingestionTime),
        validFrom: datetime($validFrom),
        validTo: $validTo,
        version: $version
      }]->(target)
      RETURN r.id as id
    `;

    const params = {
      id: relationship.id,
      relType: relationship.type,
      sourceId: relationship.sourceId,
      targetId: relationship.targetId,
      properties: JSON.stringify(relationship.properties),
      weight: relationship.weight,
      createdAt: relationship.createdAt.toISOString(),
      updatedAt: relationship.updatedAt.toISOString(),
      eventTime: resolvedEventTime.toISOString(),
      ingestionTime: now.toISOString(),
      validFrom: now.toISOString(),
      validTo: null,
      version: 1,
    };

    try {
      const result = await this.config.neo4jClient.executeWrite<{ id: string }>(
        cypher,
        params
      );
      return result.id;
    } catch (error) {
      throw new TemporalStoreError(
        `Failed to store relationship ${relationship.id}: ${error instanceof Error ? error.message : String(error)}`,
        "STORE_RELATIONSHIP_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Invalidate an entity by setting its validTo timestamp.
   *
   * This marks the entity as no longer valid without deleting it,
   * preserving the historical record.
   *
   * @param id - Entity ID to invalidate
   * @throws {TemporalStoreError} If invalidation fails
   */
  async invalidateEntity(id: string): Promise<void> {
    const now = new Date();

    const cypher = `
      MATCH (e:Entity {id: $id})
      WHERE e.validTo IS NULL
      SET e.validTo = datetime($validTo),
          e.updatedAt = datetime($updatedAt)
      RETURN e.id as id
    `;

    const params = {
      id,
      validTo: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    try {
      await this.config.neo4jClient.executeWrite<{ id: string }>(cypher, params);
    } catch (error) {
      throw new TemporalStoreError(
        `Failed to invalidate entity ${id}: ${error instanceof Error ? error.message : String(error)}`,
        "INVALIDATE_ENTITY_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Update an entity with version tracking.
   *
   * When versioning is enabled, this creates a new version node and
   * invalidates the previous version. When disabled, it updates in place.
   *
   * @param id - Entity ID to update
   * @param updates - Partial entity updates
   * @param eventTime - When the update occurred (defaults to now)
   * @returns Updated entity ID
   * @throws {TemporalStoreError} If update fails
   */
  async updateEntity(
    id: string,
    updates: Partial<Entity>,
    eventTime?: Date
  ): Promise<string> {
    const now = new Date();
    const resolvedEventTime = eventTime ?? now;

    if (this.config.enableVersioning) {
      return this.updateEntityWithVersioning(id, updates, resolvedEventTime, now);
    } else {
      return this.updateEntityInPlace(id, updates, resolvedEventTime, now);
    }
  }

  /**
   * Update entity with version tracking - creates new version node
   */
  private async updateEntityWithVersioning(
    id: string,
    updates: Partial<Entity>,
    eventTime: Date,
    now: Date
  ): Promise<string> {
    // First, get the current version and invalidate it
    const getCurrentCypher = `
      MATCH (e:Entity {id: $id})
      WHERE e.validTo IS NULL
      RETURN e.id as id,
             e.entityType as entityType,
             e.name as name,
             e.properties as properties,
             e.createdAt as createdAt,
             e.version as version
    `;

    try {
      const currentResults = await this.config.neo4jClient.executeQuery<{
        id: string;
        entityType: EntityType;
        name: string;
        properties: string;
        createdAt: string;
        version: number;
      }>(getCurrentCypher, { id });

      if (currentResults.length === 0) {
        throw new TemporalStoreError(
          `Entity ${id} not found or already invalidated`,
          "ENTITY_NOT_FOUND"
        );
      }

      const current = currentResults[0];
      if (current === undefined) {
        throw new TemporalStoreError(
          `Entity ${id} not found`,
          "ENTITY_NOT_FOUND"
        );
      }

      const newVersion = current.version + 1;
      const newType = updates.type ?? current.entityType;
      const newName = updates.name ?? current.name;
      const newProperties = updates.properties
        ? JSON.stringify(updates.properties)
        : current.properties;

      // Invalidate old version and create new version in a transaction
      const updateCypher = `
        MATCH (old:Entity {id: $id})
        WHERE old.validTo IS NULL
        SET old.validTo = datetime($validTo)
        CREATE (new:Entity {
          id: $id,
          entityType: $newType,
          name: $newName,
          properties: $newProperties,
          createdAt: datetime($createdAt),
          updatedAt: datetime($updatedAt),
          eventTime: datetime($eventTime),
          ingestionTime: datetime($ingestionTime),
          validFrom: datetime($validFrom),
          validTo: $newValidTo,
          version: $version
        })
        RETURN new.id as id
      `;

      const params = {
        id,
        validTo: now.toISOString(),
        newType,
        newName,
        newProperties,
        createdAt: current.createdAt,
        updatedAt: now.toISOString(),
        eventTime: eventTime.toISOString(),
        ingestionTime: now.toISOString(),
        validFrom: now.toISOString(),
        newValidTo: null,
        version: newVersion,
      };

      const result = await this.config.neo4jClient.executeWrite<{ id: string }>(
        updateCypher,
        params
      );
      return result.id;
    } catch (error) {
      if (error instanceof TemporalStoreError) {
        throw error;
      }
      throw new TemporalStoreError(
        `Failed to update entity ${id}: ${error instanceof Error ? error.message : String(error)}`,
        "UPDATE_ENTITY_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Update entity in place without version tracking
   */
  private async updateEntityInPlace(
    id: string,
    updates: Partial<Entity>,
    eventTime: Date,
    now: Date
  ): Promise<string> {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = {
      id,
      updatedAt: now.toISOString(),
      eventTime: eventTime.toISOString(),
    };

    setClauses.push("e.updatedAt = datetime($updatedAt)");
    setClauses.push("e.eventTime = datetime($eventTime)");

    if (updates.type !== undefined) {
      params["entityType"] = updates.type;
      setClauses.push("e.entityType = $entityType");
    }

    if (updates.name !== undefined) {
      params["name"] = updates.name;
      setClauses.push("e.name = $name");
    }

    if (updates.properties !== undefined) {
      params["properties"] = JSON.stringify(updates.properties);
      setClauses.push("e.properties = $properties");
    }

    const cypher = `
      MATCH (e:Entity {id: $id})
      WHERE e.validTo IS NULL
      SET ${setClauses.join(", ")}
      RETURN e.id as id
    `;

    try {
      const result = await this.config.neo4jClient.executeWrite<{ id: string }>(
        cypher,
        params
      );
      return result.id;
    } catch (error) {
      throw new TemporalStoreError(
        `Failed to update entity ${id}: ${error instanceof Error ? error.message : String(error)}`,
        "UPDATE_ENTITY_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get the default retention days configuration
   */
  getDefaultRetentionDays(): number {
    return this.config.defaultRetentionDays;
  }

  /**
   * Check if versioning is enabled
   */
  isVersioningEnabled(): boolean {
    return this.config.enableVersioning;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a TemporalStore with the given configuration
 *
 * @param config - Store configuration
 * @returns Configured TemporalStore instance
 */
export function createTemporalStore(config: TemporalStoreConfig): TemporalStore {
  return new TemporalStore(config);
}
