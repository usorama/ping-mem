/**
 * Rule-based Entity Extractor for ping-mem Graphiti Integration
 *
 * Extracts entities from text and context using configurable regex patterns.
 * Supports multiple entity types including persons, organizations, code elements,
 * decisions, tasks, and errors.
 *
 * @module graph/EntityExtractor
 * @version 1.0.0
 */

import { EntityType, Entity, EntityExtractResult } from "../types/graph.js";
import { randomUUID } from "crypto";

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for the EntityExtractor.
 */
export interface EntityExtractorConfig {
  /** Pattern map from entity type to regex patterns */
  patterns: Map<EntityType, RegExp[]>;
  /** Minimum confidence threshold for entity inclusion (0-1) */
  minConfidence: number;
}

/**
 * Context object for extracting entities from structured data.
 */
export interface ExtractionContext {
  /** Key or field name */
  key: string;
  /** Value to extract entities from */
  value: string;
  /** Optional category hint for extraction */
  category?: string;
}

// ============================================================================
// Default Patterns
// ============================================================================

/**
 * Default regex patterns for each entity type.
 * These patterns are designed for high precision with reasonable recall.
 */
const DEFAULT_PATTERNS: Map<EntityType, RegExp[]> = new Map([
  // PERSON: Names with honorifics or capitalized proper names
  [
    EntityType.PERSON,
    [
      // Honorific patterns (Dr., Mr., Mrs., Ms., Prof., etc.)
      /\b(?:Dr|Mr|Mrs|Ms|Miss|Prof|Professor)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g,
      // Full names (First Last or First Middle Last)
      /\b([A-Z][a-z]+)\s+([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?\b(?=\s+(?:said|wrote|created|developed|implemented|designed|built|reported|mentioned|suggested|recommended|asked|answered|fixed|reviewed))/g,
      // Names with possessive or action context
      /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)'s\b/g,
      // @mention style (common in comments)
      /@([A-Za-z][A-Za-z0-9_-]+)/g,
    ],
  ],

  // ORGANIZATION: Company and org patterns
  [
    EntityType.ORGANIZATION,
    [
      // Company suffixes (non-greedy, max 3 words before suffix)
      /\b([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){0,2})\s+(?:Inc|LLC|Ltd|Corp|Corporation|Company|Co|GmbH|AG|SA|Pty|PLC)\b\.?/gi,
      // "at/by/from Organization" patterns
      /\b(?:at|by|from|with|for)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)\b(?=\s+(?:team|company|organization|group|department))/gi,
      // Tech company names (common ones)
      /\b(Google|Microsoft|Apple|Amazon|Meta|Facebook|Netflix|Anthropic|OpenAI|GitHub|GitLab|Vercel|Cloudflare|AWS|Azure|IBM|Oracle|Salesforce)\b/g,
      // "The X Team/Group/Company" pattern
      /\bthe\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)\s+(?:team|group|company|organization)\b/gi,
    ],
  ],

  // CODE_FILE: File path patterns
  [
    EntityType.CODE_FILE,
    [
      // Standard file extensions
      /\b([a-zA-Z0-9_\-./]+\.(?:ts|tsx|js|jsx|py|rb|go|rs|java|kt|swift|c|cpp|h|hpp|cs|php|vue|svelte|astro|md|json|yaml|yml|toml|xml|html|css|scss|sass|less))\b/g,
      // Paths starting with src/, lib/, packages/, etc.
      /\b((?:src|lib|packages|apps|modules|components|utils|helpers|services|hooks|stores|types|interfaces|models|controllers|views|routes|api|tests?|__tests__|spec)\/[a-zA-Z0-9_\-./]+)\b/g,
      // Relative paths with ./ or ../
      /\b(\.\.?\/[a-zA-Z0-9_\-./]+(?:\.[a-zA-Z]+)?)\b/g,
      // Index files
      /\b(index\.(?:ts|tsx|js|jsx))\b/g,
    ],
  ],

  // CODE_FUNCTION: Function name patterns
  [
    EntityType.CODE_FUNCTION,
    [
      // Function calls with parentheses
      /\b([a-z][a-zA-Z0-9_]*)\s*\([^)]*\)/g,
      // async function declarations
      /\basync\s+function\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
      // function keyword declarations
      /\bfunction\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
      // Arrow function assignments
      /\b(const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
      // Method references with dot notation
      /\.([a-z][a-zA-Z0-9_]*)\s*\(/g,
      // Use/hook patterns (common in React)
      /\b(use[A-Z][a-zA-Z0-9]*)\b/g,
    ],
  ],

  // DECISION: Decision language patterns
  [
    EntityType.DECISION,
    [
      // "decided to X" patterns
      /\b(?:decided|chosen|selected|opted)\s+(?:to\s+)?([^.!?\n]+)/gi,
      // "the decision to X" patterns
      /\b(?:the\s+)?decision\s+(?:to|was|is)\s+([^.!?\n]+)/gi,
      // "we will/should/must X" patterns
      /\b(?:we|they|i)\s+(?:will|should|must|shall)\s+([^.!?\n]+)/gi,
      // "going with X" patterns
      /\bgoing\s+(?:with|for)\s+([^.!?\n]+)/gi,
      // "chose X over Y" patterns
      /\bchose\s+([^.!?\n]+?)\s+over\b/gi,
    ],
  ],

  // TASK: Task and todo patterns
  [
    EntityType.TASK,
    [
      // TODO/FIXME/HACK/NOTE comments
      /\b(?:TODO|FIXME|HACK|XXX|BUG|NOTE):\s*([^\n]+)/g,
      // "need to X" patterns
      /\bneed\s+to\s+([^.!?\n]+)/gi,
      // "implement X" patterns
      /\b(?:implement|add|create|build|fix|update|refactor|remove|delete)\s+([^.!?\n]+)/gi,
      // Task with action verbs at start
      /^[-*]\s*\[[ x]?\]\s*(.+)$/gim,
      // "should X" patterns
      /\bshould\s+(?:be\s+)?([^.!?\n]+)/gi,
    ],
  ],

  // ERROR: Error and exception patterns
  [
    EntityType.ERROR,
    [
      // Error: message patterns
      /\b(?:Error|error|ERROR):\s*([^\n]+)/g,
      // Exception patterns
      /\b([A-Z][a-zA-Z]*(?:Error|Exception|Fault))\b/g,
      // "failed to X" patterns
      /\bfailed\s+to\s+([^.!?\n]+)/gi,
      // Stack trace file:line patterns
      /\bat\s+([a-zA-Z0-9_<>$.]+)\s*\(([^)]+):(\d+):(\d+)\)/g,
      // "threw X" patterns
      /\bthrew\s+(?:an?\s+)?([A-Z][a-zA-Z]*(?:Error|Exception)?)/gi,
      // Cannot/Could not patterns
      /\b(?:cannot|could\s+not|couldn't)\s+([^.!?\n]+)/gi,
    ],
  ],

  // CONCEPT: Abstract ideas and concepts (basic patterns)
  [
    EntityType.CONCEPT,
    [
      // "the concept of X" patterns
      /\bthe\s+concept\s+of\s+([^.!?\n]+)/gi,
      // "X pattern/principle/approach" patterns
      /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\s+(?:pattern|principle|approach|methodology|architecture|paradigm)\b/gi,
    ],
  ],

  // CODE_CLASS: Class and type patterns
  [
    EntityType.CODE_CLASS,
    [
      // class declarations
      /\bclass\s+([A-Z][a-zA-Z0-9_]*)/g,
      // interface declarations
      /\binterface\s+([A-Z][a-zA-Z0-9_]*)/g,
      // type declarations
      /\btype\s+([A-Z][a-zA-Z0-9_]*)\s*=/g,
      // extends/implements
      /\b(?:extends|implements)\s+([A-Z][a-zA-Z0-9_]*)/g,
      // PascalCase with Type/Interface/Class suffix
      /\b([A-Z][a-zA-Z0-9]*(?:Type|Interface|Class|Props|State|Config|Options))\b/g,
    ],
  ],
]);

