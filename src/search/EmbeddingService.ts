/**
 * Embedding Service Abstraction for ping-mem
 *
 * Provides a pluggable embedding provider interface with caching support.
 * Uses content-addressable caching via SHA-256 hashes for efficient deduplication.
 *
 * @module search/EmbeddingService
 * @version 1.0.0
 */

import OpenAI from "openai";
import { createHash } from "crypto";

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Base error class for embedding service errors
 */
export class EmbeddingServiceError extends Error {
  public readonly code: string | undefined;
  public override readonly cause: Error | undefined;

  constructor(message: string, code?: string, cause?: Error) {
    super(message);
    this.name = "EmbeddingServiceError";
    this.code = code ?? undefined;
    this.cause = cause ?? undefined;
    Object.setPrototypeOf(this, EmbeddingServiceError.prototype);
  }
}

/**
 * Error thrown when embedding generation fails
 */
export class EmbeddingGenerationError extends EmbeddingServiceError {
  constructor(message: string, code?: string, cause?: Error) {
    super(message, code, cause);
    this.name = "EmbeddingGenerationError";
    Object.setPrototypeOf(this, EmbeddingGenerationError.prototype);
  }
}

/**
 * Error thrown when provider configuration is invalid
 */
export class EmbeddingConfigurationError extends EmbeddingServiceError {
  constructor(message: string, code?: string, cause?: Error) {
    super(message, code, cause);
    this.name = "EmbeddingConfigurationError";
    Object.setPrototypeOf(this, EmbeddingConfigurationError.prototype);
  }
}

// ============================================================================
// Provider Interface
// ============================================================================

/**
 * Interface for embedding providers
 * Allows pluggable implementations (OpenAI, local models, etc.)
 */
export interface EmbeddingProvider {
  /**
   * Generate embedding for text input
   * @param text - Text to embed
   * @returns Float32Array of embedding dimensions
   */
  embed(text: string): Promise<Float32Array>;

  /**
   * Get the dimensions of embeddings produced by this provider
   */
  readonly dimensions: number;

  /**
   * Get the provider name/identifier
   */
  readonly name: string;
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Supported embedding provider types
 */
export type EmbeddingProviderType = "openai" | "gemini" | "ollama" | "custom";

/**
 * Cache configuration options
 */
export interface EmbeddingCacheConfig {
  /** Enable caching (default: true) */
  enabled?: boolean;
  /** Maximum cache entries (default: 1000) */
  maxEntries?: number;
  /** Time-to-live in milliseconds (default: 3600000 = 1 hour) */
  ttlMs?: number;
}

/**
 * Configuration for the embedding service
 */
export interface EmbeddingServiceConfig {
  /** Provider type to use */
  provider: EmbeddingProviderType;
  /** API key for the provider (required for OpenAI) */
  apiKey?: string;
  /** Model to use for embeddings */
  model?: string;
  /** Embedding dimensions (default: 768 for text-embedding-3-small) */
  dimensions?: number;
  /** Cache configuration */
  cache?: EmbeddingCacheConfig;
  /** Custom provider instance (when provider is 'custom') */
  customProvider?: EmbeddingProvider;
  /** OpenAI base URL override (for proxies/alternative endpoints) */
  baseUrl?: string;
}

/**
 * Required cache configuration with all values defined
 */
interface RequiredCacheConfig {
  enabled: boolean;
  maxEntries: number;
  ttlMs: number;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
  provider: "openai" as const,
  model: "text-embedding-3-small",
  dimensions: 768,
  cache: {
    enabled: true,
    maxEntries: 1000,
    ttlMs: 3600000, // 1 hour
  } satisfies RequiredCacheConfig,
};

// ============================================================================
// Cache Implementation
// ============================================================================

/**
 * Cache entry with TTL tracking
 */
interface CacheEntry {
  embedding: Float32Array;
  createdAt: number;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  hits: number;
  misses: number;
  entries: number;
  hitRate: number;
}

/**
 * In-memory cache with TTL and LRU eviction
 */
class EmbeddingCache {
  private cache: Map<string, CacheEntry> = new Map();
  private hits = 0;
  private misses = 0;
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(config: EmbeddingCacheConfig) {
    const defaultCache = DEFAULT_CONFIG.cache;
    this.maxEntries = config.maxEntries !== undefined ? config.maxEntries : defaultCache.maxEntries;
    this.ttlMs = config.ttlMs !== undefined ? config.ttlMs : defaultCache.ttlMs;
  }

