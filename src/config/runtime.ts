/**
 * Runtime configuration loader for mandatory dependencies (Neo4j + Qdrant).
 *
 * Ensures required services are reachable before the server starts.
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
  neo4j: {
    uri: string;
    username: string;
    password: string;
    database?: string;
    maxConnectionPoolSize?: number;
  };
  qdrant: {
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
  neo4jClient: Neo4jClient;
  graphManager: GraphManager;
  temporalStore: TemporalStore;
  lineageEngine: LineageEngine;
  evolutionEngine: EvolutionEngine;
  qdrantClient: QdrantClientWrapper;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getNeo4jUsername(): string {
  const username = process.env["NEO4J_USERNAME"] ?? process.env["NEO4J_USER"];
  if (!username) {
    throw new Error("Missing required environment variable: NEO4J_USERNAME (or NEO4J_USER)");
  }
  return username;
}

export function loadRuntimeConfig(): RuntimeConfig {
  const neo4jUri = requireEnv("NEO4J_URI");
  const neo4jUsername = getNeo4jUsername();
  const neo4jPassword = requireEnv("NEO4J_PASSWORD");

  const qdrantUrl = requireEnv("QDRANT_URL");
  const qdrantCollectionName = requireEnv("QDRANT_COLLECTION_NAME");

  const dbPath = process.env["PING_MEM_DB_PATH"] ?? ":memory:";

  const neo4jDatabase = process.env["NEO4J_DATABASE"];
  const maxPoolSizeStr = process.env["NEO4J_MAX_POOL_SIZE"];
  const maxPoolSize = maxPoolSizeStr ? parseInt(maxPoolSizeStr, 10) : undefined;

  const qdrantApiKey = process.env["QDRANT_API_KEY"];
  const qdrantVectorDimensionsStr = process.env["QDRANT_VECTOR_DIMENSIONS"];
  const qdrantVectorDimensions = qdrantVectorDimensionsStr
    ? parseInt(qdrantVectorDimensionsStr, 10)
    : undefined;

  return {
    neo4j: {
      uri: neo4jUri,
      username: neo4jUsername,
      password: neo4jPassword,
      ...(neo4jDatabase && { database: neo4jDatabase }),
      ...(maxPoolSize && { maxConnectionPoolSize: maxPoolSize }),
    },
    qdrant: {
      url: qdrantUrl,
      collectionName: qdrantCollectionName,
      ...(qdrantApiKey && { apiKey: qdrantApiKey }),
      ...(qdrantVectorDimensions && { vectorDimensions: qdrantVectorDimensions }),
    },
    pingMem: {
      dbPath,
    },
  };
}

export async function createRuntimeServices(): Promise<RuntimeServices> {
  const config = loadRuntimeConfig();

  const neo4jClient = createNeo4jClient({
    uri: config.neo4j.uri,
    username: config.neo4j.username,
    password: config.neo4j.password,
    ...(config.neo4j.database && { database: config.neo4j.database }),
    ...(config.neo4j.maxConnectionPoolSize && { maxConnectionPoolSize: config.neo4j.maxConnectionPoolSize }),
  });
  await neo4jClient.connect();

  const graphManager = new GraphManager({ neo4jClient });
  const temporalStore = new TemporalStore({ neo4jClient });
  const lineageEngine = new LineageEngine(neo4jClient);
  const evolutionEngine = new EvolutionEngine({ temporalStore, graphManager });

  const qdrantClient = new QdrantClientWrapper({
    url: config.qdrant.url,
    collectionName: config.qdrant.collectionName,
    ...(config.qdrant.apiKey && { apiKey: config.qdrant.apiKey }),
    ...(config.qdrant.vectorDimensions && { vectorDimensions: config.qdrant.vectorDimensions }),
    enableFallback: false,
  });
  await qdrantClient.connect();

  return {
    neo4jClient,
    graphManager,
    temporalStore,
    lineageEngine,
    evolutionEngine,
    qdrantClient,
  };
}
