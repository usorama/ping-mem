/**
 * Causal Discovery Agent for LLM-based causal relationship extraction
 *
 * Uses an LLM to extract cause-effect relationships from text content,
 * with optional persistence to the knowledge graph via CausalGraphManager.
 *
 * @module graph/CausalDiscoveryAgent
 * @version 1.0.0
 */

import type { CausalGraphManager } from "./CausalGraphManager.js";
import type { GraphManager } from "./GraphManager.js";

// ============================================================================
// Types
// ============================================================================

/**
 * OpenAI-compatible client shape for chat completions
 */
interface OpenAIClientShape {
  chat: {
    completions: {
      create: (params: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        response_format: { type: string };
        temperature: number;
      }) => Promise<{
        choices: Array<{
          message: {
            content: string | null;
          };
        }>;
      }>;
    };
  };
}

/**
 * Configuration for CausalDiscoveryAgent
 */
export interface CausalDiscoveryConfig {
  openai: OpenAIClientShape;
  causalGraphManager: CausalGraphManager;
  graphManager: GraphManager;
  model?: string; // default: "gpt-4o-mini"
  confidenceThreshold?: number; // default: 0.7
}

/**
 * A causal link discovered by the LLM
 */
export interface DiscoveredCausalLink {
  causeName: string;
  effectName: string;
  confidence: number;
  evidence: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Default LLM model for causal extraction */
const DEFAULT_MODEL = "gpt-4o-mini";

/** Default confidence threshold for filtering results */
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/** System prompt for causal relationship extraction */
const CAUSAL_EXTRACTION_PROMPT = `You are a causal relationship extractor. Given text, identify cause-effect relationships.
Return JSON: { "causal_links": [{ "cause": "entity name", "effect": "entity name", "confidence": 0.0-1.0, "evidence": "brief explanation" }] }
Only include relationships where the causal direction is clear. Set confidence based on how explicitly the causation is stated.`;

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Expected JSON structure from LLM response
 */
interface LLMCausalResponse {
  causal_links: Array<{
    cause: string;
    effect: string;
    confidence: number;
    evidence: string;
  }>;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Agent that uses LLM to discover causal relationships from text.
 *
 * @example
 * ```typescript
 * const agent = new CausalDiscoveryAgent({
 *   openai: openaiClient,
 *   causalGraphManager: causalManager,
 *   graphManager: graphManager,
 * });
 *
 * const links = await agent.discover(
 *   "The database migration caused the auth service to fail, which led to user login errors."
 * );
 * // Returns: [{ causeName: "database migration", effectName: "auth service failure", ... }]
 * ```
 */
export class CausalDiscoveryAgent {
  private readonly openai: OpenAIClientShape;
  private readonly causalGraphManager: CausalGraphManager;
  private readonly graphManager: GraphManager;
  private readonly model: string;
  private readonly confidenceThreshold: number;

  constructor(config: CausalDiscoveryConfig) {
    this.openai = config.openai;
    this.causalGraphManager = config.causalGraphManager;
    this.graphManager = config.graphManager;
    this.model = config.model ?? DEFAULT_MODEL;
    this.confidenceThreshold =
      config.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  }

  /**
   * Discover causal relationships from text content using LLM.
   *
   * Sends the text to the LLM with a causal extraction prompt,
   * parses the JSON response, and filters by confidence threshold.
   *
   * @param text - Text to analyze for causal relationships
   * @returns Array of discovered causal links above the confidence threshold
   */
  async discover(text: string): Promise<DiscoveredCausalLink[]> {
    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: CAUSAL_EXTRACTION_PROMPT },
          { role: "user", content: text },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return [];
      }

      const parsed = this.parseResponse(content);
      if (!parsed) {
        return [];
      }

      // Filter by confidence threshold and map to output type
      return parsed.causal_links
        .filter((link) => link.confidence >= this.confidenceThreshold)
        .map((link) => ({
          causeName: link.cause,
          effectName: link.effect,
          confidence: link.confidence,
          evidence: link.evidence,
        }));
    } catch (error) {
      console.warn("[CausalDiscoveryAgent] Discovery failed:", error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  /**
   * Discover causal links from text and return count.
   *
   * Calls discover() to extract causal links via LLM, then returns
   * the count of discovered links. Does not persist — actual persistence
   * requires entity resolution (mapping names to IDs), which is not yet
   * implemented.
   *
   * @param text - Text to analyze for causal relationships
   * @returns Count of discovered causal links
   */
  async discoverCount(text: string): Promise<number> {
    const links = await this.discover(text);
    return links.length;
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Parse and validate the LLM JSON response
   */
  private parseResponse(content: string): LLMCausalResponse | null {
    try {
      const parsed: unknown = JSON.parse(content);

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("causal_links" in parsed)
      ) {
        return null;
      }

      const response = parsed as LLMCausalResponse;

      if (!Array.isArray(response.causal_links)) {
        return null;
      }

      // Validate each link has required fields
      const validLinks = response.causal_links.filter(
        (link) =>
          typeof link.cause === "string" &&
          typeof link.effect === "string" &&
          typeof link.confidence === "number" &&
          typeof link.evidence === "string",
      );

      return { causal_links: validLinks };
    } catch {
      return null;
    }
  }
}
