/**
 * Runtime configuration loader.
 *
 * Neo4j and Qdrant are optional — core memory works with SQLite only.
 * When their env vars are present, the services are created and connected.
 * When missing, the server starts in SQLite-only mode (no ingestion/graph).
 */

import {
  Neo4jClient,
  createNeo4jClient,
} from "../graph/Neo4jClient.js";
import { GraphManager } from "../graph/GraphManager.js";
import { TemporalStore } from "../graph/TemporalStore.js";
import { LineageEngine } from "../graph/LineageEngine.js";
import { EvolutionEngine } from "../graph/EvolutionEngine.js";
import { QdrantClientWrapper } from "../search/QdrantClient.js";
import type { HealthMonitor } from "../observability/HealthMonitor.js";
import { HybridSearchEngine, createHybridSearchEngine, createKeywordOnlySearchEngine } from "../search/HybridSearchEngine.js";
import { createEmbeddingServiceFromEnv, type EmbeddingService } from "../search/EmbeddingService.js";
import { LLMEntityExtractor, type LLMEntityExtractorConfig } from "../graph/LLMEntityExtractor.js";
import { EntityExtractor } from "../graph/EntityExtractor.js";
import { CausalGraphManager } from "../graph/CausalGraphManager.js";
import { ContradictionDetector } from "../graph/ContradictionDetector.js";
import { CausalDiscoveryAgent, type CausalDiscoveryConfig } from "../graph/CausalDiscoveryAgent.js";
import OpenAI from "openai";
import { createLogger } from "../util/logger.js";

const log = createLogger("Runtime");

export interface RuntimeConfig {
  neo4j?: {
    uri: string;
    username: string;
    password: string;
    database?: string;
    maxConnectionPoolSize?: number;
  };
  qdrant?: {
    url: string;
    collectionName: string;
    apiKey?: string;
    vectorDimensions?: number;
  };
  pingMem: {
    dbPath: string;
  };
}

export interface RuntimeServices {
  neo4jClient?: Neo4jClient;
  graphManager?: GraphManager;
  temporalStore?: TemporalStore;
  lineageEngine?: LineageEngine;
  evolutionEngine?: EvolutionEngine;
  qdrantClient?: QdrantClientWrapper;
  healthMonitor?: HealthMonitor;
  hybridSearchEngine?: HybridSearchEngine;
  embeddingService?: EmbeddingService;
  llmEntityExtractor?: LLMEntityExtractor;
  causalGraphManager?: CausalGraphManager;
  contradictionDetector?: ContradictionDetector;
  causalDiscoveryAgent?: CausalDiscoveryAgent;
}

function getNeo4jUsername(): string | undefined {
  return process.env["NEO4J_USERNAME"] ?? process.env["NEO4J_USER"];
}

export function loadRuntimeConfig(): RuntimeConfig {
  const dbPath = process.env["PING_MEM_DB_PATH"] ?? ":memory:";

  // Neo4j config — optional, all three must be present to enable
  const neo4jUri = process.env["NEO4J_URI"];
  const neo4jUsername = getNeo4jUsername();
  const neo4jPassword = process.env["NEO4J_PASSWORD"];

  let neo4j: RuntimeConfig["neo4j"];
  if (neo4jUri && neo4jUsername && neo4jPassword) {
    const neo4jDatabase = process.env["NEO4J_DATABASE"];
    const maxPoolSizeStr = process.env["NEO4J_MAX_POOL_SIZE"];
    const maxPoolSize = maxPoolSizeStr ? parseInt(maxPoolSizeStr, 10) : undefined;

    neo4j = {
      uri: neo4jUri,
      username: neo4jUsername,
      password: neo4jPassword,
      ...(neo4jDatabase && { database: neo4jDatabase }),
      ...(maxPoolSize && { maxConnectionPoolSize: maxPoolSize }),
    };
  }

  // Qdrant config — optional, url and collection must be present to enable
  const qdrantUrl = process.env["QDRANT_URL"];
  const qdrantCollectionName = process.env["QDRANT_COLLECTION_NAME"];

  let qdrant: RuntimeConfig["qdrant"];
  if (qdrantUrl && qdrantCollectionName) {
    const qdrantApiKey = process.env["QDRANT_API_KEY"];
    const qdrantVectorDimensionsStr = process.env["QDRANT_VECTOR_DIMENSIONS"];
    const qdrantVectorDimensions = qdrantVectorDimensionsStr
      ? parseInt(qdrantVectorDimensionsStr, 10)
      : undefined;

    qdrant = {
      url: qdrantUrl,
      collectionName: qdrantCollectionName,
      ...(qdrantApiKey && { apiKey: qdrantApiKey }),
      ...(qdrantVectorDimensions && { vectorDimensions: qdrantVectorDimensions }),
    };
  }

  return {
    ...(neo4j && { neo4j }),
    ...(qdrant && { qdrant }),
    pingMem: { dbPath },
  };
}