// ============================================================================
// EntityExtractor Class
// ============================================================================

/**
 * Rule-based entity extractor that identifies entities in text using regex patterns.
 *
 * @example
 * ```typescript
 * const extractor = new EntityExtractor();
 * const result = extractor.extract("Dr. Smith created the UserService class");
 * // result.entities contains PERSON and CODE_CLASS entities
 * ```
 */
export class EntityExtractor {
  private config: EntityExtractorConfig;

  /**
   * Creates a new EntityExtractor with optional configuration.
   *
   * @param config - Partial configuration to override defaults
   */
  constructor(config?: Partial<EntityExtractorConfig>) {
    this.config = {
      patterns: config?.patterns ?? new Map(DEFAULT_PATTERNS),
      minConfidence: config?.minConfidence ?? 0.5,
    };
  }

  /**
   * Extracts entities from plain text.
   *
   * @param text - The text to extract entities from
   * @returns EntityExtractResult with entities and confidence score
   */
  extract(text: string): EntityExtractResult {
    if (!text || text.trim().length === 0) {
      return { entities: [], confidence: 0 };
    }

    const allEntities: Entity[] = [];

    // Extract entities for each configured type
    for (const [entityType, patterns] of this.config.patterns) {
      const entities = this.extractEntitiesOfType(text, entityType, patterns);
      allEntities.push(...entities);
    }

    // Deduplicate entities by name and type
    const uniqueEntities = this.deduplicateEntities(allEntities);

    // Calculate overall confidence
    const confidence = this.calculateOverallConfidence(
      uniqueEntities.length,
      text.length
    );

    // Filter by minimum confidence and sort by confidence
    const filteredEntities = uniqueEntities.filter((entity) => {
      const entityConfidence =
        (entity.properties["confidence"] as number) ?? 0;
      return entityConfidence >= this.config.minConfidence;
    });

    return {
      entities: filteredEntities,
      confidence,
    };
  }

