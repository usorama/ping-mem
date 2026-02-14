#!/usr/bin/env bun
/**
 * Benchmark: Memory Store/Retrieve Latency
 * Measures p50, p95, p99 for context_save, context_get, context_search, and context_delete.
 */
import { CONFIG, api, computeStats, type BenchResult } from "./config.ts";

const SAMPLE_MEMORIES = Array.from({ length: CONFIG.iterations }, (_, i) => ({
  key: `bench-mem-${i}`,
  value: `This is benchmark memory item #${i}. It contains information about ${
    ["authentication", "database queries", "API design", "error handling", "caching strategies", "deployment pipelines", "testing frameworks", "microservices", "event sourcing", "graph databases"][i % 10]
  } and how it relates to building production AI systems. The implementation involves ${
    ["TypeScript", "Python", "Rust", "Go", "Java"][i % 5]
  } with ${["PostgreSQL", "SQLite", "MongoDB", "Redis", "Qdrant"][i % 5]} as the backing store.`,
  category: (["task", "decision", "progress", "note", "fact"] as const)[i % 5],
}));

async function run(): Promise<BenchResult[]> {
  const results: BenchResult[] = [];

  // Start a session
  const session = await api("/api/v1/session/start", {
    body: { name: "bench-latency" },
  });
  if (session.status !== 200) throw new Error(`Failed to start session: ${JSON.stringify(session.data)}`);

  // --- Warmup ---
  for (let i = 0; i < CONFIG.warmupIterations; i++) {
    await api("/api/v1/context", {
      body: { key: `warmup-${i}`, value: `warmup value ${i}`, skipProactiveRecall: true },
    });
  }

  // --- SAVE latency ---
  const saveLatencies: number[] = [];
  for (const mem of SAMPLE_MEMORIES) {
    const { latencyMs } = await api("/api/v1/context", {
      body: { key: mem.key, value: mem.value, category: mem.category, skipProactiveRecall: true },
    });
    saveLatencies.push(latencyMs);
  }
  results.push(computeStats("context_save", saveLatencies));

  // --- GET (by key) latency ---
  const getLatencies: number[] = [];
  for (let i = 0; i < CONFIG.iterations; i++) {
    const key = SAMPLE_MEMORIES[i % SAMPLE_MEMORIES.length].key;
    const { latencyMs } = await api(`/api/v1/context/${encodeURIComponent(key)}`);
    getLatencies.push(latencyMs);
  }
  results.push(computeStats("context_get", getLatencies));

  // --- SEARCH latency ---
  const searchQueries = [
    "authentication security", "database performance", "API design patterns",
    "error handling best practices", "caching strategies", "deployment automation",
    "testing strategies", "microservices architecture", "event sourcing patterns",
    "graph database queries",
  ];
  const searchLatencies: number[] = [];
  for (let i = 0; i < CONFIG.iterations; i++) {
    const q = searchQueries[i % searchQueries.length];
    const { latencyMs } = await api("/api/v1/search", {
      method: "GET",
      body: undefined,
    });
    // Use GET with query params
    const searchRes = await api(`/api/v1/search?query=${encodeURIComponent(q)}&limit=10`);
    searchLatencies.push(searchRes.latencyMs);
  }
  results.push(computeStats("context_search", searchLatencies));

  // --- DELETE latency ---
  const deleteLatencies: number[] = [];
  for (const mem of SAMPLE_MEMORIES) {
    const { latencyMs } = await api(`/api/v1/context/${encodeURIComponent(mem.key)}`, {
      method: "DELETE",
    });
    deleteLatencies.push(latencyMs);
  }
  results.push(computeStats("context_delete", deleteLatencies));

  // End session
  await api("/api/v1/session/end", { body: {} });

  return results;
}

// Run
const results = await run();
console.log(JSON.stringify(results, null, 2));
