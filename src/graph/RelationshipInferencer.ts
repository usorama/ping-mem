/**
 * Rule-based Relationship Inferencer for ping-mem Graphiti Integration
 *
 * Infers relationships between entities using configurable pattern-based rules.
 * Supports multiple relationship types including dependencies, implementations,
 * uses, references, causes, and blocks.
 *
 * @module graph/RelationshipInferencer
 * @version 1.0.0
 */

import {
  EntityType,
  Entity,
  RelationshipType,
  Relationship,
  RelationshipInferResult,
} from "../types/graph.js";
import { randomUUID } from "crypto";

// ============================================================================
// Types
// ============================================================================

/**
 * Rule for inferring relationships between entity pairs.
 * Defines source/target type constraints and context patterns.
 */
export interface InferenceRule {
  /** Entity types that can be the source of this relationship */
  sourceTypes: EntityType[];
  /** Entity types that can be the target of this relationship */
  targetTypes: EntityType[];
  /** Regex patterns to match in context for this relationship */
  patterns: RegExp[];
  /** Weight multiplier for this rule (0-1, higher = stronger signal) */
  weight: number;
}

/**
 * Configuration for the RelationshipInferencer.
 */
export interface RelationshipInferencerConfig {
  /** Minimum confidence threshold for relationship inclusion (0-1) */
  minConfidence: number;
  /** Maximum relationships to infer between any entity pair */
  maxRelationshipsPerPair: number;
  /** Map from relationship type to inference rules */
  inferenceRules: Map<RelationshipType, InferenceRule[]>;
}

// ============================================================================
// Default Inference Rules
// ============================================================================

/**
 * Default inference rules for each relationship type.
 * These rules define entity type constraints and context patterns.
 */
