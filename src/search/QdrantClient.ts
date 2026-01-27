/**
 * Qdrant Client Wrapper for ping-mem Vector Search
 *
 * Provides a type-safe wrapper around the Qdrant vector database client
 * for cloud-based vector storage and semantic search operations.
 * Falls back to local VectorIndex on connection failure.
 *
 * @module search/QdrantClient
 * @version 1.0.0
 */

import { QdrantClient as QdrantSDKClient } from "@qdrant/js-client-rest";
import type { MemoryId, SessionId } from "../types/index.js";
import {
  VectorIndex,
  type VectorEmbedding,
  type VectorSearchResult,
  type VectorIndexConfig,
} from "./VectorIndex.js";

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Base error class for Qdrant client errors
 */
export class QdrantClientError extends Error {
  public readonly code: string | undefined;
  public override readonly cause: Error | undefined;

  constructor(message: string, code?: string, cause?: Error) {
    super(message);
    this.name = "QdrantClientError";
    this.code = code ?? undefined;
    this.cause = cause ?? undefined;
    Object.setPrototypeOf(this, QdrantClientError.prototype);
  }
}

/**
 * Error thrown when connection to Qdrant fails
 */
export class QdrantConnectionError extends QdrantClientError {
  constructor(message: string, code?: string, cause?: Error) {
    super(message, code, cause);
    this.name = "QdrantConnectionError";
    Object.setPrototypeOf(this, QdrantConnectionError.prototype);
  }
}

/**
 * Error thrown when a Qdrant operation fails
 */
export class QdrantOperationError extends QdrantClientError {
  public readonly operation: string;

  constructor(message: string, operation: string, code?: string, cause?: Error) {
    super(message, code, cause);
    this.name = "QdrantOperationError";
    this.operation = operation;
    Object.setPrototypeOf(this, QdrantOperationError.prototype);
  }
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for the Qdrant client
 */
export interface QdrantClientConfig {
  /** Qdrant server URL (e.g., 'http://localhost:6333' or cloud URL) */
  url: string;
  /** API key for authentication (required for Qdrant Cloud) */
  apiKey?: string;
  /** Collection name for storing vectors */
  collectionName: string;
  /** Vector dimensions (default: 768 for OpenAI embeddings) */
  vectorDimensions?: number;
  /** Distance metric (default: 'Cosine') */
  distanceMetric?: "Cosine" | "Euclid" | "Dot" | "Manhattan";
  /** Connection timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Enable local fallback on connection failure (default: true) */
  enableFallback?: boolean;
  /** Local fallback configuration */
  fallbackConfig?: VectorIndexConfig;
}

/**
 * Internal configuration with resolved defaults
 */
interface ResolvedConfig {
  url: string;
  apiKey: string | undefined;
  collectionName: string;
  vectorDimensions: number;
  distanceMetric: "Cosine" | "Euclid" | "Dot" | "Manhattan";
  timeout: number;
  enableFallback: boolean;
  fallbackConfig: VectorIndexConfig | undefined;
}

/**
 * Default configuration values
 */
const DEFAULT_VECTOR_DIMENSIONS = 768;
const DEFAULT_DISTANCE_METRIC = "Cosine" as const;
const DEFAULT_TIMEOUT = 5000;
const DEFAULT_ENABLE_FALLBACK = true;

// ============================================================================
// Qdrant Client Implementation
// ============================================================================

/**
 * Qdrant client wrapper providing vector storage and semantic search
 * with automatic fallback to local SQLite-based VectorIndex.
 *
 * @example
 * ```typescript
 * const client = new QdrantClientWrapper({
 *   url: 'http://localhost:6333',
 *   collectionName: 'ping-mem-vectors',
 *   vectorDimensions: 768
 * });
 *
 * await client.connect();
 *
 * // Store a vector
 * await client.storeVector({
 *   memoryId: 'mem-001',
 *   sessionId: 'session-001',
 *   embedding: new Float32Array(768).fill(0.1),
 *   content: 'Test memory content'
 * });
 *
 * // Search for similar vectors
 * const results = await client.semanticSearch(queryEmbedding, { limit: 5 });
 *
 * await client.disconnect();
 * ```
 */
export class QdrantClientWrapper {
  private client: QdrantSDKClient | null = null;
  private readonly config: ResolvedConfig;
  private connected = false;
  private usingFallback = false;
  private fallbackIndex: VectorIndex | null = null;

