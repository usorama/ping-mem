#!/usr/bin/env bun
/**
 * Benchmark: Concurrent Operations Throughput
 * Measures how many ops/sec ping-mem handles under concurrent load.
 */
import { CONFIG, api, computeStats, type BenchResult } from "./config.ts";

async function run(): Promise<{ results: BenchResult[]; throughput: Record<string, number> }> {
  const results: BenchResult[] = [];
  const throughput: Record<string, number> = {};

  // Start session
  await api("/api/v1/session/start", { body: { name: "bench-concurrency" } });

  // Seed some data first
  for (let i = 0; i < 50; i++) {
    await api("/api/v1/context", {
      body: { key: `conc-seed-${i}`, value: `Seed data for concurrency test item ${i}`, skipProactiveRecall: true },
    });
  }

  // --- Concurrent SAVES ---
  const concLevels = [1, 5, 10, 20, 50];
  for (const conc of concLevels) {
    const totalOps = Math.max(conc * 5, 50);
    const latencies: number[] = [];
    const startTime = performance.now();

    const batches = Math.ceil(totalOps / conc);
    for (let b = 0; b < batches; b++) {
      const promises = Array.from({ length: Math.min(conc, totalOps - b * conc) }, (_, i) => {
        const idx = b * conc + i;
        return api("/api/v1/context", {
          body: {
            key: `conc-save-${conc}-${idx}`,
            value: `Concurrent write test with concurrency=${conc}, batch=${b}, index=${idx}`,
            skipProactiveRecall: true,
          },
        }).then((r) => latencies.push(r.latencyMs));
      });
      await Promise.all(promises);
    }

    const elapsed = performance.now() - startTime;
    throughput[`save_c${conc}`] = Math.round((totalOps / elapsed) * 1000);
    results.push(computeStats(`save_concurrent_${conc}`, latencies));
  }

  // --- Concurrent READS ---
  for (const conc of concLevels) {
    const totalOps = Math.max(conc * 5, 50);
    const latencies: number[] = [];
    const startTime = performance.now();

    const batches = Math.ceil(totalOps / conc);
    for (let b = 0; b < batches; b++) {
      const promises = Array.from({ length: Math.min(conc, totalOps - b * conc) }, (_, i) => {
        const idx = (b * conc + i) % 50;
        return api(`/api/v1/context/conc-seed-${idx}`).then((r) => latencies.push(r.latencyMs));
      });
      await Promise.all(promises);
    }

    const elapsed = performance.now() - startTime;
    throughput[`read_c${conc}`] = Math.round((totalOps / elapsed) * 1000);
    results.push(computeStats(`read_concurrent_${conc}`, latencies));
  }

  await api("/api/v1/session/end", { body: {} });
  return { results, throughput };
}

const { results, throughput } = await run();
console.log(JSON.stringify({ results, throughput }, null, 2));