const DEFAULT_INFERENCE_RULES: Map<RelationshipType, InferenceRule[]> = new Map([
  // DEPENDS_ON: Code dependencies and import relationships
  [
    RelationshipType.DEPENDS_ON,
    [
      // Code files depend on other files (import/require)
      {
        sourceTypes: [EntityType.CODE_FILE, EntityType.CODE_FUNCTION, EntityType.CODE_CLASS],
        targetTypes: [EntityType.CODE_FILE, EntityType.CODE_CLASS, EntityType.CODE_FUNCTION],
        patterns: [
          /\b(?:import|require)\s+(?:.*?\s+from\s+)?['"]?([^'";\s]+)['"]?/gi,
          /\bimports?\s+(?:from\s+)?/gi,
          /\bdepends?\s+on\b/gi,
          /\brequires?\b/gi,
          /\bneeds?\b/gi,
          /\busing\b/gi,
          /\brelies?\s+on\b/gi,
        ],
        weight: 0.8,
      },
      // Tasks depending on other tasks
      {
        sourceTypes: [EntityType.TASK],
        targetTypes: [EntityType.TASK, EntityType.CODE_FILE, EntityType.CODE_CLASS],
        patterns: [
          /\bdepends?\s+on\b/gi,
          /\brequires?\b/gi,
          /\bafter\b/gi,
          /\bneeds?\b/gi,
          /\bprerequisite\b/gi,
        ],
        weight: 0.7,
      },
    ],
  ],

  // IMPLEMENTS: Implementation relationships
  [
    RelationshipType.IMPLEMENTS,
    [
      // Class implements interface or concept
      {
        sourceTypes: [EntityType.CODE_CLASS, EntityType.CODE_FILE],
        targetTypes: [EntityType.CODE_CLASS, EntityType.CONCEPT],
        patterns: [
          /\bimplements?\b/gi,
          /\bextends?\b/gi,
          /\brealizes?\b/gi,
          /\bconforms?\s+to\b/gi,
          /\bsatisfies?\b/gi,
        ],
        weight: 0.9,
      },
      // Task implements a decision or concept
      {
        sourceTypes: [EntityType.TASK],
        targetTypes: [EntityType.DECISION, EntityType.CONCEPT],
        patterns: [
          /\bimplements?\b/gi,
          /\bexecutes?\b/gi,
          /\bcarries?\s+out\b/gi,
          /\brealizes?\b/gi,
        ],
        weight: 0.7,
      },
    ],
  ],

  // USES: General usage relationships
  [
    RelationshipType.USES,
    [
      // Code entities using other entities
      {
        sourceTypes: [
          EntityType.CODE_FILE,
          EntityType.CODE_FUNCTION,
          EntityType.CODE_CLASS,
        ],
        targetTypes: [
          EntityType.CODE_FILE,
          EntityType.CODE_FUNCTION,
          EntityType.CODE_CLASS,
          EntityType.CONCEPT,
        ],
        patterns: [
          /\buses?\b/gi,
          /\butilizes?\b/gi,
          /\bcalls?\b/gi,
          /\binvokes?\b/gi,
          /\bemployes?\b/gi,
          /\bleverage[sd]?\b/gi,
        ],
        weight: 0.7,
      },
      // Person/organization uses tools/concepts
      {
        sourceTypes: [EntityType.PERSON, EntityType.ORGANIZATION],
        targetTypes: [
          EntityType.CODE_FILE,
          EntityType.CODE_CLASS,
          EntityType.CONCEPT,
          EntityType.ORGANIZATION,
        ],
        patterns: [
          /\buses?\b/gi,
          /\butilizes?\b/gi,
          /\bworks?\s+with\b/gi,
          /\bemployes?\b/gi,
        ],
        weight: 0.6,
      },
    ],
  ],

  // REFERENCES: Reference relationships
  [
    RelationshipType.REFERENCES,
    [
      // General references between entities
      {
        sourceTypes: [
          EntityType.CODE_FILE,
          EntityType.CODE_FUNCTION,
          EntityType.CODE_CLASS,
          EntityType.TASK,
          EntityType.DECISION,
          EntityType.FACT,
        ],
        targetTypes: [
          EntityType.CODE_FILE,
          EntityType.CODE_FUNCTION,
          EntityType.CODE_CLASS,
          EntityType.CONCEPT,
          EntityType.PERSON,
          EntityType.ORGANIZATION,
        ],
        patterns: [
          /\breferences?\b/gi,
          /\brefers?\s+to\b/gi,
          /\bmentions?\b/gi,
          /\bcites?\b/gi,
          /\bpoints?\s+to\b/gi,
          /\bsee\s+also\b/gi,
        ],
        weight: 0.6,
      },
    ],
  ],

  // CAUSES: Causal relationships
  [
    RelationshipType.CAUSES,
    [
      // Errors caused by decisions/tasks/code
      {
        sourceTypes: [EntityType.DECISION, EntityType.TASK, EntityType.CODE_FILE, EntityType.CODE_FUNCTION],
        targetTypes: [EntityType.ERROR],
        patterns: [
          /\bcauses?\b/gi,
          /\bresults?\s+in\b/gi,
          /\bleads?\s+to\b/gi,
          /\btriggers?\b/gi,
          /\bproduces?\b/gi,
        ],
        weight: 0.8,
      },
      // Events causing other events/tasks
      {
        sourceTypes: [EntityType.EVENT, EntityType.DECISION],
        targetTypes: [EntityType.TASK, EntityType.EVENT, EntityType.DECISION],
        patterns: [
          /\bcauses?\b/gi,
          /\bresults?\s+in\b/gi,
          /\bleads?\s+to\b/gi,
          /\btriggers?\b/gi,
          /\bmotivates?\b/gi,
        ],
        weight: 0.7,
      },
    ],
  ],

  // BLOCKS: Blocking relationships
  [
    RelationshipType.BLOCKS,
    [
      // Tasks blocking other tasks
      {
        sourceTypes: [EntityType.TASK, EntityType.ERROR],
        targetTypes: [EntityType.TASK],
        patterns: [
          /\bblocks?\b/gi,
          /\bprevents?\b/gi,
          /\bimpedes?\b/gi,
          /\bhinders?\b/gi,
          /\bholds?\s+up\b/gi,
          /\bblocking\b/gi,
          /\bblocked\s+by\b/gi,
        ],
        weight: 0.85,
      },
      // Errors blocking tasks
      {
        sourceTypes: [EntityType.ERROR],
        targetTypes: [EntityType.TASK, EntityType.CODE_FILE, EntityType.CODE_FUNCTION],
        patterns: [
          /\bblocks?\b/gi,
          /\bprevents?\b/gi,
          /\bstops?\b/gi,
          /\bbreaks?\b/gi,
        ],
        weight: 0.8,
      },
    ],
  ],

  // RELATED_TO: General semantic relationship (fallback)
  [
    RelationshipType.RELATED_TO,
    [
      {
        sourceTypes: Object.values(EntityType) as EntityType[],
        targetTypes: Object.values(EntityType) as EntityType[],
        patterns: [
          /\brelated\s+to\b/gi,
          /\bassociated\s+with\b/gi,
          /\bconnected\s+to\b/gi,
          /\blinked\s+to\b/gi,
          /\bcorresponds?\s+to\b/gi,
        ],
        weight: 0.5,
      },
    ],
  ],

  // CONTAINS: Containment relationships
  [
    RelationshipType.CONTAINS,
    [
      {
        sourceTypes: [EntityType.CODE_FILE, EntityType.CODE_CLASS],
        targetTypes: [EntityType.CODE_FUNCTION, EntityType.CODE_CLASS],
        patterns: [
          /\bcontains?\b/gi,
          /\bincludes?\b/gi,
          /\bhas\b/gi,
          /\bcomprises?\b/gi,
          /\bdefines?\b/gi,
        ],
        weight: 0.75,
      },
    ],
  ],

  // FOLLOWS: Temporal or logical ordering
  [
    RelationshipType.FOLLOWS,
    [
      {
        sourceTypes: [EntityType.TASK, EntityType.EVENT, EntityType.DECISION],
        targetTypes: [EntityType.TASK, EntityType.EVENT, EntityType.DECISION],
        patterns: [
          /\bfollows?\b/gi,
          /\bafter\b/gi,
          /\bthen\b/gi,
          /\bsubsequent(?:ly)?\b/gi,
          /\bnext\b/gi,
        ],
        weight: 0.65,
      },
    ],
  ],

  // DERIVED_FROM: Derivation relationships
  [
    RelationshipType.DERIVED_FROM,
    [
      {
        sourceTypes: [
          EntityType.CODE_CLASS,
          EntityType.CODE_FILE,
          EntityType.CONCEPT,
          EntityType.DECISION,
        ],
        targetTypes: [
          EntityType.CODE_CLASS,
          EntityType.CODE_FILE,
          EntityType.CONCEPT,
          EntityType.DECISION,
        ],
        patterns: [
          /\bderived\s+from\b/gi,
          /\bbased\s+on\b/gi,
          /\boriginated\s+from\b/gi,
          /\bevolved\s+from\b/gi,
          /\bextracted\s+from\b/gi,
        ],
        weight: 0.7,
      },
    ],
  ],
]);

