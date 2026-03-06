#!/usr/bin/env bun
/**
 * Run all benchmarks and output combined results.
 */
import { formatTable, type BenchResult } from "./config.ts";

async function runBench(name: string, script: string): Promise<any> {
  console.error(`\n⏱️  Running ${name}...`);
  const proc = Bun.spawn(["bun", "run", script], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`❌ ${name} failed (exit ${code}):\n${stderr}`);
    return null;
  }
  if (stderr) console.error(stderr.trim());
  try {
    return JSON.parse(stdout.trim());
  } catch {
    console.error(`❌ ${name} produced invalid JSON:\n${stdout}`);
    return null;
  }
}

const allResults: Record<string, any> = {};

// 1. Latency
const latency = await runBench("Latency", "bench-latency.ts");
if (latency) allResults.latency = latency;

// 2. Search Accuracy
const accuracy = await runBench("Search Accuracy", "bench-search-accuracy.ts");
if (accuracy) allResults.searchAccuracy = accuracy;

// 3. Concurrency
const concurrency = await runBench("Concurrency", "bench-concurrency.ts");
if (concurrency) allResults.concurrency = concurrency;

// 4. Cold Start
const coldStart = await runBench("Cold Start", "bench-cold-start.ts");
if (coldStart) allResults.coldStart = coldStart;

// 5. Memory Footprint
const footprint = await runBench("Memory Footprint", "bench-memory-footprint.ts");
if (footprint) allResults.memoryFootprint = footprint;

// --- Print summary ---
console.error("\n" + "=".repeat(80));
console.error("📊 BENCHMARK RESULTS SUMMARY");
console.error("=".repeat(80));

if (allResults.latency) {
  console.error("\n### Latency (p50/p95/p99 ms)");
  console.error(formatTable(allResults.latency));
}

if (allResults.coldStart) {
  console.error("\n### Cold Start");
  console.error(formatTable(allResults.coldStart));
}

if (allResults.searchAccuracy) {
  console.error("\n### Search Accuracy");
  for (const r of allResults.searchAccuracy) {
    console.error(`  recall@${r.k}: ${(r.recall * 100).toFixed(1)}%  precision: ${(r.precision * 100).toFixed(1)}%`);
  }
}

if (allResults.concurrency) {
  console.error("\n### Concurrency Throughput (ops/sec)");
  for (const [k, v] of Object.entries(allResults.concurrency.throughput ?? {})) {
    console.error(`  ${k}: ${v} ops/sec`);
  }
}

if (allResults.memoryFootprint) {
  const mf = allResults.memoryFootprint;
  console.error("\n### Memory Footprint & Compression");
  console.error(`  Memories stored: ${mf.totalMemoriesStored}`);
  console.error(`  Avg value length: ${mf.avgValueLength} chars`);
  if (mf.contextCompressionScenario) {
    const cs = mf.contextCompressionScenario;
    console.error(`  Compression ratio: ${cs.compressionRatio}x (${cs.rawContextTokens} → ~${cs.estimatedRetrievedTokens} tokens)`);
  }
}

// Output full JSON for report generation
console.log(JSON.stringify(allResults, null, 2));