  /**
   * Generate SHA-256 hash for cache key
   */
  private hashKey(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  /**
   * Get embedding from cache if available and not expired
   */
  get(text: string): Float32Array | null {
    const key = this.hashKey(text);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // Move to end for LRU (delete and re-add)
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.hits++;
    return entry.embedding;
  }

  /**
   * Store embedding in cache
   */
  set(text: string, embedding: Float32Array): void {
    const key = this.hashKey(text);

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      } else {
        break;
      }
    }

    this.cache.set(key, {
      embedding,
      createdAt: Date.now(),
    });
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.cache.size,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }
}

// ============================================================================
// OpenAI Embedding Provider
// ============================================================================

/**
 * OpenAI embedding provider using text-embedding-3-small
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  public readonly dimensions: number;
  public readonly name = "openai";

  constructor(apiKey: string, options?: { model?: string; dimensions?: number; baseUrl?: string }) {
    if (!apiKey) {
      throw new EmbeddingConfigurationError(
        "OpenAI API key is required",
        "MISSING_API_KEY"
      );
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: options?.baseUrl,
    });
    this.model = options?.model ?? DEFAULT_CONFIG.model;
    this.dimensions = options?.dimensions ?? DEFAULT_CONFIG.dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!text || text.trim().length === 0) {
      throw new EmbeddingGenerationError(
        "Cannot embed empty text",
        "EMPTY_TEXT"
      );
    }

    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: text,
        dimensions: this.dimensions,
      });

      const embeddingData = response.data[0]?.embedding;
      if (!embeddingData) {
        throw new EmbeddingGenerationError(
          "No embedding returned from OpenAI",
          "NO_EMBEDDING"
        );
      }

      return new Float32Array(embeddingData);
    } catch (error) {
      if (error instanceof EmbeddingServiceError) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new EmbeddingGenerationError(
        `Failed to generate embedding: ${errorMessage}`,
        "GENERATION_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }
}

// ============================================================================
// Gemini Embedding Provider
// ============================================================================

/**
 * Gemini embedding provider using the REST API directly (no SDK)
 *
 * Uses the text-embedding-004 model with configurable output dimensionality.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  public readonly dimensions: number;
  public readonly name = "gemini";

  constructor(apiKey: string, options?: { model?: string; dimensions?: number }) {
    if (!apiKey) {
      throw new EmbeddingConfigurationError(
        "Gemini API key is required",
        "MISSING_API_KEY"
      );
    }

    this.apiKey = apiKey;
    this.model = options?.model ?? "text-embedding-004";
    this.dimensions = options?.dimensions ?? DEFAULT_CONFIG.dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!text || text.trim().length === 0) {
      throw new EmbeddingGenerationError(
        "Cannot embed empty text",
        "EMPTY_TEXT"
      );
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
          outputDimensionality: this.dimensions,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new EmbeddingGenerationError(
          `Gemini API error (${response.status}): ${errorBody}`,
          "API_ERROR"
        );
      }

      const data = (await response.json()) as { embedding?: { values?: number[] } };
      const values = data?.embedding?.values;

      if (!values || !Array.isArray(values)) {
        throw new EmbeddingGenerationError(
          "No embedding returned from Gemini",
          "NO_EMBEDDING"
        );
      }

      return new Float32Array(values);
    } catch (error) {
      if (error instanceof EmbeddingServiceError) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new EmbeddingGenerationError(
        `Failed to generate Gemini embedding: ${errorMessage}`,
        "GENERATION_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }
}

// ============================================================================
// Ollama Embedding Provider
// ============================================================================

/**
 * Ollama embedding provider using the native /api/embed endpoint.
 *
 * Uses nomic-embed-text by default (768 dimensions, matches Gemini/OpenAI default).
 * Ollama must be running locally — no API key required.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  public readonly dimensions: number;
  public readonly name = "ollama";

  constructor(options?: { baseUrl?: string; model?: string; dimensions?: number }) {
    this.baseUrl = (options?.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
    this.model = options?.model ?? "nomic-embed-text";
    this.dimensions = options?.dimensions ?? DEFAULT_CONFIG.dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!text || text.trim().length === 0) {
      throw new EmbeddingGenerationError("Cannot embed empty text", "EMPTY_TEXT");
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: text }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new EmbeddingGenerationError(
          `Ollama API error (${response.status}): ${errorBody}`,
          "API_ERROR"
        );
      }

      const data = (await response.json()) as { embeddings?: number[][] };
      const values = data?.embeddings?.[0];

      if (!values || !Array.isArray(values)) {
        throw new EmbeddingGenerationError("No embedding returned from Ollama", "NO_EMBEDDING");
      }

      return new Float32Array(values);
    } catch (error) {
      if (error instanceof EmbeddingServiceError) throw error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new EmbeddingGenerationError(
        `Failed to generate Ollama embedding: ${errorMessage}`,
        "GENERATION_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }
}

// ============================================================================
// Chained Fallback Provider
// ============================================================================

/**
 * Chains multiple providers in priority order.
 * Tries each in sequence until one succeeds.
 */
