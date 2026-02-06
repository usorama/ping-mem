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
      console.log("[Runtime] Neo4j connected");
    } catch (err) {
      console.warn(
        `[Runtime] Neo4j connection failed (ingestion/graph features disabled): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    console.log("[Runtime] Neo4j not configured (ingestion/graph features disabled)");
  }

  // Connect to Qdrant if configured
  if (config.qdrant) {
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
      console.log("[Runtime] Qdrant connected");
    } catch (err) {
      console.warn(
        `[Runtime] Qdrant connection failed (code search disabled): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    console.log("[Runtime] Qdrant not configured (code search disabled)");
  }

  return services;
}
