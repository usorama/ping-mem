#!/usr/bin/env bun
/**
 * Benchmark: Cold Start Time & Session Overhead
 * Measures time to start a session, first operation, and session teardown.
 */
import { CONFIG, api, computeStats, type BenchResult } from "./config.ts";

async function run(): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const iterations = 20; // Fewer iterations since each creates a full session

  // --- Session start latency ---
  const startLatencies: number[] = [];
  const sessionIds: string[] = [];
  for (let i = 0; i < iterations; i++) {
    const { latencyMs, data } = await api("/api/v1/session/start", {
      body: { name: `cold-start-${i}` },
    });
    startLatencies.push(latencyMs);
    sessionIds.push(data?.data?.id);
    // End session immediately
    await api("/api/v1/session/end", { body: {} });
  }
  results.push(computeStats("session_start", startLatencies));

  // --- First operation after session start (cold path) ---
  const firstOpLatencies: number[] = [];
  for (let i = 0; i < iterations; i++) {
    await api("/api/v1/session/start", { body: { name: `first-op-${i}` } });
    const { latencyMs } = await api("/api/v1/context", {
      body: { key: `first-op-${i}`, value: "First operation after cold start", skipProactiveRecall: true },
    });
    firstOpLatencies.push(latencyMs);
    await api("/api/v1/session/end", { body: {} });
  }
  results.push(computeStats("first_op_after_start", firstOpLatencies));

  // --- Session end latency ---
  const endLatencies: number[] = [];
  for (let i = 0; i < iterations; i++) {
    await api("/api/v1/session/start", { body: { name: `end-bench-${i}` } });
    await api("/api/v1/context", {
      body: { key: `end-${i}`, value: "data", skipProactiveRecall: true },
    });
    const { latencyMs } = await api("/api/v1/session/end", { body: {} });
    endLatencies.push(latencyMs);
  }
  results.push(computeStats("session_end", endLatencies));

  // --- Health check (baseline network latency) ---
  const healthLatencies: number[] = [];
  for (let i = 0; i < 50; i++) {
    const { latencyMs } = await api("/health");
    healthLatencies.push(latencyMs);
  }
  results.push(computeStats("health_check", healthLatencies));

  return results;
}

const results = await run();
console.log(JSON.stringify(results, null, 2));
