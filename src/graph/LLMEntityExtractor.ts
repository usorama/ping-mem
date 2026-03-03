/**
 * LLM-based Entity Extractor for ping-mem Knowledge Graph
 *
 * Uses OpenAI structured output to extract entities and relationships from text,
 * with a regex-based EntityExtractor as fallback on LLM failure.
 *
 * @module graph/LLMEntityExtractor
 * @version 1.0.0
 */

import { randomUUID } from "crypto";
import { EntityType, RelationshipType } from "../types/graph.js";
import type { Entity, Relationship, EntityExtractResult } from "../types/graph.js";
import type { EntityExtractor } from "./EntityExtractor.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Typed interface for the OpenAI client subset used by this extractor.
 * Avoids importing the full OpenAI SDK type to keep coupling minimal.
 */
interface OpenAIClient {
  chat: {
    completions: {
      create: (params: unknown) => Promise<{
        choices: Array<{ message: { content: string | null } }>;
      }>;
    };
  };
}

/**
 * Configuration for the LLMEntityExtractor.
 */
export interface LLMEntityExtractorConfig {
  /** OpenAI client instance (or compatible mock) */
  openai: OpenAIClient;
  /** Optional regex-based fallback extractor for when LLM calls fail */
  fallbackExtractor?: EntityExtractor;
  /** OpenAI model to use (default: "gpt-4o-mini") */
  model?: string;
}

/**
 * Result from LLM entity extraction, including both entities and relationships.
 */
export interface LLMExtractionResult {
  /** Extracted entities */
  entities: Entity[];
  /** Extracted relationships between entities */
  relationships: Relationship[];
  /** Overall confidence score (0-1) */
  confidence: number;
}

/**
 * Shape of a single entity as returned by the LLM JSON output.
 */
interface LLMEntityOutput {
  name: string;
  type: string;
  confidence: number;
  context: string;
}

/**
 * Shape of a single relationship as returned by the LLM JSON output.
 */
interface LLMRelationshipOutput {
  source: string;
  target: string;
  type: string;
  confidence: number;
  evidence: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Minimum confidence threshold for including an entity */
const MIN_ENTITY_CONFIDENCE = 0.7;

/** Minimum confidence threshold for including a relationship */
const MIN_RELATIONSHIP_CONFIDENCE = 0.5;

/**
 * Maps string entity type names to the EntityType enum values.
 */
const ENTITY_TYPE_MAP: Record<string, EntityType> = {
  CONCEPT: EntityType.CONCEPT,
  PERSON: EntityType.PERSON,
  ORGANIZATION: EntityType.ORGANIZATION,
  LOCATION: EntityType.LOCATION,
  EVENT: EntityType.EVENT,
  CODE_FILE: EntityType.CODE_FILE,
  CODE_FUNCTION: EntityType.CODE_FUNCTION,
  CODE_CLASS: EntityType.CODE_CLASS,
  DECISION: EntityType.DECISION,
  TASK: EntityType.TASK,
  ERROR: EntityType.ERROR,
  FACT: EntityType.FACT,
};

/**
 * Maps string relationship type names to the RelationshipType enum values.
 */
const RELATIONSHIP_TYPE_MAP: Record<string, RelationshipType> = {
  DEPENDS_ON: RelationshipType.DEPENDS_ON,
  RELATED_TO: RelationshipType.RELATED_TO,
  CAUSES: RelationshipType.CAUSES,
  IMPLEMENTS: RelationshipType.IMPLEMENTS,
  USES: RelationshipType.USES,
  REFERENCES: RelationshipType.REFERENCES,
  FOLLOWS: RelationshipType.FOLLOWS,
  CONTAINS: RelationshipType.CONTAINS,
  DERIVED_FROM: RelationshipType.DERIVED_FROM,
  BLOCKS: RelationshipType.BLOCKS,
};

/**
 * System prompt instructing the LLM to extract entities and relationships as structured JSON.
 */
const SYSTEM_PROMPT = `You are an entity and relationship extractor for a knowledge graph. Extract entities and relationships from the given text.

Return JSON with this exact structure:
{
  "entities": [
    { "name": "EntityName", "type": "ENTITY_TYPE", "confidence": 0.95, "context": "brief context" }
  ],
  "relationships": [
    { "source": "SourceEntity", "target": "TargetEntity", "type": "RELATIONSHIP_TYPE", "confidence": 0.85, "evidence": "supporting text" }
  ]
}

Entity types: CONCEPT, PERSON, ORGANIZATION, LOCATION, EVENT, CODE_FILE, CODE_FUNCTION, CODE_CLASS, DECISION, TASK, ERROR, FACT
Relationship types: DEPENDS_ON, RELATED_TO, CAUSES, IMPLEMENTS, USES, REFERENCES, FOLLOWS, CONTAINS, DERIVED_FROM, BLOCKS

Rules:
- Only extract clearly mentioned entities (confidence > 0.7)
- Use the most specific entity type available
- Include evidence for each relationship`;

// ============================================================================
// LLMEntityExtractor Class
// ============================================================================

/**
 * LLM-based entity and relationship extractor.
 *
 * Sends text to OpenAI for structured JSON extraction of entities and relationships,
 * mapping results to the ping-mem knowledge graph types. Falls back to a regex-based
 * EntityExtractor when the LLM call fails.
 *
 * @example
 * ```typescript
 * import OpenAI from "openai";
 * import { LLMEntityExtractor } from "./LLMEntityExtractor.js";
 * import { EntityExtractor } from "./EntityExtractor.js";
 *
 * const extractor = new LLMEntityExtractor({
 *   openai: new OpenAI(),
 *   fallbackExtractor: new EntityExtractor(),
 *   model: "gpt-4o-mini",
 * });
 *
 * const result = await extractor.extract("AuthService handles user login via OAuth2");
 * console.log(result.entities);       // Entity[]
 * console.log(result.relationships);  // Relationship[]
 * console.log(result.confidence);     // number (0-1)
 * ```
 */
export class LLMEntityExtractor {
  private readonly openai: OpenAIClient;
  private readonly fallbackExtractor: EntityExtractor | null;
  private readonly model: string;