export async function createRuntimeServices(): Promise<RuntimeServices> {
  const config = loadRuntimeConfig();
  const services: RuntimeServices = {};

  // Connect to Neo4j if configured
  if (config.neo4j) {
    const maxRetries = 5;
    const retryDelayMs = 3_000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const neo4jClient = createNeo4jClient({
          uri: config.neo4j.uri,
          username: config.neo4j.username,
          password: config.neo4j.password,
          ...(config.neo4j.database && { database: config.neo4j.database }),
          ...(config.neo4j.maxConnectionPoolSize && { maxConnectionPoolSize: config.neo4j.maxConnectionPoolSize }),
        });
        await neo4jClient.connect();

        services.neo4jClient = neo4jClient;
        services.graphManager = new GraphManager({ neo4jClient });
        services.temporalStore = new TemporalStore({ neo4jClient });
        services.lineageEngine = new LineageEngine(neo4jClient);
        services.evolutionEngine = new EvolutionEngine({
          temporalStore: services.temporalStore,
          graphManager: services.graphManager,
        });
        services.causalGraphManager = new CausalGraphManager({ graphManager: services.graphManager });
        log.info("Neo4j connected", { attempt });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < maxRetries) {
          log.warn(`Neo4j connection attempt ${attempt}/${maxRetries} failed, retrying in ${retryDelayMs}ms`, { error: msg });
          await new Promise((r) => setTimeout(r, retryDelayMs));
        } else {
          log.warn("Neo4j connection failed after all retries (ingestion/graph features disabled)", { error: msg, attempts: maxRetries });
        }
      }
    }
  } else {
    log.info("Neo4j not configured (ingestion/graph features disabled)");
  }

  // Connect to Qdrant if configured
  if (config.qdrant) {
    const qdrantMaxRetries = 5;
    const qdrantRetryDelayMs = 3_000;
    for (let attempt = 1; attempt <= qdrantMaxRetries; attempt++) {
      try {
        const qdrantClient = new QdrantClientWrapper({
          url: config.qdrant.url,
          collectionName: config.qdrant.collectionName,
          ...(config.qdrant.apiKey && { apiKey: config.qdrant.apiKey }),
          ...(config.qdrant.vectorDimensions && { vectorDimensions: config.qdrant.vectorDimensions }),
          enableFallback: false,
        });
        await qdrantClient.connect();
        services.qdrantClient = qdrantClient;
        log.info("Qdrant connected", { attempt });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < qdrantMaxRetries) {
          log.warn(`Qdrant connection attempt ${attempt}/${qdrantMaxRetries} failed, retrying in ${qdrantRetryDelayMs}ms`, { error: msg });
          await new Promise((r) => setTimeout(r, qdrantRetryDelayMs));
        } else {
          log.warn("Qdrant connection failed after all retries (code search disabled)", { error: msg, attempts: qdrantMaxRetries });
        }
      }
    }
  } else {
    log.info("Qdrant not configured (code search disabled)");
  }

  // Create HybridSearchEngine — uses Gemini or OpenAI for embeddings if API key available,
  // otherwise falls back to keyword-only BM25 search (no external API calls)
  try {
    const embeddingService = createEmbeddingServiceFromEnv();
    services.embeddingService = embeddingService;
    const hybridConfig: Parameters<typeof createHybridSearchEngine>[0] = {
      embeddingService,
    };
    if (services.graphManager) hybridConfig.graphManager = services.graphManager;
    if (services.qdrantClient) hybridConfig.qdrantClient = services.qdrantClient;
    services.hybridSearchEngine = createHybridSearchEngine(hybridConfig);
    log.info(`HybridSearchEngine created with ${embeddingService.providerName} embeddings`);
  } catch (err) {
    services.hybridSearchEngine = createKeywordOnlySearchEngine();
    // Clear embeddingService so health checks correctly report "none (keyword-only)" rather
    // than showing a provider that failed to initialize.
    delete services.embeddingService;
    const hasEmbeddingConfig = process.env["GEMINI_API_KEY"] || process.env["OPENAI_API_KEY"] || process.env["OLLAMA_URL"];
    if (!hasEmbeddingConfig) {
      log.info("HybridSearchEngine created (keyword-only, no embedding provider configured)");
    } else {
      log.error("Embedding provider initialization failed — falling back to keyword-only search", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Wire LLMEntityExtractor: Ollama (primary) → OpenAI (fallback)
  // Ollama exposes an OpenAI-compatible chat API at /v1/chat/completions
  const ollamaUrl = process.env["OLLAMA_URL"];
  const openAiKey = process.env["OPENAI_API_KEY"];
  if (services.graphManager) {
    const fallbackExtractor = new EntityExtractor();
    if (ollamaUrl) {
      const ollamaClient = new OpenAI({
        apiKey: "ollama",
        baseURL: `${ollamaUrl}/v1`,
      }) as unknown as LLMEntityExtractorConfig["openai"];
      services.llmEntityExtractor = new LLMEntityExtractor({
        openai: ollamaClient,
        fallbackExtractor,
        model: "llama3.2",
      });
      log.info("LLMEntityExtractor created (Ollama llama3.2)", { ollamaUrl });
    } else if (openAiKey) {
      const openaiClient = new OpenAI({ apiKey: openAiKey }) as unknown as LLMEntityExtractorConfig["openai"];
      services.llmEntityExtractor = new LLMEntityExtractor({
        openai: openaiClient,
        fallbackExtractor,
      });
      log.info("LLMEntityExtractor created (OpenAI gpt-4o-mini)");
    } else {
      log.info("LLMEntityExtractor disabled (neither OLLAMA_URL nor OPENAI_API_KEY set)");
    }
  } else {
    log.info("LLMEntityExtractor disabled (graphManager not available)");
  }

  // Wire ContradictionDetector: Ollama (primary) → OpenAI (fallback)
  // Uses OpenAI-compatible chat API — same pattern as LLMEntityExtractor
  if (ollamaUrl) {
    const ollamaClientForContradiction = new OpenAI({
      apiKey: "ollama",
      baseURL: `${ollamaUrl}/v1`,
    }) as unknown as ConstructorParameters<typeof ContradictionDetector>[0]["openai"];
    services.contradictionDetector = new ContradictionDetector({
      openai: ollamaClientForContradiction,
      model: "llama3.2",
    });
    log.info("ContradictionDetector created (Ollama llama3.2)", { ollamaUrl });
  } else if (openAiKey) {
    const openaiClientForContradiction = new OpenAI({ apiKey: openAiKey }) as unknown as ConstructorParameters<typeof ContradictionDetector>[0]["openai"];
    services.contradictionDetector = new ContradictionDetector({
      openai: openaiClientForContradiction,
    });
    log.info("ContradictionDetector created (OpenAI gpt-4o-mini)");
  } else {
    log.info("ContradictionDetector disabled (neither OLLAMA_URL nor OPENAI_API_KEY set)");
  }

  // Wire CausalDiscoveryAgent: Ollama (primary) → OpenAI (fallback)
  // Requires both causalGraphManager and graphManager (both come from Neo4j block)
  if (services.causalGraphManager && services.graphManager) {
    if (ollamaUrl) {
      const ollamaClientForCausal = new OpenAI({
        apiKey: "ollama",
        baseURL: `${ollamaUrl}/v1`,
      }) as unknown as CausalDiscoveryConfig["openai"];
      services.causalDiscoveryAgent = new CausalDiscoveryAgent({
        openai: ollamaClientForCausal,
        causalGraphManager: services.causalGraphManager,
        graphManager: services.graphManager,
        model: "llama3.2",
      });
      log.info("CausalDiscoveryAgent created (Ollama llama3.2)", { ollamaUrl });
    } else if (openAiKey) {
      const openaiClientForCausal = new OpenAI({ apiKey: openAiKey }) as unknown as CausalDiscoveryConfig["openai"];
      services.causalDiscoveryAgent = new CausalDiscoveryAgent({
        openai: openaiClientForCausal,
        causalGraphManager: services.causalGraphManager,
        graphManager: services.graphManager,
      });
      log.info("CausalDiscoveryAgent created (OpenAI gpt-4o-mini)");
    } else {
      log.info("CausalDiscoveryAgent disabled (neither OLLAMA_URL nor OPENAI_API_KEY set)");
    }
  } else {
    log.info("CausalDiscoveryAgent disabled (causalGraphManager or graphManager not available)");
  }

  return services;
}
