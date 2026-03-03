/**
 * Hybrid Search Engine for ping-mem
 *
 * Combines semantic (vector), keyword (BM25), and graph-based search
 * using reciprocal rank fusion for optimal result ranking.
 *
 * @module search/HybridSearchEngine
 * @version 1.0.0
 */

import type { EmbeddingService } from "./EmbeddingService.js";
import type { QdrantClientWrapper } from "./QdrantClient.js";
import type { VectorIndex, VectorSearchResult } from "./VectorIndex.js";
import type { GraphManager } from "../graph/GraphManager.js";
import type { MemoryId, SessionId } from "../types/index.js";
import type { BM25Store } from "./BM25Store.js";
import type { MemoryLookup } from "./MemoryLookup.js";
import type { Reranker } from "./Reranker.js";
import { SEARCH_PROFILES, detectProfile } from "./SearchProfiles.js";

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Base error class for hybrid search errors
 */
export class HybridSearchError extends Error {
  public readonly code: string | undefined;
  public override readonly cause: Error | undefined;

  constructor(message: string, code?: string, cause?: Error) {
    super(message);
    this.name = "HybridSearchError";
    this.code = code ?? undefined;
    this.cause = cause ?? undefined;
    Object.setPrototypeOf(this, HybridSearchError.prototype);
  }
}

/**
 * Error thrown when a specific search mode fails
 */
export class SearchModeError extends HybridSearchError {
  public readonly mode: SearchMode;

  constructor(message: string, mode: SearchMode, code?: string, cause?: Error) {
    super(message, code, cause);
    this.name = "SearchModeError";
    this.mode = mode;
    Object.setPrototypeOf(this, SearchModeError.prototype);
  }
}

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Search modes available in hybrid search
 */
export type SearchMode = "semantic" | "keyword" | "graph" | "code" | "causal";

/**
 * Weight configuration for different search modes
 */
export interface SearchWeights {
  /** Weight for semantic search (default: 0.5) */
  semantic: number;
  /** Weight for keyword/BM25 search (default: 0.3) */
  keyword: number;
  /** Weight for graph-based search (default: 0.2) */
  graph: number;
  /** Weight for code-specific search (optional, used by code_search profile) */
  code?: number;
  /** Weight for causal search (optional, used by decision_recall/error_investigation profiles) */
  causal?: number;
}

/**
 * Graph context information for a search result
 */
export interface GraphContext {
  /** Related entity IDs from graph traversal */
  relatedEntityIds: string[];
  /** Relationship types connecting to this result */
  relationshipTypes: string[];
  /** Hop distance from the query entity (if applicable) */
  hopDistance: number;
}

/**
 * Extended search result with hybrid scoring
 */
export interface HybridSearchResult extends VectorSearchResult {
  /** Hybrid score combining all search modes (0-1) */
  hybridScore: number;
  /** Search modes that contributed to this result */
  searchModes: SearchMode[];
  /** Graph context if graph search was used */
  graphContext?: GraphContext;
  /** Individual scores from each search mode */
  modeScores?: {
    semantic?: number;
    keyword?: number;
    graph?: number;
    code?: number;
    causal?: number;
  };
}

/**
 * Options for hybrid search queries
 */
export interface HybridSearchOptions {
  /** Maximum number of results to return (default: 10) */
  limit?: number;
  /** Minimum hybrid score threshold (default: 0.0) */
  threshold?: number;
  /** Filter by session ID */
  sessionId?: SessionId;
  /** Filter by category */
  category?: string;
  /** Search modes to use (default: all available) */
  modes?: SearchMode[];
  /** Custom weights for this search (overrides config) */
  weights?: Partial<SearchWeights>;
  /** Entity ID for graph expansion (if provided, enables graph search) */
  graphEntityId?: string;
  /** Maximum graph traversal depth (default: 1) */
  graphDepth?: number;
  /** Skip temporal boost for this query */
  skipTemporalBoost?: boolean;
  /** Apply neural re-ranking via Reranker (default: false) */
  rerank?: boolean;
  /** Search profile name (overrides weights; auto-detected from query if not set) */
  profile?: string;
  /** Causal direction hint for search ("cause" boosts cause-side, "effect" boosts effect-side) */
  causalDirection?: "cause" | "effect";
}

/**
 * BM25 document representation for keyword search
 */