  /**
   * Extracts entities from a structured context object.
   * Uses the key and category hints to improve extraction accuracy.
   *
   * @param context - The context object containing key, value, and optional category
   * @returns EntityExtractResult with entities and confidence score
   */
  extractFromContext(context: ExtractionContext): EntityExtractResult {
    const { key, value, category } = context;

    if (!value || value.trim().length === 0) {
      return { entities: [], confidence: 0 };
    }

    // Determine which entity types to prioritize based on key/category
    const prioritizedTypes = this.getPrioritizedTypes(key, category);

    const allEntities: Entity[] = [];

    // First, extract prioritized types
    for (const entityType of prioritizedTypes) {
      const patterns = this.config.patterns.get(entityType);
      if (patterns) {
        const entities = this.extractEntitiesOfType(value, entityType, patterns);
        // Boost confidence for prioritized types
        entities.forEach((e) => {
          const currentConf = (e.properties["confidence"] as number) ?? 0.5;
          e.properties["confidence"] = Math.min(1, currentConf * 1.2);
          e.properties["contextKey"] = key;
          if (category) {
            e.properties["contextCategory"] = category;
          }
        });
        allEntities.push(...entities);
      }
    }

    // Then extract other types
    for (const [entityType, patterns] of this.config.patterns) {
      if (!prioritizedTypes.includes(entityType)) {
        const entities = this.extractEntitiesOfType(value, entityType, patterns);
        entities.forEach((e) => {
          e.properties["contextKey"] = key;
          if (category) {
            e.properties["contextCategory"] = category;
          }
        });
        allEntities.push(...entities);
      }
    }

    // Deduplicate and filter
    const uniqueEntities = this.deduplicateEntities(allEntities);
    const confidence = this.calculateOverallConfidence(
      uniqueEntities.length,
      value.length
    );

    const filteredEntities = uniqueEntities.filter((entity) => {
      const entityConfidence =
        (entity.properties["confidence"] as number) ?? 0;
      return entityConfidence >= this.config.minConfidence;
    });

    return {
      entities: filteredEntities,
      confidence,
    };
  }

  /**
   * Extracts entities of a specific type from text using provided patterns.
   *
   * @param text - The text to extract from
   * @param type - The entity type to extract
   * @param patterns - Array of regex patterns to use
   * @returns Array of extracted entities
   */
  private extractEntitiesOfType(
    text: string,
    type: EntityType,
    patterns: RegExp[]
  ): Entity[] {
    const entities: Entity[] = [];
    const seenNames = new Set<string>();
    const now = new Date();

    for (const pattern of patterns) {
      // Reset regex lastIndex for global patterns
      pattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        // Get the captured group (first non-undefined group after full match)
        // Fall back to full match if no capturing groups
        let name = "";
        for (let i = 1; i < match.length; i++) {
          const group = match[i];
          if (group !== undefined) {
            name = group.trim();
            break;
          }
        }

        // If no capturing group found, use the full match
        if (!name && match[0]) {
          name = match[0].trim();
        }

        // Skip empty names or very short names
        if (!name || name.length < 2) {
          continue;
        }

        // Skip common words that might match patterns
        if (this.isCommonWord(name, type)) {
          continue;
        }

        // Normalize the name
        const normalizedName = this.normalizeName(name, type);

        // Skip duplicates within this extraction
        const dedupeKey = type + ":" + normalizedName.toLowerCase();
        if (seenNames.has(dedupeKey)) {
          continue;
        }
        seenNames.add(dedupeKey);

        const confidence = this.calculateConfidence(1, patterns.length);

        entities.push({
          id: randomUUID(),
          type,
          name: normalizedName,
          properties: {
            confidence,
            matchedPattern: pattern.source,
            originalMatch: match[0],
          },
          createdAt: now,
          updatedAt: now,
          eventTime: now,
          ingestionTime: now,
        });
      }
    }