export class ChainedFallbackProvider implements EmbeddingProvider {
  private readonly providers: EmbeddingProvider[];
  private consecutiveFailures: Map<string, number> = new Map();
  public readonly dimensions: number;
  public readonly name: string;

  constructor(providers: EmbeddingProvider[]) {
    if (providers.length === 0) {
      throw new EmbeddingConfigurationError("At least one provider is required", "NO_PROVIDERS");
    }
    const dims = providers[0]!.dimensions;
    for (const p of providers) {
      if (p.dimensions !== dims) {
        throw new EmbeddingConfigurationError(
          `Dimension mismatch: ${p.name} has ${p.dimensions}, expected ${dims}`,
          "DIMENSION_MISMATCH"
        );
      }
    }
    this.providers = providers;
    this.dimensions = dims;
    this.name = providers.map(p => p.name).join("→");
  }

  async embed(text: string): Promise<Float32Array> {
    let lastError: Error | undefined;
    for (const provider of this.providers) {
      try {
        const result = await provider.embed(text);
        // Reset failure counter on success
        this.consecutiveFailures.set(provider.name, 0);
        return result;
      } catch (error) {
        const count = (this.consecutiveFailures.get(provider.name) ?? 0) + 1;
        this.consecutiveFailures.set(provider.name, count);
        const msg = error instanceof Error ? error.message : String(error);
        const level = count > 5 ? "error" : "warn";
        console[level](
          `[ChainedFallback] ${provider.name} failed (${count}x): ${msg}. Trying next provider...`
        );
        lastError = error instanceof Error ? error : new Error(msg);
      }
    }
    throw new EmbeddingGenerationError(
      `All ${this.providers.length} providers failed. Last error: ${lastError?.message}`,
      "ALL_PROVIDERS_FAILED",
      lastError
    );
  }
}

// ============================================================================
// Fallback Embedding Provider (legacy 2-provider)
// ============================================================================

/**
 * Fallback embedding provider that tries a primary provider first,
 * falling back to a secondary provider on any error.
 *
 * Both providers must produce embeddings of the same dimensionality.
 */
export class FallbackEmbeddingProvider implements EmbeddingProvider {
  private readonly primary: EmbeddingProvider;
  private readonly fallback: EmbeddingProvider;
  private fallbackCount = 0;
  public readonly dimensions: number;
  public readonly name: string;

  constructor(primary: EmbeddingProvider, fallback: EmbeddingProvider) {
    if (primary.dimensions !== fallback.dimensions) {
      throw new EmbeddingConfigurationError(
        `Dimension mismatch: primary provider "${primary.name}" has ${primary.dimensions} dimensions, ` +
        `fallback provider "${fallback.name}" has ${fallback.dimensions} dimensions. ` +
        `Both providers must produce embeddings of the same dimensionality.`,
        "DIMENSION_MISMATCH"
      );
    }

    this.primary = primary;
    this.fallback = fallback;
    this.dimensions = primary.dimensions;
    this.name = `${primary.name}+${fallback.name}`;
  }

  async embed(text: string): Promise<Float32Array> {
    try {
      const result = await this.primary.embed(text);
      this.fallbackCount = 0;
      return result;
    } catch (error) {
      this.fallbackCount++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const level = this.fallbackCount > 10 ? "error" : "warn";
      console[level](
        `[FallbackEmbedding] Primary "${this.primary.name}" failed (${this.fallbackCount} consecutive): ${errorMessage}. ` +
        `Falling back to "${this.fallback.name}".`
      );
      return await this.fallback.embed(text);
    }
  }
}

// ============================================================================
// Embedding Service Implementation
// ============================================================================

/**
 * Embedding service with caching and provider abstraction
 *
 * @example
 * ```typescript
 * const service = createOpenAIEmbeddingService(process.env.OPENAI_API_KEY!);
 * const embedding = await service.embed("Hello, world!");
 * console.log(`Dimensions: ${embedding.length}`);
 * console.log(`Cache stats: ${JSON.stringify(service.getCacheStats())}`);
 * ```
 */
