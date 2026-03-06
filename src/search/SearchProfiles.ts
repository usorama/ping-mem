/**
 * Search Profiles for ping-mem Hybrid Search
 *
 * Defines pre-configured weight profiles for different search use cases
 * and a heuristic query classifier to auto-select the best profile.
 *
 * @module search/SearchProfiles
 * @version 1.0.0
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Weight configuration for a search profile
 */
export interface SearchProfileWeights {
  /** Weight for semantic/embedding search */
  semantic: number;
  /** Weight for keyword/BM25 search */
  keyword: number;
  /** Weight for graph-based search */
  graph: number;
  /** Weight for code-specific search (optional) */
  code?: number;
  /** Weight for causal search (optional) */
  causal?: number;
}

/**
 * A named search profile with weights and description
 */
export type SearchProfile = {
  /** Profile identifier */
  name: string;
  /** Human-readable description of when to use this profile */
  description: string;
  /** Weight distribution across search modes */
  weights: SearchProfileWeights;
};

// ============================================================================
// Profile Definitions
// ============================================================================

/**
 * Pre-configured search profiles for common use cases.
 *
 * Each profile distributes weights across search modes to optimize
 * for a specific type of query.
 */
export const SEARCH_PROFILES: Map<string, SearchProfile> = new Map([
  [
    "general",
    {
      name: "general",
      description: "Balanced search for general-purpose queries",
      weights: { semantic: 0.5, keyword: 0.3, graph: 0.2 },
    },
  ],
  [
    "code_search",
    {
      name: "code_search",
      description: "Optimized for finding code: functions, classes, imports, variables",
      weights: { semantic: 0.2, keyword: 0.2, graph: 0.1, code: 0.5 },
    },
  ],
  [
    "decision_recall",
    {
      name: "decision_recall",
      description: "Recall past decisions and their rationale with causal context",
      weights: { semantic: 0.4, keyword: 0.2, graph: 0.3, causal: 0.1 },
    },
  ],
  [
    "error_investigation",
    {
      name: "error_investigation",
      description: "Investigate errors, exceptions, and failures with causal tracing",
      weights: { semantic: 0.3, keyword: 0.2, graph: 0.2, causal: 0.3 },
    },
  ],
  [
    "temporal",
    {
      name: "temporal",
      description: "Time-aware search relying on temporal boost for recency",
      weights: { semantic: 0.4, keyword: 0.4, graph: 0.2 },
    },
  ],
]);

// ============================================================================
// Keyword Sets for Profile Detection
// ============================================================================

const CODE_KEYWORDS = new Set([
  "function",
  "class",
  "import",
  "variable",
  "module",
  "type",
  "interface",
]);

const DECISION_KEYWORDS = new Set([
  "decided",
  "decision",
  "chose",
  "choice",
  "why",
]);

const ERROR_KEYWORDS = new Set([
  "error",
  "exception",
  "crash",
  "fail",
  "broken",
  "issue",
]);

const TEMPORAL_KEYWORDS = new Set([
  "recent",
  "latest",
  "today",
  "yesterday",
  "last week",
]);

// ============================================================================
// Profile Detection
// ============================================================================

/**
 * Detect the best search profile for a query using keyword heuristics.
 *
 * Priority order (first match wins):
 * 1. code_search — code-related keywords
 * 2. decision_recall — decision-related keywords
 * 3. error_investigation — error-related keywords
 * 4. temporal — time-related keywords
 * 5. general — default fallback
 *
 * @param query - The search query text
 * @returns The profile name to use
 */
export function detectProfile(query: string): string {
  const lowerQuery = query.toLowerCase();
  // Split into word tokens, stripping punctuation so "today?" becomes "today"
  const queryTokens = new Set(
    lowerQuery.split(/\s+/).map((t) => t.replace(/[^\w]/g, "")).filter((t) => t.length > 0)
  );

  // Helper: check if any keyword matches a query token exactly
  const matchesKeyword = (keywords: Set<string>): boolean =>
    Array.from(keywords).some((k) => queryTokens.has(k));

  // Check for code keywords
  if (matchesKeyword(CODE_KEYWORDS)) {
    return "code_search";
  }

  // Check for decision keywords
  if (matchesKeyword(DECISION_KEYWORDS)) {
    return "decision_recall";
  }

  // Check for error keywords
  if (matchesKeyword(ERROR_KEYWORDS)) {
    return "error_investigation";
  }

  // Check for temporal keywords (includes multi-word like "last week" — check via includes fallback)
  if (matchesKeyword(TEMPORAL_KEYWORDS) || lowerQuery.includes("last week")) {
    return "temporal";
  }

  return "general";
}
