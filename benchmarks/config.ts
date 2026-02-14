/**
 * Benchmark configuration
 */
export const CONFIG = {
  baseUrl: process.env.PING_MEM_URL ?? "http://localhost:3003",
  iterations: parseInt(process.env.BENCH_ITERATIONS ?? "100"),
  warmupIterations: 10,
  concurrency: parseInt(process.env.BENCH_CONCURRENCY ?? "10"),
  searchK: [1, 5, 10, 20],
};

export interface BenchResult {
  name: string;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  count: number;
  opsPerSec: number;
}

export function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function computeStats(name: string, latencies: number[]): BenchResult {
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  return {
    name,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean: Math.round(mean * 100) / 100,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    count: sorted.length,
    opsPerSec: Math.round(1000 / mean),
  };
}

export async function api(
  path: string,
  opts: { method?: string; body?: unknown; sessionId?: string } = {}
): Promise<{ status: number; data: any; latencyMs: number }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.sessionId) headers["X-Session-ID"] = opts.sessionId;

  const start = performance.now();
  const res = await fetch(`${CONFIG.baseUrl}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const latencyMs = performance.now() - start;
  const data = await res.json().catch(() => null);
  return { status: res.status, data, latencyMs: Math.round(latencyMs * 100) / 100 };
}

export function formatTable(results: BenchResult[]): string {
  const header = "| Benchmark | p50 (ms) | p95 (ms) | p99 (ms) | Mean (ms) | Min (ms) | Max (ms) | Ops/sec |";
  const sep = "|-----------|----------|----------|----------|-----------|----------|----------|---------|";
  const rows = results.map(
    (r) =>
      `| ${r.name} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.mean} | ${r.min} | ${r.max} | ${r.opsPerSec} |`
  );
  return [header, sep, ...rows].join("\n");
}