interface BM25Document {
  memoryId: MemoryId;
  sessionId: SessionId;
  content: string;
  tokens: string[];
  indexedAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Configuration for the HybridSearchEngine
 */
export interface HybridSearchEngineConfig {
  /** Embedding service for generating query embeddings */
  embeddingService: EmbeddingService;
  /** Qdrant client for cloud vector search (optional - falls back to localVectorIndex) */
  qdrantClient?: QdrantClientWrapper;
  /** Local vector index for semantic search (used as fallback if qdrantClient not provided) */
  localVectorIndex?: VectorIndex;
  /** Graph manager for graph-based search (optional) */
  graphManager?: GraphManager;
  /** Weight configuration for search modes */
  weights?: Partial<SearchWeights>;
  /** BM25 parameters */
  bm25?: {
    /** k1 parameter (term frequency saturation, default: 1.5) */
    k1?: number;
    /** b parameter (document length normalization, default: 0.75) */
    b?: number;
  };
  /** Temporal boost configuration (post-retrieval recency boost) */
  temporalBoost?: {
    /** Boost factor (default: 0.3 = max 30% boost for today's memories) */
    factor?: number;
    /** Decay half-life in days (default: 30) */
    decayDays?: number;
  };
  /** Optional BM25 persistence store for surviving restarts */
  bm25Store?: BM25Store;
  /** Memory lookup for resolving graph entity names to memory content (optional) */
  memoryLookup?: MemoryLookup;
  /** Optional Reranker for neural re-ranking of results */
  reranker?: Reranker;
}

/**
 * Resolved configuration with defaults
 */
interface ResolvedConfig {
  embeddingService: EmbeddingService;
  qdrantClient: QdrantClientWrapper | undefined;
  localVectorIndex: VectorIndex | undefined;
  graphManager: GraphManager | undefined;
  weights: SearchWeights;
  bm25: {
    k1: number;
    b: number;
  };
  temporalBoost: { factor: number; decayDays: number };
  bm25Store: BM25Store | undefined;
  memoryLookup: MemoryLookup | undefined;
  reranker: Reranker | undefined;
}

// ============================================================================
// Constants
// ============================================================================

/** Default weights for search modes */
const DEFAULT_WEIGHTS: SearchWeights = {
  semantic: 0.5,
  keyword: 0.3,
  graph: 0.2,
};

/** RRF constant (k parameter) */
const RRF_K = 60;

/** Default BM25 parameters */
const DEFAULT_BM25_K1 = 1.5;
const DEFAULT_BM25_B = 0.75;

// ============================================================================
// BM25 Implementation
// ============================================================================

/**
 * BM25 (Best Matching 25) keyword search implementation
 */
class BM25Index {
  private documents: Map<MemoryId, BM25Document> = new Map();
  private termDocumentFreq: Map<string, number> = new Map();
  private avgDocLength: number = 0;
  private readonly k1: number;
  private readonly b: number;

  constructor(k1: number = DEFAULT_BM25_K1, b: number = DEFAULT_BM25_B) {
    this.k1 = k1;
    this.b = b;
  }

  /**
   * Tokenize text into normalized terms
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1);
  }

  /**
   * Add a document to the BM25 index
   */
  addDocument(
    memoryId: MemoryId,
    sessionId: SessionId,
    content: string,
    indexedAt: Date,
    metadata?: Record<string, unknown>
  ): void {
    const tokens = this.tokenize(content);

    const doc: BM25Document = {
      memoryId,
      sessionId,
      content,
      tokens,
      indexedAt,
    };
    // Only add metadata if provided (exactOptionalPropertyTypes compliance)
    if (metadata !== undefined) {
      doc.metadata = metadata;
    }

    // Update term document frequency
    const seenTerms = new Set<string>();
    for (const token of tokens) {
      if (!seenTerms.has(token)) {
        seenTerms.add(token);
        this.termDocumentFreq.set(
          token,
          (this.termDocumentFreq.get(token) ?? 0) + 1
        );
      }
    }

    this.documents.set(memoryId, doc);
    this.updateAvgDocLength();
  }