  constructor(config: LLMEntityExtractorConfig) {
    this.openai = config.openai;
    this.fallbackExtractor = config.fallbackExtractor ?? null;
    this.model = config.model ?? "gpt-4o-mini";
  }

  /**
   * Extracts entities and relationships from the given text using the LLM.
   * Falls back to the regex-based extractor on any error.
   *
   * @param text - The text to extract entities and relationships from
   * @returns LLMExtractionResult with entities, relationships, and confidence
   */
  async extract(text: string): Promise<LLMExtractionResult> {
    try {
      return await this.extractWithLLM(text);
    } catch (error) {
      console.warn("[LLMEntityExtractor] LLM extraction failed, falling back to regex:", error instanceof Error ? error.message : String(error));
      return this.handleFallback(text);
    }
  }

  /**
   * Performs the LLM-based extraction.
   */
  private async extractWithLLM(text: string): Promise<LLMExtractionResult> {
    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Empty response from LLM");
    }

    const parsed = JSON.parse(content) as {
      entities?: LLMEntityOutput[];
      relationships?: LLMRelationshipOutput[];
    };

    const now = new Date();
    const entityNameToId = new Map<string, string>();

    const entities = this.mapEntities(parsed.entities ?? [], now, entityNameToId);
    const relationships = this.mapRelationships(parsed.relationships ?? [], now, entityNameToId);

    const avgConfidence = entities.length > 0
      ? entities.reduce((sum, e) => sum + ((e.properties["confidence"] as number | undefined) ?? 0), 0) / entities.length
      : 0;

    return { entities, relationships, confidence: avgConfidence };
  }

  /**
   * Maps raw LLM entity outputs to typed Entity objects, filtering by confidence.
   */
  private mapEntities(
    rawEntities: LLMEntityOutput[],
    now: Date,
    entityNameToId: Map<string, string>,
  ): Entity[] {
    return rawEntities
      .filter((e) => e.confidence >= MIN_ENTITY_CONFIDENCE)
      .map((e) => {
        const id = randomUUID();
        entityNameToId.set(e.name, id);
        return {
          id,
          name: e.name,
          type: ENTITY_TYPE_MAP[e.type] ?? EntityType.CONCEPT,
          properties: { context: e.context, confidence: e.confidence },
          createdAt: now,
          updatedAt: now,
          eventTime: now,
          ingestionTime: now,
        };
      });
  }

  /**
   * Maps raw LLM relationship outputs to typed Relationship objects, filtering by confidence.
   * Resolves source/target names to entity IDs where possible.
   */
  private mapRelationships(
    rawRelationships: LLMRelationshipOutput[],
    now: Date,
    entityNameToId: Map<string, string>,
  ): Relationship[] {
    return rawRelationships
      .filter((r) => r.confidence >= MIN_RELATIONSHIP_CONFIDENCE)
      .map((r) => ({
        id: randomUUID(),
        type: RELATIONSHIP_TYPE_MAP[r.type] ?? RelationshipType.RELATED_TO,
        sourceId: entityNameToId.get(r.source) ?? r.source,
        targetId: entityNameToId.get(r.target) ?? r.target,
        properties: { evidence: r.evidence, confidence: r.confidence },
        weight: r.confidence,
        createdAt: now,
        updatedAt: now,
        eventTime: now,
        ingestionTime: now,
      }));
  }

  /**
   * Handles fallback when LLM extraction fails.
   * Delegates to the regex-based EntityExtractor if configured, otherwise returns empty.
   */
  private handleFallback(text: string): LLMExtractionResult {
    if (this.fallbackExtractor) {
      const fallbackResult: EntityExtractResult = this.fallbackExtractor.extract(text);
      return {
        entities: fallbackResult.entities,
        relationships: [],
        confidence: fallbackResult.confidence,
      };
    }
    return { entities: [], relationships: [], confidence: 0 };
  }
}