  constructor(config: QdrantClientConfig) {
    this.config = {
      url: config.url,
      apiKey: config.apiKey,
      collectionName: config.collectionName,
      vectorDimensions: config.vectorDimensions ?? DEFAULT_VECTOR_DIMENSIONS,
      distanceMetric: config.distanceMetric ?? DEFAULT_DISTANCE_METRIC,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      enableFallback: config.enableFallback ?? DEFAULT_ENABLE_FALLBACK,
      fallbackConfig: config.fallbackConfig,
    };
  }

  /**
   * Establish connection to Qdrant server
   *
   * @throws {QdrantConnectionError} If connection fails and fallback is disabled
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      // Build client config, only including apiKey if defined
      const clientConfig: { url: string; apiKey?: string; timeout?: number } = {
        url: this.config.url,
        timeout: this.config.timeout,
      };
      if (this.config.apiKey !== undefined) {
        clientConfig.apiKey = this.config.apiKey;
      }
      this.client = new QdrantSDKClient(clientConfig);

      // Verify connectivity with health check
      const isHealthy = await this.healthCheck();
      if (!isHealthy) {
        throw new Error("Health check failed");
      }

      // Ensure collection exists
      await this.createCollectionIfNotExists();

      this.connected = true;
      this.usingFallback = false;
    } catch (error) {
      this.client = null;

      if (this.config.enableFallback) {
        // Initialize fallback to local VectorIndex
        await this.initializeFallback();
        this.connected = true;
        this.usingFallback = true;
      } else {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        throw new QdrantConnectionError(
          `Failed to connect to Qdrant at ${this.config.url}: ${errorMessage}`,
          "CONNECTION_FAILED",
          error instanceof Error ? error : undefined
        );
      }
    }
  }

  /**
   * Close connection to Qdrant server
   */
  async disconnect(): Promise<void> {
    if (this.fallbackIndex) {
      await this.fallbackIndex.close();
      this.fallbackIndex = null;
    }
    this.client = null;
    this.connected = false;
    this.usingFallback = false;
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Check if using local fallback
   */
  isUsingFallback(): boolean {
    return this.usingFallback;
  }

  /**
   * Perform health check on Qdrant server
   *
   * @returns true if server is healthy
   */
  async healthCheck(): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    try {
      // Use getCollections as a health check - it's a lightweight operation
      await this.client.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create collection if it doesn't exist
   */
  async createCollectionIfNotExists(): Promise<void> {
    if (!this.client) {
      throw new QdrantConnectionError(
        "Not connected to Qdrant. Call connect() first."
      );
    }

    try {
      // Check if collection exists
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(
        (c) => c.name === this.config.collectionName
      );

      if (!exists) {
        await this.client.createCollection(this.config.collectionName, {
          vectors: {
            size: this.config.vectorDimensions,
            distance: this.config.distanceMetric,
          },
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new QdrantOperationError(
        `Failed to create collection ${this.config.collectionName}: ${errorMessage}`,
        "createCollection",
        "CREATE_COLLECTION_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Store a vector embedding
   *
   * @param vectorData - Vector embedding with metadata
   */
  async storeVector(vectorData: VectorEmbedding): Promise<void> {
    if (!this.connected) {
      throw new QdrantConnectionError(
        "Not connected to Qdrant. Call connect() first."
      );
    }

    // Use fallback if active
    if (this.usingFallback && this.fallbackIndex) {
      return this.fallbackIndex.storeVector(vectorData);
    }

    if (!this.client) {
      throw new QdrantConnectionError(
        "Not connected to Qdrant. Call connect() first."
      );
    }

    try {
      await this.client.upsert(this.config.collectionName, {
        wait: true,
        points: [
          {
            id: vectorData.memoryId,
            vector: Array.from(vectorData.embedding),
            payload: {
              session_id: vectorData.sessionId,
              content: vectorData.content,
              category: vectorData.category ?? null,
              indexed_at: new Date().toISOString(),
              metadata: vectorData.metadata ?? null,
            },
          },
        ],
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new QdrantOperationError(
        `Failed to store vector ${vectorData.memoryId}: ${errorMessage}`,
        "upsert",
        "UPSERT_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Perform semantic search using cosine similarity
   *
   * @param queryEmbedding - Query vector
   * @param options - Search options
   * @returns Array of search results sorted by similarity
   */
  async semanticSearch(
    queryEmbedding: Float32Array,
    options: {
      limit?: number;
      threshold?: number;
      sessionId?: SessionId;
      category?: string;
    } = {}
  ): Promise<VectorSearchResult[]> {
    if (!this.connected) {
      throw new QdrantConnectionError(
        "Not connected to Qdrant. Call connect() first."
      );
    }

    // Use fallback if active
    if (this.usingFallback && this.fallbackIndex) {
      return this.fallbackIndex.semanticSearch(queryEmbedding, options);
    }

    if (!this.client) {
      throw new QdrantConnectionError(
        "Not connected to Qdrant. Call connect() first."
      );
    }

    const limit = options.limit ?? 10;
    const threshold = options.threshold ?? 0.7;

    try {
      // Build filter conditions
      const mustConditions: Array<{ key: string; match: { value: string } }> = [];

      if (options.sessionId) {
        mustConditions.push({
          key: "session_id",
          match: { value: options.sessionId },
        });
      }

      if (options.category) {
        mustConditions.push({
          key: "category",
          match: { value: options.category },
        });
      }

      const searchParams: {
        vector: number[];
        limit: number;
        score_threshold: number;
        with_payload: boolean;
        filter?: { must: Array<{ key: string; match: { value: string } }> };
      } = {
        vector: Array.from(queryEmbedding),
        limit,
        score_threshold: threshold,
        with_payload: true,
      };

      if (mustConditions.length > 0) {
        searchParams.filter = { must: mustConditions };
      }

      const results = await this.client.search(
        this.config.collectionName,
        searchParams
      );

      return results.map((result) => {
        const payload = result.payload as {
          session_id?: string;
          content?: string;
          category?: string;
          indexed_at?: string;
          metadata?: Record<string, unknown>;
        } | null;

        const searchResult: VectorSearchResult = {
          memoryId: String(result.id) as MemoryId,
          sessionId: (payload?.session_id ?? "") as SessionId,
          content: payload?.content ?? "",
          similarity: result.score,
          distance: 1 - result.score,
          indexedAt: payload?.indexed_at
            ? new Date(payload.indexed_at)
            : new Date(),
        };

        // Only add metadata if it exists (exactOptionalPropertyTypes compliance)
        if (payload?.metadata !== undefined) {
          searchResult.metadata = payload.metadata;
        }

        return searchResult;
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new QdrantOperationError(
        `Semantic search failed: ${errorMessage}`,
        "search",
        "SEARCH_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Delete a vector by memory ID
   *
   * @param memoryId - Memory ID to delete
   * @returns true if deleted, false if not found
   */
  async deleteVector(memoryId: MemoryId): Promise<boolean> {
    if (!this.connected) {
      throw new QdrantConnectionError(
        "Not connected to Qdrant. Call connect() first."
      );
    }

    // Use fallback if active
    if (this.usingFallback && this.fallbackIndex) {
      return this.fallbackIndex.deleteVector(memoryId);
    }

    if (!this.client) {
      throw new QdrantConnectionError(
        "Not connected to Qdrant. Call connect() first."
      );
    }

    try {
      await this.client.delete(this.config.collectionName, {
        wait: true,
        points: [memoryId],
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get statistics about the vector store
   */
  async getStats(): Promise<{
    totalVectors: number;
    vectorDimensions: number;
    collectionName: string;
    usingFallback: boolean;
  }> {
    if (!this.connected) {
      throw new QdrantConnectionError(
        "Not connected to Qdrant. Call connect() first."
      );
    }

    // Use fallback if active
    if (this.usingFallback && this.fallbackIndex) {
      const fallbackStats = await this.fallbackIndex.getStats();
      return {
        totalVectors: fallbackStats.totalVectors,
        vectorDimensions: fallbackStats.vectorDimensions,
        collectionName: this.config.collectionName,
        usingFallback: true,
      };
    }

    if (!this.client) {
      throw new QdrantConnectionError(
        "Not connected to Qdrant. Call connect() first."
      );
    }

    try {
      const collectionInfo = await this.client.getCollection(
        this.config.collectionName
      );

      return {
        totalVectors: collectionInfo.points_count ?? 0,
        vectorDimensions: this.config.vectorDimensions,
        collectionName: this.config.collectionName,
        usingFallback: false,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new QdrantOperationError(
        `Failed to get stats: ${errorMessage}`,
        "getCollection",
        "STATS_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Initialize local fallback VectorIndex
   */
  private async initializeFallback(): Promise<void> {
    this.fallbackIndex = new VectorIndex({
      vectorDimensions: this.config.vectorDimensions,
      ...this.config.fallbackConfig,
    });
  }

  /**
   * Get the underlying Qdrant client for advanced operations
   *
   * @throws {QdrantConnectionError} If not connected or using fallback
   */
  getClient(): QdrantSDKClient {
    if (!this.client) {
      throw new QdrantConnectionError(
        "Not connected to Qdrant or using fallback. Call connect() first."
      );
    }
    return this.client;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a Qdrant client with the given configuration
 *
 * @param config - Client configuration
 * @returns Configured QdrantClientWrapper instance
 */
export function createQdrantClient(config: QdrantClientConfig): QdrantClientWrapper {
  return new QdrantClientWrapper(config);
}

/**
 * Create a Qdrant client from environment variables
 *
 * Environment variables:
 * - QDRANT_URL: Server URL (required)
 * - QDRANT_API_KEY: API key for authentication (optional)
 * - QDRANT_COLLECTION_NAME: Collection name (required)
 * - QDRANT_VECTOR_DIMENSIONS: Vector dimensions (optional, default: 768)
 * - QDRANT_ENABLE_FALLBACK: Enable local fallback (optional, default: true)
 *
 * @returns Configured QdrantClientWrapper instance
 * @throws {Error} If required environment variables are missing
 */
export function createQdrantClientFromEnv(): QdrantClientWrapper {
  const url = process.env["QDRANT_URL"];
  const collectionName = process.env["QDRANT_COLLECTION_NAME"];

  if (!url || !collectionName) {
    throw new Error(
      "Missing required environment variables: QDRANT_URL, QDRANT_COLLECTION_NAME"
    );
  }

  const apiKey = process.env["QDRANT_API_KEY"];
  const vectorDimensionsStr = process.env["QDRANT_VECTOR_DIMENSIONS"];
  const vectorDimensions = vectorDimensionsStr
    ? parseInt(vectorDimensionsStr, 10)
    : DEFAULT_VECTOR_DIMENSIONS;
  const enableFallbackStr = process.env["QDRANT_ENABLE_FALLBACK"];
  const enableFallback = enableFallbackStr !== "false";

  // Build config, only including apiKey if defined (exactOptionalPropertyTypes compliance)
  const config: QdrantClientConfig = {
    url,
    collectionName,
    vectorDimensions,
    enableFallback,
  };
  if (apiKey !== undefined) {
    config.apiKey = apiKey;
  }

  return new QdrantClientWrapper(config);
}
