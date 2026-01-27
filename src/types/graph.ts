/**
 * Graph Type Definitions for ping-mem Graphiti Integration
 *
 * These types support knowledge graph operations including entity extraction,
 * relationship inference, and temporal graph queries via Graphiti.
 *
 * @module types/graph
 * @version 1.0.0
 */

// ============================================================================
// Entity Types
// ============================================================================

/**
 * Types of entities that can be extracted and stored in the knowledge graph.
 * These categories support both general knowledge and code-specific entities.
 */
export enum EntityType {
  /** Abstract concept or idea */
  CONCEPT = "CONCEPT",
  /** Person or individual */
  PERSON = "PERSON",
  /** Organization, company, or group */
  ORGANIZATION = "ORGANIZATION",
  /** Physical or virtual location */
  LOCATION = "LOCATION",
  /** Event, occurrence, or incident */
  EVENT = "EVENT",
  /** Source code file */
  CODE_FILE = "CODE_FILE",
  /** Function or method in code */
  CODE_FUNCTION = "CODE_FUNCTION",
  /** Class or type definition in code */
  CODE_CLASS = "CODE_CLASS",
  /** Decision made during development */
  DECISION = "DECISION",
  /** Task or work item */
  TASK = "TASK",
  /** Error or exception encountered */
  ERROR = "ERROR",
  /** Factual information or assertion */
  FACT = "FACT",
}

/**
 * An entity in the knowledge graph representing a distinct concept or object.
 * Entities are nodes in the graph that can be connected via relationships.
 */
export interface Entity {
  /** Unique entity identifier */
  id: string;
  /** Type/category of the entity */
  type: EntityType;
  /** Human-readable name for the entity */
  name: string;
  /** Additional properties specific to this entity */
  properties: Record<string, unknown>;
  /** When the entity was first created in the graph */
  createdAt: Date;
  /** When the entity was last updated */
  updatedAt: Date;
  /** When the event that created/modified this entity occurred (business time) */
  eventTime: Date;
  /** When this entity was ingested into the graph (system time) */
  ingestionTime: Date;
}

// ============================================================================
// Relationship Types
// ============================================================================

/**
 * Types of relationships that can exist between entities in the knowledge graph.
 * These edge types capture various semantic connections.
 */
export enum RelationshipType {
  /** Source depends on target (dependency relationship) */
  DEPENDS_ON = "DEPENDS_ON",
  /** General semantic relationship */
  RELATED_TO = "RELATED_TO",
  /** Source causes or leads to target */
  CAUSES = "CAUSES",
  /** Source implements target (e.g., class implements interface) */
  IMPLEMENTS = "IMPLEMENTS",
  /** Source uses or utilizes target */
  USES = "USES",
  /** Source references target */
  REFERENCES = "REFERENCES",
  /** Source follows or comes after target (temporal/logical ordering) */
  FOLLOWS = "FOLLOWS",
  /** Source contains target (containment relationship) */
  CONTAINS = "CONTAINS",
  /** Source is derived from target */
  DERIVED_FROM = "DERIVED_FROM",
  /** Source blocks target (blocking dependency) */
  BLOCKS = "BLOCKS",
}

/**
 * A relationship (edge) between two entities in the knowledge graph.
 * Relationships connect entities and carry semantic meaning.
 */
export interface Relationship {
  /** Unique relationship identifier */
  id: string;
  /** Type of relationship */
  type: RelationshipType;
  /** ID of the source entity (where the relationship originates) */
  sourceId: string;
  /** ID of the target entity (where the relationship points) */
  targetId: string;
  /** Additional properties specific to this relationship */
  properties: Record<string, unknown>;
  /** Relationship strength/confidence weight (0-1) */
  weight: number;
  /** When the relationship was first created in the graph */
  createdAt: Date;
  /** When the relationship was last updated */
  updatedAt: Date;
  /** When the event that created/modified this relationship occurred (business time) */
  eventTime: Date;
  /** When this relationship was ingested into the graph (system time) */
  ingestionTime: Date;
}

// ============================================================================
// Extraction Result Types
// ============================================================================

/**
 * Result from entity extraction operation.
 * Contains extracted entities and a confidence score for the extraction.
 */
export interface EntityExtractResult {
  /** Entities extracted from the input */
  entities: Entity[];
  /** Overall confidence in the extraction (0-1) */
  confidence: number;
}

/**
 * Result from relationship inference operation.
 * Contains inferred relationships and a confidence score.
 */
export interface RelationshipInferResult {
  /** Relationships inferred between entities */
  relationships: Relationship[];
  /** Overall confidence in the inference (0-1) */
  confidence: number;
}