  /**
   * Remove a document from the index
   */
  removeDocument(memoryId: MemoryId): boolean {
    const doc = this.documents.get(memoryId);
    if (!doc) return false;

    // Update term document frequency
    const seenTerms = new Set<string>();
    for (const token of doc.tokens) {
      if (!seenTerms.has(token)) {
        seenTerms.add(token);
        const freq = this.termDocumentFreq.get(token) ?? 0;
        if (freq <= 1) {
          this.termDocumentFreq.delete(token);
        } else {
          this.termDocumentFreq.set(token, freq - 1);
        }
      }
    }

    this.documents.delete(memoryId);
    this.updateAvgDocLength();
    return true;
  }

  /**
   * Update average document length
   */
  private updateAvgDocLength(): void {
    if (this.documents.size === 0) {
      this.avgDocLength = 0;
      return;
    }

    let totalLength = 0;
    for (const doc of this.documents.values()) {
      totalLength += doc.tokens.length;
    }
    this.avgDocLength = totalLength / this.documents.size;
  }

  /**
   * Calculate IDF (Inverse Document Frequency) for a term
   */
  private idf(term: string): number {
    const n = this.documents.size;
    const df = this.termDocumentFreq.get(term) ?? 0;

    if (df === 0 || n === 0) return 0;

    // Standard BM25 IDF formula
    return Math.log((n - df + 0.5) / (df + 0.5) + 1);
  }

  /**
   * Calculate term frequency in a document
   */
  private tf(term: string, tokens: string[]): number {
    let count = 0;
    for (const t of tokens) {
      if (t === term) count++;
    }
    return count;
  }

  /**
   * Search documents using BM25 scoring
   */
  search(
    query: string,
    options: {
      limit?: number;
      sessionId?: SessionId;
      category?: string;
    } = {}
  ): Array<{ doc: BM25Document; score: number }> {
    const queryTerms = this.tokenize(query);
    const limit = options.limit ?? 10;

    if (queryTerms.length === 0 || this.documents.size === 0) {
      return [];
    }

    const results: Array<{ doc: BM25Document; score: number }> = [];

    for (const doc of this.documents.values()) {
      // Apply filters
      if (options.sessionId && doc.sessionId !== options.sessionId) continue;

      let score = 0;
      const docLength = doc.tokens.length;

      for (const term of queryTerms) {
        const termFreq = this.tf(term, doc.tokens);
        if (termFreq === 0) continue;

        const idfScore = this.idf(term);

        // BM25 score formula
        const numerator = termFreq * (this.k1 + 1);
        const denominator =
          termFreq +
          this.k1 * (1 - this.b + this.b * (docLength / this.avgDocLength));

        score += idfScore * (numerator / denominator);
      }

      if (score > 0) {
        results.push({ doc, score });
      }
    }

    // Sort by score descending and limit
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Get index statistics
   */
  getStats(): { documentCount: number; termCount: number; avgDocLength: number } {
    return {
      documentCount: this.documents.size,
      termCount: this.termDocumentFreq.size,
      avgDocLength: this.avgDocLength,
    };
  }

  /**
   * Clear the index
   */
  clear(): void {
    this.documents.clear();
    this.termDocumentFreq.clear();
    this.avgDocLength = 0;
  }
}

// ============================================================================
// HybridSearchEngine Implementation
// ============================================================================

/**
 * Hybrid search engine combining semantic, keyword, and graph search
 * with reciprocal rank fusion for optimal result ranking.
 *
 * @example
 * ```typescript
 * const engine = createHybridSearchEngine({
 *   embeddingService: myEmbeddingService,
 *   qdrantClient: myQdrantClient,
 *   graphManager: myGraphManager,
 *   weights: { semantic: 0.5, keyword: 0.3, graph: 0.2 }
 * });
 *
 * // Index a document
 * await engine.indexDocument('mem-001', 'session-001', 'Machine learning concepts', new Date());
 *
 * // Search with hybrid ranking
 * const results = await engine.search('deep learning', { limit: 5 });
 * ```
 */
export class HybridSearchEngine {
  private readonly config: ResolvedConfig;
  private readonly bm25Index: BM25Index;

