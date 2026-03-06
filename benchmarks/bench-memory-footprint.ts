#!/usr/bin/env bun
/**
 * Benchmark: Memory Footprint & Token Compression
 * Measures storage efficiency and context compression ratio.
 */
import { CONFIG, api } from "./config.ts";

interface FootprintResult {
  totalMemoriesStored: number;
  totalInputChars: number;
  avgValueLength: number;
  sessionOverheadMs: number;
  storagePerMemoryEstimate: string;
  contextCompressionScenario: {
    rawContextTokens: number;
    memoriesUsed: number;
    retrievedChars: number;
    estimatedRetrievedTokens: number;
    compressionRatio: number;
    description: string;
  };
}

// Simulate a realistic conversation context that would be stored as memories
const CONVERSATION_CONTEXT = `
The user is building a TypeScript API server using Hono framework with Bun runtime.
They need authentication using JWT tokens with refresh token rotation.
The database is PostgreSQL with Drizzle ORM for type-safe queries.
They want Redis caching with a cache-aside pattern for frequently accessed user profiles.
Error handling should use Result types instead of exceptions.
The API follows REST conventions with OpenAPI documentation generated from Zod schemas.
Deployment is via Docker on AWS ECS with blue-green deployment strategy.
CI/CD pipeline uses GitHub Actions with separate staging and production environments.
Testing uses Bun's built-in test runner with integration tests against testcontainers.
The project structure follows a modular monolith pattern with clear domain boundaries.
Rate limiting is implemented at the API gateway using a token bucket algorithm.
Logging uses structured JSON logs with correlation IDs for request tracing.
The frontend is a React SPA communicating via REST API with React Query for data fetching.
WebSocket connections are used for real-time notifications and live updates.
The team follows trunk-based development with feature flags for gradual rollouts.
`;

// How an agent would break this into discrete memories
const DISCRETE_MEMORIES = [
  { key: "tech-stack", value: "TypeScript API with Hono framework on Bun runtime" },
  { key: "auth-strategy", value: "JWT authentication with refresh token rotation" },
  { key: "database", value: "PostgreSQL with Drizzle ORM for type-safe queries" },
  { key: "caching", value: "Redis cache-aside pattern for user profiles" },
  { key: "error-handling", value: "Result types instead of exceptions" },
  { key: "api-design", value: "REST with OpenAPI docs generated from Zod schemas" },
  { key: "deployment", value: "Docker on AWS ECS with blue-green deployments" },
  { key: "ci-cd", value: "GitHub Actions with staging and production environments" },
  { key: "testing", value: "Bun test runner with testcontainers for integration tests" },
  { key: "architecture", value: "Modular monolith with clear domain boundaries" },
  { key: "rate-limiting", value: "Token bucket algorithm at API gateway" },
  { key: "logging", value: "Structured JSON logs with correlation IDs" },
  { key: "frontend", value: "React SPA with React Query, REST API" },
  { key: "realtime", value: "WebSocket for notifications and live updates" },
  { key: "dev-process", value: "Trunk-based development with feature flags" },
];

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English text
  return Math.ceil(text.length / 4);
}

async function run(): Promise<FootprintResult> {
  // Start session
  await api("/api/v1/session/start", { body: { name: "bench-footprint" } });

  const startTime = performance.now();

  // Store discrete memories
  let totalInputChars = 0;
  for (const mem of DISCRETE_MEMORIES) {
    await api("/api/v1/context", {
      body: { key: mem.key, value: mem.value, category: "fact", skipProactiveRecall: true },
    });
    totalInputChars += mem.value.length;
  }

  const storeTime = performance.now() - startTime;

  // Now simulate retrieval: query for relevant context
  const query = "What tech stack and deployment strategy is the project using?";
  const searchRes = await api(`/api/v1/search?query=${encodeURIComponent(query)}&limit=5`);
  const retrieved = searchRes.data?.data ?? [];
  const retrievedChars = retrieved.reduce((sum: number, r: any) => sum + ((r.memory?.value ?? r.value)?.length ?? 0), 0);

  // Context compression: compare raw conversation tokens vs retrieved memory tokens
  const rawTokens = estimateTokens(CONVERSATION_CONTEXT);
  const retrievedTokens = estimateTokens(retrieved.map((r: any) => `${r.memory?.key ?? r.key}: ${r.memory?.value ?? r.value}`).join("\n"));

  await api("/api/v1/session/end", { body: {} });

  return {
    totalMemoriesStored: DISCRETE_MEMORIES.length,
    totalInputChars,
    avgValueLength: Math.round(totalInputChars / DISCRETE_MEMORIES.length),
    sessionOverheadMs: Math.round(storeTime),
    storagePerMemoryEstimate: `~${Math.round(totalInputChars / DISCRETE_MEMORIES.length + 200)}B (value + metadata)`,
    contextCompressionScenario: {
      rawContextTokens: rawTokens,
      memoriesUsed: retrieved.length,
      retrievedChars,
      estimatedRetrievedTokens: retrievedTokens,
      compressionRatio: Math.round((rawTokens / Math.max(retrievedTokens, 1)) * 100) / 100,
      description: `Storing ${DISCRETE_MEMORIES.length} discrete memories from a ${rawTokens}-token conversation, then retrieving top-5 relevant yields ~${retrievedTokens} tokens (${Math.round((1 - retrievedTokens / rawTokens) * 100)}% reduction)`,
    },
  };
}

const result = await run();
console.log(JSON.stringify(result, null, 2));