export class EmbeddingService {
  private readonly provider: EmbeddingProvider;
  private readonly cache: EmbeddingCache | null;
  private readonly cacheEnabled: boolean;

  constructor(config: EmbeddingServiceConfig) {
    // Initialize provider
    if (config.provider === "custom") {
      if (!config.customProvider) {
        throw new EmbeddingConfigurationError(
          "Custom provider instance is required when provider type is 'custom'",
          "MISSING_CUSTOM_PROVIDER"
        );
      }
      this.provider = config.customProvider;
    } else if (config.provider === "openai") {
      if (!config.apiKey) {
        throw new EmbeddingConfigurationError(
          "API key is required for OpenAI provider",
          "MISSING_API_KEY"
        );
      }
      // Build options object, only including defined properties
      const openaiOptions: { model?: string; dimensions?: number; baseUrl?: string } = {};
      if (config.model !== undefined) openaiOptions.model = config.model;
      if (config.dimensions !== undefined) openaiOptions.dimensions = config.dimensions;
      if (config.baseUrl !== undefined) openaiOptions.baseUrl = config.baseUrl;

      this.provider = new OpenAIEmbeddingProvider(config.apiKey, openaiOptions);
    } else if (config.provider === "gemini") {
      if (!config.apiKey) {
        throw new EmbeddingConfigurationError(
          "API key is required for Gemini provider",
          "MISSING_API_KEY"
        );
      }
      const geminiOptions: { model?: string; dimensions?: number } = {};
      if (config.model !== undefined) geminiOptions.model = config.model;
      if (config.dimensions !== undefined) geminiOptions.dimensions = config.dimensions;

      this.provider = new GeminiEmbeddingProvider(config.apiKey, geminiOptions);
    } else if (config.provider === "ollama") {
      const ollamaOptions: { baseUrl?: string; model?: string; dimensions?: number } = {};
      if (config.baseUrl !== undefined) ollamaOptions.baseUrl = config.baseUrl;
      if (config.model !== undefined) ollamaOptions.model = config.model;
      if (config.dimensions !== undefined) ollamaOptions.dimensions = config.dimensions;

      this.provider = new OllamaEmbeddingProvider(ollamaOptions);
    } else {
      throw new EmbeddingConfigurationError(
        `Unknown provider type: ${config.provider}`,
        "UNKNOWN_PROVIDER"
      );
    }

    // Initialize cache
    const cacheConfig = { ...DEFAULT_CONFIG.cache, ...config.cache };
    this.cacheEnabled = cacheConfig.enabled ?? true;
    this.cache = this.cacheEnabled ? new EmbeddingCache(cacheConfig) : null;
  }

  /**
   * Generate embedding for text, using cache if available
   */
  async embed(text: string): Promise<Float32Array> {
    // Check cache first
    if (this.cache) {
      const cached = this.cache.get(text);
      if (cached) {
        return cached;
      }
    }

    // Generate embedding
    const embedding = await this.provider.embed(text);

    // Store in cache
    if (this.cache) {
      this.cache.set(text, embedding);
    }

    return embedding;
  }

  /**
   * Generate embeddings for multiple texts
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  /**
   * Get the dimensions of embeddings produced by this service
   */
  get dimensions(): number {
    return this.provider.dimensions;
  }

  /**
   * Get the provider name
   */
  get providerName(): string {
    return this.provider.name;
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): CacheStats | null {
    return this.cache?.getStats() ?? null;
  }

  /**
   * Clear the embedding cache
   */
  clearCache(): void {
    this.cache?.clear();
  }