    return entities;
  }

  /**
   * Calculates confidence score based on match ratio.
   *
   * @param matches - Number of matches
   * @param totalPatterns - Total number of patterns attempted
   * @returns Confidence score (0-1)
   */
  private calculateConfidence(matches: number, totalPatterns: number): number {
    if (totalPatterns === 0) return 0;

    // Base confidence from match ratio
    const baseConfidence = Math.min(1, matches / totalPatterns);

    // Apply a minimum floor and scale
    return Math.max(0.3, Math.min(1, baseConfidence + 0.5));
  }

  /**
   * Calculates overall confidence for the extraction result.
   *
   * @param entityCount - Number of entities extracted
   * @param textLength - Length of input text
   * @returns Overall confidence score (0-1)
   */
  private calculateOverallConfidence(
    entityCount: number,
    textLength: number
  ): number {
    if (textLength === 0 || entityCount === 0) return 0;

    // Expect roughly 1 entity per 100 characters for reasonable confidence
    const expectedEntities = Math.max(1, textLength / 100);
    const ratio = entityCount / expectedEntities;

    // Confidence is higher when we have a reasonable number of entities
    // but not too many (which might indicate false positives)
    if (ratio < 0.5) {
      return ratio * 0.8; // Under-extraction
    } else if (ratio > 3) {
      return Math.max(0.5, 1 - (ratio - 3) * 0.1); // Over-extraction
    } else {
      return Math.min(0.95, 0.6 + ratio * 0.15); // Sweet spot
    }
  }

  /**
   * Deduplicates entities by name and type.
   *
   * @param entities - Array of entities to deduplicate
   * @returns Deduplicated array of entities
   */
  private deduplicateEntities(entities: Entity[]): Entity[] {
    const seen = new Map<string, Entity>();

    for (const entity of entities) {
      const key = entity.type + ":" + entity.name.toLowerCase();
      const existing = seen.get(key);

      if (!existing) {
        seen.set(key, entity);
      } else {
        // Keep the one with higher confidence
        const existingConf =
          (existing.properties["confidence"] as number) ?? 0;
        const newConf = (entity.properties["confidence"] as number) ?? 0;
        if (newConf > existingConf) {
          seen.set(key, entity);
        }
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Determines prioritized entity types based on context key and category.
   *
   * @param key - The context key
   * @param category - Optional category hint
   * @returns Array of prioritized entity types
   */
  private getPrioritizedTypes(
    key: string,
    category?: string
  ): EntityType[] {
    const keyLower = key.toLowerCase();
    const categoryLower = category?.toLowerCase() ?? "";

    const priorities: EntityType[] = [];

    // Key-based prioritization
    if (
      keyLower.includes("author") ||
      keyLower.includes("user") ||
      keyLower.includes("name")
    ) {
      priorities.push(EntityType.PERSON);
    }

    if (
      keyLower.includes("company") ||
      keyLower.includes("org") ||
      keyLower.includes("team")
    ) {
      priorities.push(EntityType.ORGANIZATION);
    }

    if (
      keyLower.includes("file") ||
      keyLower.includes("path") ||
      keyLower.includes("source")
    ) {
      priorities.push(EntityType.CODE_FILE);
    }

    if (
      keyLower.includes("function") ||
      keyLower.includes("method") ||
      keyLower.includes("api")
    ) {
      priorities.push(EntityType.CODE_FUNCTION);
    }

    if (
      keyLower.includes("decision") ||
      keyLower.includes("choice") ||
      keyLower.includes("selected")
    ) {
      priorities.push(EntityType.DECISION);
    }

    if (
      keyLower.includes("task") ||
      keyLower.includes("todo") ||
      keyLower.includes("action")
    ) {
      priorities.push(EntityType.TASK);
    }

    if (
      keyLower.includes("error") ||
      keyLower.includes("exception") ||
      keyLower.includes("bug")
    ) {
      priorities.push(EntityType.ERROR);
    }

    // Category-based prioritization
    if (categoryLower.includes("code") || categoryLower.includes("technical")) {
      if (!priorities.includes(EntityType.CODE_FILE)) {
        priorities.push(EntityType.CODE_FILE);
      }
      if (!priorities.includes(EntityType.CODE_FUNCTION)) {
        priorities.push(EntityType.CODE_FUNCTION);
      }
      if (!priorities.includes(EntityType.CODE_CLASS)) {
        priorities.push(EntityType.CODE_CLASS);
      }
    }

    return priorities;
  }

  /**
   * Checks if a name is a common word that should be filtered out.
   *
   * @param name - The name to check
   * @param type - The entity type
   * @returns True if the name is a common word
   */
  private isCommonWord(name: string, type: EntityType): boolean {
    const commonWords = new Set([
      // General common words
      "the",
      "a",
      "an",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "must",
      "shall",
      "can",
      "this",
      "that",
      "these",
      "those",
      "it",
      "its",
      "of",
      "in",
      "on",
      "at",
      "to",
      "for",
      "with",
      "by",
      "from",
      "as",
      "or",
      "and",
      "but",
      "if",
      "then",
      "else",
      "when",
      "up",
      "out",
      "no",
      "not",
      "all",
      "any",
      "some",
      "such",
      "new",
      "get",
      "set",
      "add",
      "run",
      "put",
    ]);

    // Code-specific common words for functions
    const commonFunctions = new Set([
      "if",
      "for",
      "while",
      "switch",
      "case",
      "return",
      "throw",
      "catch",
      "try",
      "new",
      "typeof",
      "instanceof",
      "import",
      "export",
      "from",
      "as",
      "default",
      "log",
      "warn",
      "error",
      "info",
      "debug",
      "map",
      "filter",
      "reduce",
      "forEach",
      "find",
      "some",
      "every",
      "push",
      "pop",
      "shift",
      "slice",
      "splice",
      "join",
      "split",
      "trim",
      "replace",
      "match",
      "test",
      "exec",
      "toString",
      "valueOf",
      "parse",
      "stringify",
    ]);

    const lowerName = name.toLowerCase();

    if (commonWords.has(lowerName)) {
      return true;
    }

    if (type === EntityType.CODE_FUNCTION && commonFunctions.has(lowerName)) {
      return true;
    }

    // Filter out very short names for certain types
    if (
      (type === EntityType.PERSON || type === EntityType.ORGANIZATION) &&
      name.length < 3
    ) {
      return true;
    }

    return false;
  }

  /**
   * Normalizes an entity name based on its type.
   *
   * @param name - The name to normalize
   * @param type - The entity type
   * @returns Normalized name
   */
  private normalizeName(name: string, type: EntityType): string {
    // Trim whitespace
    let normalized = name.trim();

    // Remove trailing punctuation for most types
    if (type !== EntityType.CODE_FILE) {
      normalized = normalized.replace(/[.,;:!?]+$/, "");
    }

    // Remove leading articles for organizations
    if (type === EntityType.ORGANIZATION) {
      normalized = normalized.replace(/^(?:The|A|An)\s+/i, "");
    }

    // Remove @ prefix for person mentions
    if (type === EntityType.PERSON && normalized.startsWith("@")) {
      normalized = normalized.slice(1);
    }

    return normalized;
  }

  /**
   * Gets the current configuration.
   *
   * @returns Current EntityExtractorConfig
   */
  getConfig(): EntityExtractorConfig {
    return { ...this.config };
  }

  /**
   * Adds custom patterns for an entity type.
   *
   * @param type - The entity type
   * @param patterns - Additional patterns to add
   */
  addPatterns(type: EntityType, patterns: RegExp[]): void {
    const existing = this.config.patterns.get(type) ?? [];
    this.config.patterns.set(type, [...existing, ...patterns]);
  }

  /**
   * Sets the minimum confidence threshold.
   *
   * @param minConfidence - New minimum confidence (0-1)
   */
  setMinConfidence(minConfidence: number): void {
    this.config.minConfidence = Math.max(0, Math.min(1, minConfidence));
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Creates a new EntityExtractor with default configuration.
 *
 * @returns EntityExtractor instance
 */
export function createEntityExtractor(): EntityExtractor {
  return new EntityExtractor();
}

/**
 * Creates an EntityExtractor with custom configuration.
 *
 * @param config - Configuration options
 * @returns EntityExtractor instance
 */
export function createEntityExtractorWithConfig(
  config: Partial<EntityExtractorConfig>
): EntityExtractor {
  return new EntityExtractor(config);
}

// Export default patterns for testing/extension
export { DEFAULT_PATTERNS };