// ============================================================================
// RelationshipInferencer Class
// ============================================================================

/**
 * Rule-based relationship inferencer that identifies relationships between entities
 * using configurable pattern-based rules.
 *
 * @example
 * ```typescript
 * const inferencer = new RelationshipInferencer();
 * const result = inferencer.infer(entities, "UserService depends on DatabaseClient");
 * // result.relationships contains DEPENDS_ON relationship
 * ```
 */
export class RelationshipInferencer {
  private config: RelationshipInferencerConfig;

  /**
   * Creates a new RelationshipInferencer with optional configuration.
   *
   * @param config - Partial configuration to override defaults
   */
  constructor(config?: Partial<RelationshipInferencerConfig>) {
    this.config = {
      minConfidence: config?.minConfidence ?? 0.5,
      maxRelationshipsPerPair: config?.maxRelationshipsPerPair ?? 3,
      inferenceRules: config?.inferenceRules ?? new Map(DEFAULT_INFERENCE_RULES),
    };
  }

  /**
   * Infers relationships between all entity pairs based on context.
   *
   * @param entities - Array of entities to find relationships between
   * @param context - Text context to analyze for relationship indicators
   * @returns RelationshipInferResult with inferred relationships and confidence
   */
  infer(entities: Entity[], context: string): RelationshipInferResult {
    if (!entities || entities.length < 2 || !context || context.trim().length === 0) {
      return { relationships: [], confidence: 0 };
    }

    const allRelationships: Relationship[] = [];

    // Check all unique entity pairs
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const source = entities[i] as Entity;
        const target = entities[j] as Entity;

        // Try both directions (source -> target and target -> source)
        const forwardRelationships = this.inferFromPair(source, target, context);
        const reverseRelationships = this.inferFromPair(target, source, context);

        allRelationships.push(...forwardRelationships, ...reverseRelationships);
      }
    }

    // Filter by minimum confidence
    const filteredRelationships = allRelationships.filter(
      (r) => r.weight >= this.config.minConfidence
    );

    // Deduplicate relationships
    const uniqueRelationships = this.deduplicateRelationships(filteredRelationships);

    // Calculate overall confidence
    const confidence = this.calculateOverallConfidence(
      uniqueRelationships,
      entities.length
    );

    return {
      relationships: uniqueRelationships,
      confidence,
    };
  }

  /**
   * Infers relationships between a specific entity pair.
   *
   * @param source - Source entity
   * @param target - Target entity
   * @param context - Text context to analyze
   * @returns Array of inferred relationships
   */
  inferFromPair(source: Entity, target: Entity, context: string): Relationship[] {
    const relationships: Relationship[] = [];
    const now = new Date();
    const pairRelationships: Map<RelationshipType, Relationship> = new Map();

    // Check each relationship type
    for (const [relType, rules] of this.config.inferenceRules) {
      for (const rule of rules) {
        // Check if entity types match the rule constraints
        if (
          !rule.sourceTypes.includes(source.type) ||
          !rule.targetTypes.includes(target.type)
        ) {
          continue;
        }

        // Check for pattern matches
        const matchScore = this.matchRule(source, target, context, rule);

        if (matchScore > 0) {
          const weight = this.calculateRelationshipWeight(matchScore, rule.weight);

          // Only keep the highest-weight relationship of each type
          const existing = pairRelationships.get(relType);
          if (!existing || weight > existing.weight) {
            pairRelationships.set(relType, {
              id: randomUUID(),
              type: relType,
              sourceId: source.id,
              targetId: target.id,
              properties: {
                inferredFrom: "pattern-matching",
                matchScore,
                ruleWeight: rule.weight,
                sourceType: source.type,
                targetType: target.type,
                sourceName: source.name,
                targetName: target.name,
              },
              weight,
              createdAt: now,
              updatedAt: now,
              eventTime: now,
              ingestionTime: now,
            });
          }
        }
      }
    }

    // Convert to array and limit per pair
    relationships.push(...Array.from(pairRelationships.values()));

    // Sort by weight and limit
    relationships.sort((a, b) => b.weight - a.weight);
    return relationships.slice(0, this.config.maxRelationshipsPerPair);
  }

  /**
   * Matches a rule against the context and entity names.
   *
   * @param source - Source entity
   * @param target - Target entity
   * @param context - Text context to analyze
   * @param rule - The inference rule to match
   * @returns Match score (0-1)
   */
  private matchRule(
    source: Entity,
    target: Entity,
    context: string,
    rule: InferenceRule
  ): number {
    let matchCount = 0;
    let totalPatterns = rule.patterns.length;

    // Check if both entity names appear in context
    const sourceLower = source.name.toLowerCase();
    const targetLower = target.name.toLowerCase();
    const contextLower = context.toLowerCase();

    const sourceInContext = contextLower.includes(sourceLower);
    const targetInContext = contextLower.includes(targetLower);

    // If neither entity is mentioned in context, no relationship can be inferred
    if (!sourceInContext && !targetInContext) {
      return 0;
    }

    // Bonus for both entities being in context
    const proximityBonus = sourceInContext && targetInContext ? 0.2 : 0;

    // Check pattern matches
    for (const pattern of rule.patterns) {
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;

      if (pattern.test(context)) {
        matchCount++;
      }
    }

    if (matchCount === 0) {
      return 0;
    }

    // Calculate base score from pattern matches
    const patternScore = matchCount / totalPatterns;

    // Combine scores (pattern match ratio + proximity bonus)
    return Math.min(1, patternScore + proximityBonus);
  }

  /**
   * Calculates the final relationship weight.
   *
   * @param matchScore - Score from pattern matching (0-1)
   * @param ruleWeight - Weight of the rule (0-1)
   * @returns Final relationship weight (0-1)
   */
  private calculateRelationshipWeight(matchScore: number, ruleWeight: number): number {
    // Combine match score and rule weight
    // Weight formula: 60% from match score, 40% from rule weight
    const combinedWeight = matchScore * 0.6 + ruleWeight * 0.4;
    
    // Apply a minimum floor and cap at 1
    return Math.max(0.3, Math.min(1, combinedWeight));
  }

  /**
   * Calculates overall confidence for the inference result.
   *
   * @param relationships - Inferred relationships
   * @param entityCount - Number of input entities
   * @returns Overall confidence score (0-1)
   */
  private calculateOverallConfidence(
    relationships: Relationship[],
    entityCount: number
  ): number {
    if (relationships.length === 0 || entityCount < 2) {
      return 0;
    }

    // Expected relationships roughly: n*(n-1)/2 for n entities (but not all will have relationships)
    // We expect maybe 20-30% of pairs to have relationships
    const maxPairs = (entityCount * (entityCount - 1)) / 2;
    const expectedRelationships = maxPairs * 0.25;

    // Calculate based on number and quality of relationships
    const quantityScore = Math.min(1, relationships.length / expectedRelationships);
    const qualityScore =
      relationships.reduce((sum, r) => sum + r.weight, 0) / relationships.length;

    // Combine quantity and quality (weighted)
    return Math.min(0.95, quantityScore * 0.4 + qualityScore * 0.6);
  }

  /**
   * Deduplicates relationships by source, target, and type.
   *
   * @param relationships - Array of relationships to deduplicate
   * @returns Deduplicated array of relationships
   */
  private deduplicateRelationships(relationships: Relationship[]): Relationship[] {
    const seen = new Map<string, Relationship>();

    for (const rel of relationships) {
      const key = `${rel.sourceId}:${rel.targetId}:${rel.type}`;
      const existing = seen.get(key);

      if (!existing || rel.weight > existing.weight) {
        seen.set(key, rel);
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Gets the current configuration.
   *
   * @returns Current RelationshipInferencerConfig
   */
  getConfig(): RelationshipInferencerConfig {
    return {
      ...this.config,
      inferenceRules: new Map(this.config.inferenceRules),
    };
  }

  /**
   * Adds custom rules for a relationship type.
   *
   * @param type - The relationship type
   * @param rules - Additional rules to add
   */
  addRules(type: RelationshipType, rules: InferenceRule[]): void {
    const existing = this.config.inferenceRules.get(type) ?? [];
    this.config.inferenceRules.set(type, [...existing, ...rules]);
  }

  /**
   * Sets the minimum confidence threshold.
   *
   * @param minConfidence - New minimum confidence (0-1)
   */
  setMinConfidence(minConfidence: number): void {
    this.config.minConfidence = Math.max(0, Math.min(1, minConfidence));
  }

  /**
   * Sets the maximum relationships per pair.
   *
   * @param max - Maximum relationships per entity pair
   */
  setMaxRelationshipsPerPair(max: number): void {
    this.config.maxRelationshipsPerPair = Math.max(1, max);
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Creates a new RelationshipInferencer with default configuration.
 *
 * @returns RelationshipInferencer instance
 */
export function createRelationshipInferencer(): RelationshipInferencer {
  return new RelationshipInferencer();
}

/**
 * Creates a RelationshipInferencer with custom configuration.
 *
 * @param config - Configuration options
 * @returns RelationshipInferencer instance
 */
export function createRelationshipInferencerWithConfig(
  config: Partial<RelationshipInferencerConfig>
): RelationshipInferencer {
  return new RelationshipInferencer(config);
}

// Export default rules for testing/extension
export { DEFAULT_INFERENCE_RULES };