  /**
   * Check if caching is enabled
   */
  isCacheEnabled(): boolean {
    return this.cacheEnabled;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an embedding service with the given configuration
 *
 * @param config - Service configuration
 * @returns Configured EmbeddingService instance
 */
export function createEmbeddingService(config: EmbeddingServiceConfig): EmbeddingService {
  return new EmbeddingService(config);
}

/**
 * Create an OpenAI embedding service
 *
 * @param apiKey - OpenAI API key
 * @param options - Optional configuration overrides
 * @returns Configured EmbeddingService instance
 *
 * @example
 * ```typescript
 * const service = createOpenAIEmbeddingService(process.env.OPENAI_API_KEY!, {
 *   dimensions: 768,
 *   cache: { maxEntries: 500 }
 * });
 * ```
 */
export function createOpenAIEmbeddingService(
  apiKey: string,
  options?: {
    model?: string;
    dimensions?: number;
    baseUrl?: string;
    cache?: EmbeddingCacheConfig;
  }
): EmbeddingService {
  // Build config object, only including defined properties
  const config: EmbeddingServiceConfig = {
    provider: "openai",
    apiKey,
  };
  if (options?.model !== undefined) config.model = options.model;
  if (options?.dimensions !== undefined) config.dimensions = options.dimensions;
  if (options?.baseUrl !== undefined) config.baseUrl = options.baseUrl;
  if (options?.cache !== undefined) config.cache = options.cache;

  return new EmbeddingService(config);
}

/**
 * Create an embedding service from environment variables.
 *
 * Provider priority: Ollama (local) → Gemini → OpenAI
 * Chains all available providers with automatic fallback.
 *
 * Environment variables:
 * - OLLAMA_URL: Ollama base URL (default: http://localhost:11434)
 * - OLLAMA_EMBED_MODEL: Ollama embedding model (default: nomic-embed-text)
 * - GEMINI_API_KEY: Gemini API key
 * - OPENAI_API_KEY: OpenAI API key
 * - OPENAI_BASE_URL: Optional base URL override for OpenAI
 * - EMBEDDING_MODEL: Model override (applies to OpenAI/Gemini)
 * - EMBEDDING_DIMENSIONS: Embedding dimensions (default: 768)
 *
 * Chain construction:
 * 1. If OLLAMA_URL is set (or defaults to localhost:11434): Ollama is primary
 * 2. If GEMINI_API_KEY is set: Gemini is first fallback
 * 3. If OPENAI_API_KEY is set: OpenAI is second fallback
 * 4. If no providers available: throws EmbeddingConfigurationError
 *
 * @returns Configured EmbeddingService instance
 * @throws {EmbeddingConfigurationError} If no providers can be configured
 */
export function createEmbeddingServiceFromEnv(): EmbeddingService {
  const ollamaUrl = process.env["OLLAMA_URL"] ?? "http://localhost:11434";
  const ollamaModel = process.env["OLLAMA_EMBED_MODEL"] ?? "nomic-embed-text";
  const ollamaEnabled = process.env["OLLAMA_EMBEDDINGS"] !== "false"; // enabled by default
  const geminiKey = process.env["GEMINI_API_KEY"];
  const openaiKey = process.env["OPENAI_API_KEY"];
  const openaiBaseUrl = process.env["OPENAI_BASE_URL"];
  const model = process.env["EMBEDDING_MODEL"];
  const dimensionsStr = process.env["EMBEDDING_DIMENSIONS"];
  const dimensions = dimensionsStr ? parseInt(dimensionsStr, 10) : undefined;

  // Build provider chain: Ollama → Gemini → OpenAI
  const providers: EmbeddingProvider[] = [];

  // 1. Ollama (local, no API key needed)
  if (ollamaEnabled) {
    const ollamaOpts: { baseUrl?: string; model?: string; dimensions?: number } = {};
    ollamaOpts.baseUrl = ollamaUrl;
    ollamaOpts.model = ollamaModel;
    if (dimensions !== undefined) ollamaOpts.dimensions = dimensions;
    providers.push(new OllamaEmbeddingProvider(ollamaOpts));
  }

  // 2. Gemini (first cloud fallback)
  if (geminiKey) {
    const geminiOpts: { model?: string; dimensions?: number } = {};
    if (dimensions !== undefined) geminiOpts.dimensions = dimensions;
    providers.push(new GeminiEmbeddingProvider(geminiKey, geminiOpts));
  }

  // 3. OpenAI (second cloud fallback)
  if (openaiKey) {
    const openaiOpts: { model?: string; dimensions?: number; baseUrl?: string } = {};
    if (openaiBaseUrl !== undefined) openaiOpts.baseUrl = openaiBaseUrl;
    if (model !== undefined) openaiOpts.model = model;
    if (dimensions !== undefined) openaiOpts.dimensions = dimensions;
    providers.push(new OpenAIEmbeddingProvider(openaiKey, openaiOpts));
  }

  if (providers.length === 0) {
    throw new EmbeddingConfigurationError(
      "No embedding providers available. Set OLLAMA_URL (default), GEMINI_API_KEY, or OPENAI_API_KEY.",
      "NO_PROVIDERS"
    );
  }

  // Single provider: use directly. Multiple: chain with fallback.
  const provider = providers.length === 1
    ? providers[0]!
    : new ChainedFallbackProvider(providers);

  return new EmbeddingService({
    provider: "custom",
    customProvider: provider,
  });
}