  constructor(config: HybridSearchEngineConfig) {
    this.config = {
      embeddingService: config.embeddingService,
      qdrantClient: config.qdrantClient,
      localVectorIndex: config.localVectorIndex,
      graphManager: config.graphManager,
      weights: {
        ...DEFAULT_WEIGHTS,
        ...config.weights,
      },
      bm25: {
        k1: config.bm25?.k1 ?? DEFAULT_BM25_K1,
        b: config.bm25?.b ?? DEFAULT_BM25_B,
      },
      temporalBoost: {
        factor: config.temporalBoost?.factor ?? 0.3,
        decayDays: config.temporalBoost?.decayDays ?? 30,
      },
      bm25Store: config.bm25Store,
      memoryLookup: config.memoryLookup,
      reranker: config.reranker,
    };

    this.bm25Index = new BM25Index(this.config.bm25.k1, this.config.bm25.b);
  }

  /**
   * Index a document for hybrid search
   * Adds to both semantic (via Qdrant/VectorIndex) and keyword (BM25) indexes
   */
  async indexDocument(
    memoryId: MemoryId,
    sessionId: SessionId,
    content: string,
    indexedAt: Date,
    options?: {
      category?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    // Add to BM25 index
    this.bm25Index.addDocument(
      memoryId,
      sessionId,
      content,
      indexedAt,
      options?.metadata
    );

    // Persist to BM25Store if configured
    if (this.config.bm25Store) {
      this.config.bm25Store.addDocument(memoryId, sessionId, content, indexedAt, options?.metadata);
    }

    // Generate and store embedding for semantic search
    try {
      const embedding = await this.config.embeddingService.embed(content);

      // Build vectorData with only defined optional properties (exactOptionalPropertyTypes compliance)
      const vectorData: {
        memoryId: MemoryId;
        sessionId: SessionId;
        embedding: Float32Array;
        content: string;
        category?: string;
        metadata?: Record<string, unknown>;
      } = {
        memoryId,
        sessionId,
        embedding,
        content,
      };
      if (options?.category !== undefined) {
        vectorData.category = options.category;
      }
      if (options?.metadata !== undefined) {
        vectorData.metadata = options.metadata;
      }

      if (this.config.qdrantClient) {
        await this.config.qdrantClient.storeVector(vectorData);
      } else if (this.config.localVectorIndex) {
        await this.config.localVectorIndex.storeVector(vectorData);
      }
    } catch (error) {
      throw new HybridSearchError(
        `Failed to index document ${memoryId}: ${error instanceof Error ? error.message : String(error)}`,
        "INDEX_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Remove a document from all indexes
   */
  async removeDocument(memoryId: MemoryId): Promise<boolean> {
    let removed = false;

    // Remove from BM25 index
    removed = this.bm25Index.removeDocument(memoryId) || removed;

    // Remove from vector index
    try {
      if (this.config.qdrantClient) {
        removed = (await this.config.qdrantClient.deleteVector(memoryId)) || removed;
      } else if (this.config.localVectorIndex) {
        removed = (await this.config.localVectorIndex.deleteVector(memoryId)) || removed;
      }
    } catch (error) {
      // Document may not exist in vector index — log for diagnostics
      console.warn("[HybridSearchEngine] removeDocument vector deletion failed:", error instanceof Error ? error.message : String(error));
    }

    return removed;
  }

  /**
   * Add a document directly to the BM25 keyword index (no embedding required).
   * Useful for testing and keyword-only workflows.
   */
  addDocument(
    memoryId: MemoryId,
    sessionId: SessionId,
    content: string,
    indexedAt: Date,
    metadata?: Record<string, unknown>
  ): void {
    this.bm25Index.addDocument(memoryId, sessionId, content, indexedAt, metadata);
  }

  /**
   * Perform hybrid search combining multiple search modes
   */
  async search(
    query: string,
    options: HybridSearchOptions = {}
  ): Promise<HybridSearchResult[]> {
    const limit = options.limit ?? 10;
    const threshold = options.threshold ?? 0.0;

    // Resolve weights from profile (explicit profile > explicit weights > auto-detect > config defaults)
    let resolvedWeights: SearchWeights;
    if (options.weights) {
      // Explicit weights take highest priority
      resolvedWeights = { ...this.config.weights, ...options.weights };
    } else if (options.profile) {
      // Explicit profile name
      const profile = SEARCH_PROFILES.get(options.profile);
      resolvedWeights = profile
        ? { ...this.config.weights, ...profile.weights }
        : { ...this.config.weights };
    } else {
      // Auto-detect profile from query
      const detectedProfileName = detectProfile(query);
      const profile = SEARCH_PROFILES.get(detectedProfileName);
      resolvedWeights = profile
        ? { ...this.config.weights, ...profile.weights }
        : { ...this.config.weights };
    }
    // Auto-detect causal direction from query
    let causalDirection = options.causalDirection;
    if (!causalDirection) {
      const lowerQuery = query.toLowerCase();
      if (/\b(why|what caused|reason|because|due to)\b/.test(lowerQuery)) {
        causalDirection = "cause";
      } else if (/\b(what if|consequence|result|effect|impact|leads to)\b/.test(lowerQuery)) {
        causalDirection = "effect";
      }
    }

    // Boost causal weight when direction is detected and causal mode has weight
    // Mutate in-place to preserve all existing properties (e.g. code, causal, future keys)
    if (causalDirection && resolvedWeights.causal) {
      const boostedCausal = resolvedWeights.causal * 1.5;
      // Compute total using boosted causal instead of original
      const total = resolvedWeights.semantic + resolvedWeights.keyword + resolvedWeights.graph
        + boostedCausal + (resolvedWeights.code ?? 0);
      if (total > 0) {
        const scale = 1.0 / total;
        // Scale all existing properties in-place
        for (const key of Object.keys(resolvedWeights) as Array<keyof SearchWeights>) {
          if (key !== "causal" && resolvedWeights[key] !== undefined) {
            (resolvedWeights as unknown as Record<string, number>)[key] = resolvedWeights[key]! * scale;
          }
        }
        resolvedWeights.causal = boostedCausal * scale;
      }
    }

    const weights = resolvedWeights;
    const modes = options.modes ?? this.getAvailableModes();

    // Collect results from each mode with their ranks
    const resultsByMode: Map<SearchMode, Map<MemoryId, { rank: number; result: VectorSearchResult; score: number }>> = new Map();

    // Execute searches in parallel
    const searchPromises: Promise<void>[] = [];

    if (modes.includes("semantic") && this.hasSemanticSearch()) {
      searchPromises.push(
        this.semanticSearch(query, options).then((results) => {
          resultsByMode.set("semantic", this.rankResults(results));
        }).catch((error) => {
          throw new SearchModeError(
            `Semantic search failed: ${error instanceof Error ? error.message : String(error)}`,
            "semantic",
            "SEMANTIC_SEARCH_FAILED",
            error instanceof Error ? error : undefined
          );
        })
      );
    }

    if (modes.includes("keyword")) {
      searchPromises.push(
        Promise.resolve().then(() => {
          const results = this.keywordSearch(query, options);
          resultsByMode.set("keyword", this.rankResults(results));
        })
      );
    }

    if (modes.includes("graph") && this.config.graphManager && options.graphEntityId) {
      searchPromises.push(
        this.graphSearch(options.graphEntityId, options).then((results) => {
          resultsByMode.set("graph", this.rankResults(results));
        }).catch((error) => {
          throw new SearchModeError(
            `Graph search failed: ${error instanceof Error ? error.message : String(error)}`,
            "graph",
            "GRAPH_SEARCH_FAILED",
            error instanceof Error ? error : undefined
          );
        })
      );
    }

    // Code and causal modes are no-ops for now (providers will be wired later).
    // They participate in RRF with empty result sets, so their weights have no effect yet.
    if (modes.includes("code")) {
      resultsByMode.set("code", new Map());
    }
    if (modes.includes("causal")) {
      resultsByMode.set("causal", new Map());
    }

    await Promise.all(searchPromises);

    // Apply reciprocal rank fusion
    let fusedResults = this.reciprocalRankFusion(resultsByMode, weights);

    // Apply temporal boost unless explicitly skipped
    if (!options.skipTemporalBoost) {
      fusedResults = this.applyTemporalBoost(fusedResults);
      // Re-sort after boost
      fusedResults.sort((a, b) => b.hybridScore - a.hybridScore);
    }

    // Optional re-ranking via Cohere Rerank API (skip if reranker returns null on failure)
    if (options.rerank && this.config.reranker && fusedResults.length > 0) {
      const documents = fusedResults.map((r) => r.content);
      const reranked = await this.config.reranker.rerank(query, documents);
      if (reranked !== null) {
        const reorderedResults = reranked.map((rr) => ({
          ...fusedResults[rr.index]!,
          hybridScore: rr.relevanceScore,
        }));
        fusedResults = reorderedResults;
      }
    }

    // Filter by threshold and limit
    return fusedResults
      .filter((result) => result.hybridScore >= threshold)
      .slice(0, limit);
  }

  /**
   * Perform semantic search using embeddings
   */
  private async semanticSearch(
    query: string,
    options: HybridSearchOptions
  ): Promise<VectorSearchResult[]> {
    const queryEmbedding = await this.config.embeddingService.embed(query);
    const limit = (options.limit ?? 10) * 2; // Fetch more for fusion

    // Build search options with only defined properties (exactOptionalPropertyTypes compliance)
    const searchOptions: {
      limit: number;
      threshold: number;
      sessionId?: SessionId;
      category?: string;
    } = {
      limit,
      threshold: 0.0, // Let fusion handle thresholding
    };
    if (options.sessionId !== undefined) {
      searchOptions.sessionId = options.sessionId;
    }
    if (options.category !== undefined) {
      searchOptions.category = options.category;
    }

    if (this.config.qdrantClient) {
      return this.config.qdrantClient.semanticSearch(queryEmbedding, searchOptions);
    } else if (this.config.localVectorIndex) {
      return this.config.localVectorIndex.semanticSearch(queryEmbedding, searchOptions);
    }

    return [];
  }

  /**
   * Perform keyword search using BM25
   */
  private keywordSearch(
    query: string,
    options: HybridSearchOptions
  ): VectorSearchResult[] {
    const limit = (options.limit ?? 10) * 2; // Fetch more for fusion

    // Build search options with only defined properties (exactOptionalPropertyTypes compliance)
    const bm25SearchOptions: {
      limit: number;
      sessionId?: SessionId;
      category?: string;
    } = { limit };
    if (options.sessionId !== undefined) {
      bm25SearchOptions.sessionId = options.sessionId;
    }
    if (options.category !== undefined) {
      bm25SearchOptions.category = options.category;
    }

    const bm25Results = this.bm25Index.search(query, bm25SearchOptions);

    // Convert BM25 results to VectorSearchResult format
    return bm25Results.map(({ doc, score }) => {
      const result: VectorSearchResult = {
        memoryId: doc.memoryId,
        sessionId: doc.sessionId,
        content: doc.content,
        similarity: this.normalizeBM25Score(score),
        distance: 1 - this.normalizeBM25Score(score),
        indexedAt: doc.indexedAt,
      };
      // Only add metadata if present (exactOptionalPropertyTypes compliance)
      if (doc.metadata !== undefined) {
        result.metadata = doc.metadata;
      }
      return result;
    });
  }

  /**
   * Normalize BM25 score to 0-1 range
   */
  private normalizeBM25Score(score: number): number {
    // Using sigmoid-like normalization
    return score / (score + 1);
  }

  /**
   * Perform graph-based search using entity relationships.
   * Collects entity names from relationships and looks up memories via MemoryLookup.
   */
  private async graphSearch(
    entityId: string,
    options: HybridSearchOptions
  ): Promise<VectorSearchResult[]> {
    if (!this.config.graphManager) {
      return [];
    }

    try {
      const relationships = await this.config.graphManager.findRelationshipsByEntity(entityId);
      const limit = (options.limit ?? 10) * 2;

      // Collect entity names from relationships
      const entityNames = new Set<string>();
      for (const rel of relationships) {
        const sourceName = rel.properties?.sourceName ?? rel.sourceId;
        const targetName = rel.properties?.targetName ?? rel.targetId;
        if (rel.sourceId !== entityId) entityNames.add(String(sourceName));
        if (rel.targetId !== entityId) entityNames.add(String(targetName));
      }

      if (entityNames.size === 0 || !this.config.memoryLookup) {
        return [];
      }

      // Lookup memories by entity names
      const results = await this.config.memoryLookup.lookupByEntityNames(
        Array.from(entityNames)
      );

      // Score by hop distance (all direct relationships = hop 1)
      return results.slice(0, limit).map((result) => ({
        ...result,
        similarity: 1.0 / (1 + 1), // hop distance 1 for direct relationships
      }));
    } catch (error) {
      throw new SearchModeError(
        `Graph search failed: ${error instanceof Error ? error.message : String(error)}`,
        "graph",
        "GRAPH_QUERY_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Rank results and create rank mapping
   */
  private rankResults(
    results: VectorSearchResult[]
  ): Map<MemoryId, { rank: number; result: VectorSearchResult; score: number }> {
    const ranked = new Map<MemoryId, { rank: number; result: VectorSearchResult; score: number }>();

    results.forEach((result, index) => {
      ranked.set(result.memoryId, {
        rank: index + 1, // 1-indexed rank
        result,
        score: result.similarity,
      });
    });

    return ranked;
  }

  /**
   * Apply temporal post-retrieval boost to RRF results.
   * Formula: boostedScore = rrfScore * (1 + factor * exp(-ageDays / decayDays))
   */
  private applyTemporalBoost(results: HybridSearchResult[]): HybridSearchResult[] {
    const { factor, decayDays } = this.config.temporalBoost;
    const now = Date.now();

    return results.map((result) => {
      const ageDays = (now - result.indexedAt.getTime()) / (1000 * 60 * 60 * 24);
      const boost = factor * Math.exp(-ageDays / decayDays);
      return {
        ...result,
        hybridScore: result.hybridScore * (1 + boost),
      };
    });
  }

  /**
   * Apply Reciprocal Rank Fusion to combine results from multiple search modes
   * Formula: RRF(d) = sum(1 / (k + rank(d))) where k = 60
   */
  private reciprocalRankFusion(
    resultsByMode: Map<SearchMode, Map<MemoryId, { rank: number; result: VectorSearchResult; score: number }>>,
    weights: SearchWeights
  ): HybridSearchResult[] {
    // Collect all unique memory IDs
    const allMemoryIds = new Set<MemoryId>();
    const memoryResults = new Map<MemoryId, VectorSearchResult>();

    for (const [_mode, results] of resultsByMode) {
      for (const [memoryId, { result }] of results) {
        allMemoryIds.add(memoryId);
        // Keep the most complete result
        if (!memoryResults.has(memoryId)) {
          memoryResults.set(memoryId, result);
        }
      }
    }

    // Calculate RRF scores
    const rrfScores: Map<MemoryId, { score: number; modes: SearchMode[]; modeScores: Map<SearchMode, number> }> = new Map();

    for (const memoryId of allMemoryIds) {
      let totalRRF = 0;
      let totalWeight = 0;
      const modes: SearchMode[] = [];
      const modeScores = new Map<SearchMode, number>();

      for (const [mode, results] of resultsByMode) {
        const weight = weights[mode] ?? 0;
        const ranked = results.get(memoryId);

        if (ranked) {
          // RRF formula: 1 / (k + rank)
          const rrfScore = 1 / (RRF_K + ranked.rank);
          totalRRF += weight * rrfScore;
          totalWeight += weight;
          modes.push(mode);
          modeScores.set(mode, ranked.score);
        }
      }

      // Normalize RRF score if we have results
      if (totalWeight > 0) {
        rrfScores.set(memoryId, {
          score: totalRRF / totalWeight,
          modes,
          modeScores,
        });
      }
    }

    // Convert to HybridSearchResult and sort by score
    const hybridResults: HybridSearchResult[] = [];

    for (const [memoryId, rrfData] of rrfScores) {
      const baseResult = memoryResults.get(memoryId);
      if (!baseResult) continue;

      // Normalize final score to 0-1 range
      // RRF scores are typically small, so we scale them
      const normalizedScore = Math.min(1, rrfData.score * RRF_K);

      // Build modeScores with only defined values (exactOptionalPropertyTypes compliance)
      const modeScoresObj: { semantic?: number; keyword?: number; graph?: number; code?: number; causal?: number } = {};
      const semanticScore = rrfData.modeScores.get("semantic");
      const keywordScore = rrfData.modeScores.get("keyword");
      const graphScore = rrfData.modeScores.get("graph");
      const codeScore = rrfData.modeScores.get("code");
      const causalScore = rrfData.modeScores.get("causal");

      if (semanticScore !== undefined) {
        modeScoresObj.semantic = semanticScore;
      }
      if (keywordScore !== undefined) {
        modeScoresObj.keyword = keywordScore;
      }
      if (graphScore !== undefined) {
        modeScoresObj.graph = graphScore;
      }
      if (codeScore !== undefined) {
        modeScoresObj.code = codeScore;
      }
      if (causalScore !== undefined) {
        modeScoresObj.causal = causalScore;
      }

      // Build hybrid result with only defined optional properties
      const hybridResult: HybridSearchResult = {
        ...baseResult,
        hybridScore: normalizedScore,
        searchModes: rrfData.modes,
      };
      if (Object.keys(modeScoresObj).length > 0) {
        hybridResult.modeScores = modeScoresObj;
      }

      hybridResults.push(hybridResult);
    }

    // Sort by hybrid score descending
    return hybridResults.sort((a, b) => b.hybridScore - a.hybridScore);
  }

  /**
   * Check if semantic search is available
   */
  private hasSemanticSearch(): boolean {
    return !!(this.config.qdrantClient || this.config.localVectorIndex);
  }

  /**
   * Get list of available search modes based on configuration
   */
  private getAvailableModes(): SearchMode[] {
    const modes: SearchMode[] = ["keyword"]; // BM25 is always available

    if (this.hasSemanticSearch()) {
      modes.unshift("semantic");
    }

    if (this.config.graphManager) {
      modes.push("graph");
    }

    return modes;
  }

  /**
   * Get available search modes for this engine
   */
  getAvailableSearchModes(): SearchMode[] {
    return this.getAvailableModes();
  }

  /**
   * Get current weight configuration
   */
  getWeights(): SearchWeights {
    return { ...this.config.weights };
  }

  /**
   * Get BM25 index statistics
   */
  getBM25Stats(): { documentCount: number; termCount: number; avgDocLength: number } {
    return this.bm25Index.getStats();
  }

  /**
   * Clear all indexes
   */
  clear(): void {
    this.bm25Index.clear();
  }

  /**
   * Load BM25 documents from persistent store into the in-memory index.
   * Call this on startup to restore the BM25 index without rebuilding from scratch.
   */
  loadFromStore(): number {
    if (!this.config.bm25Store) {
      return 0;
    }

    const docs = this.config.bm25Store.loadAll();
    for (const doc of docs) {
      let meta: Record<string, unknown> | undefined;
      try {
        meta = doc.metadata ? JSON.parse(doc.metadata) as Record<string, unknown> : undefined;
      } catch (e) {
        console.warn("[HybridSearch] Corrupt BM25 metadata for", doc.memoryId, e instanceof Error ? e.message : e);
      }
      this.bm25Index.addDocument(doc.memoryId, doc.sessionId, doc.content, doc.indexedAt, meta);
    }
    return docs.length;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a HybridSearchEngine with the given configuration
 *
 * @param config - Engine configuration
 * @returns Configured HybridSearchEngine instance
 *
 * @example
 * ```typescript
 * const engine = createHybridSearchEngine({
 *   embeddingService: myEmbeddingService,
 *   qdrantClient: myQdrantClient,
 *   weights: { semantic: 0.6, keyword: 0.3, graph: 0.1 }
 * });
 * ```
 */
export function createHybridSearchEngine(
  config: HybridSearchEngineConfig
): HybridSearchEngine {
  return new HybridSearchEngine(config);
}

/**
 * Create a HybridSearchEngine with only keyword search (no embedding service required)
 * Useful for testing or when vector search is not needed
 *
 * @param bm25Config - Optional BM25 parameters
 * @returns HybridSearchEngine configured for keyword-only search
 */
export function createKeywordOnlySearchEngine(bm25Config?: {
  k1?: number;
  b?: number;
}): HybridSearchEngine {
  // Create a minimal mock embedding service that throws on use
  const mockEmbeddingService = {
    embed: () => Promise.reject(new Error("Embedding service not configured")),
    embedBatch: () => Promise.reject(new Error("Embedding service not configured")),
    dimensions: 768,
    providerName: "mock",
    getCacheStats: () => null,
    clearCache: () => {},
    isCacheEnabled: () => false,
  } as unknown as EmbeddingService;

  // Build config with only defined optional properties (exactOptionalPropertyTypes compliance)
  const config: HybridSearchEngineConfig = {
    embeddingService: mockEmbeddingService,
    weights: { semantic: 0, keyword: 1, graph: 0 },
  };
  if (bm25Config !== undefined) {
    config.bm25 = bm25Config;
  }

  return new HybridSearchEngine(config);
}
