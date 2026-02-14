#!/usr/bin/env bun
/**
 * Benchmark: Search Accuracy (Recall@K)
 * Stores known facts and measures how well search retrieves them at various K values.
 */
import { CONFIG, api } from "./config.ts";

interface AccuracyResult {
  name: string;
  k: number;
  recall: number;
  precision: number;
  queriesRun: number;
}

// Ground truth: each query should find these specific keys
const GROUND_TRUTH: { query: string; expectedKeys: string[] }[] = [
  {
    query: "user authentication and login security",
    expectedKeys: ["auth-jwt-tokens", "auth-oauth-flow", "auth-session-mgmt"],
  },
  {
    query: "database query optimization and indexing",
    expectedKeys: ["db-indexing", "db-query-plans", "db-connection-pool"],
  },
  {
    query: "error handling and resilience patterns",
    expectedKeys: ["error-retry-logic", "error-circuit-breaker", "error-graceful-degradation"],
  },
  {
    query: "API rate limiting and throttling",
    expectedKeys: ["api-rate-limit", "api-throttle", "api-quota-mgmt"],
  },
  {
    query: "caching strategies and invalidation",
    expectedKeys: ["cache-redis-strategy", "cache-invalidation", "cache-ttl-policy"],
  },
];

const SEED_MEMORIES: { key: string; value: string }[] = [
  // Auth cluster
  { key: "auth-jwt-tokens", value: "JWT tokens are used for stateless authentication. Access tokens expire in 15 minutes, refresh tokens in 7 days. Store refresh tokens in httpOnly cookies." },
  { key: "auth-oauth-flow", value: "OAuth 2.0 authorization code flow with PKCE for public clients. Redirect URI validation prevents open redirect attacks in login security." },
  { key: "auth-session-mgmt", value: "Server-side session management using Redis for session storage. Sessions expire after 30 minutes of inactivity. Login requires MFA for admin users." },
  // DB cluster
  { key: "db-indexing", value: "Create composite indexes for frequently queried columns. Use EXPLAIN ANALYZE to verify query plans use indexes. B-tree indexes for range queries, hash indexes for equality." },
  { key: "db-query-plans", value: "Database query optimization requires analyzing execution plans. Use EXPLAIN to identify sequential scans and replace with index scans where possible." },
  { key: "db-connection-pool", value: "Connection pooling with pgbouncer. Max pool size 20, idle timeout 300s. Database connection reuse reduces latency by 60%." },
  // Error cluster
  { key: "error-retry-logic", value: "Exponential backoff with jitter for retry logic. Max 3 retries with base delay 100ms. Error handling should distinguish transient from permanent failures." },
  { key: "error-circuit-breaker", value: "Circuit breaker pattern: CLOSED (normal), OPEN (failing, reject fast), HALF-OPEN (probe). Threshold: 5 failures in 60s opens circuit for resilience." },
  { key: "error-graceful-degradation", value: "Graceful degradation: when downstream service fails, return cached data or reduced functionality. Error handling must preserve user experience." },
  // API cluster
  { key: "api-rate-limit", value: "API rate limiting using token bucket algorithm. 100 requests/minute per API key. Return 429 with Retry-After header when rate limit exceeded." },
  { key: "api-throttle", value: "Request throttling at the API gateway level. Burst allowance of 20 requests, sustained rate of 10 req/s. Throttle responses include backoff hints." },
  { key: "api-quota-mgmt", value: "API quota management: free tier 1000 calls/day, pro tier 50000/day. Track usage per API key with Redis counters. Rate limiting enforced at edge." },
  // Cache cluster
  { key: "cache-redis-strategy", value: "Redis caching strategy: cache-aside pattern for read-heavy workloads. Set TTL based on data volatility. Cache warming on deployment." },
  { key: "cache-invalidation", value: "Cache invalidation strategies: TTL-based expiry, event-driven invalidation via pub/sub, and versioned cache keys for atomic updates." },
  { key: "cache-ttl-policy", value: "TTL policy: user profiles 5min, product catalog 1hr, static config 24hr. Caching reduces database load by 80% for read-heavy endpoints." },
  // Noise entries
  { key: "deploy-ci-cd", value: "CI/CD pipeline uses GitHub Actions. Build, test, deploy stages. Blue-green deployment with automatic rollback on health check failure." },
  { key: "monitoring-alerts", value: "Prometheus metrics with Grafana dashboards. Alert on p99 latency > 500ms, error rate > 1%, CPU > 80%." },
  { key: "testing-unit", value: "Unit tests with Jest. Integration tests with testcontainers. Minimum 80% code coverage enforced in CI pipeline." },
];

async function run(): Promise<AccuracyResult[]> {
  const results: AccuracyResult[] = [];

  // Start session and seed memories
  await api("/api/v1/session/start", { body: { name: "bench-accuracy" } });

  for (const mem of SEED_MEMORIES) {
    await api("/api/v1/context", {
      body: { key: mem.key, value: mem.value, skipProactiveRecall: true },
    });
  }

  // Test recall at various K values
  for (const k of CONFIG.searchK) {
    let totalRecall = 0;
    let totalPrecision = 0;

    for (const gt of GROUND_TRUTH) {
      const res = await api(`/api/v1/search?query=${encodeURIComponent(gt.query)}&limit=${k}`);
      const returnedKeys: string[] = (res.data?.data ?? []).map((r: any) => r.memory?.key ?? r.key);

      const relevant = gt.expectedKeys.filter((ek) => returnedKeys.includes(ek)).length;
      const recall = relevant / gt.expectedKeys.length;
      const precision = returnedKeys.length > 0 ? relevant / returnedKeys.length : 0;

      totalRecall += recall;
      totalPrecision += precision;
    }

    results.push({
      name: `recall@${k}`,
      k,
      recall: Math.round((totalRecall / GROUND_TRUTH.length) * 1000) / 1000,
      precision: Math.round((totalPrecision / GROUND_TRUTH.length) * 1000) / 1000,
      queriesRun: GROUND_TRUTH.length,
    });
  }

  await api("/api/v1/session/end", { body: {} });
  return results;
}

const results = await run();
console.log(JSON.stringify(results, null, 2));
