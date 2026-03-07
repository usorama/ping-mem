/**
 * Tests for rate-limit middleware
 *
 * @module http/middleware/__tests__/rate-limit.test
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { rateLimiter } from "../rate-limit.js";

/**
 * Helper to create a test Hono app with rate limiting applied.
 * Uses TRUST_PROXY=true + x-forwarded-for to control the perceived IP.
 */
function createTestApp(options: {
  maxRequests: number;
  windowMs: number;
  maxMapSize?: number;
}) {
  const app = new Hono();
  // Use a unique name per test to avoid cross-test contamination
  const name = `test-${Date.now()}-${Math.random()}`;
  app.use("/*", rateLimiter({ name, ...options }));
  app.get("/test", (c) => c.json({ ok: true }));
  app.post("/test", (c) => c.json({ ok: true }));
  return app;
}

describe("rateLimiter", () => {
  // Enable TRUST_PROXY so we can set IP via x-forwarded-for header
  beforeEach(() => {
    process.env.TRUST_PROXY = "true";
  });

  test("should allow requests under the limit", async () => {
    const app = createTestApp({ maxRequests: 5, windowMs: 60000 });
    const res = await app.request("/test", {
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    expect(res.status).toBe(200);
  });

  test("should allow requests at the limit", async () => {
    const app = createTestApp({ maxRequests: 3, windowMs: 60000 });
    const ip = "10.0.0.2";
    const headers = { "x-forwarded-for": ip };

    // Send exactly maxRequests requests
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/test", { headers });
      expect(res.status).toBe(200);
    }
  });

  test("should return 429 when exceeding the limit", async () => {
    const app = createTestApp({ maxRequests: 2, windowMs: 60000 });
    const ip = "10.0.0.3";
    const headers = { "x-forwarded-for": ip };

    // First two should succeed
    await app.request("/test", { headers });
    await app.request("/test", { headers });

    // Third should be rate limited
    const res = await app.request("/test", { headers });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Too Many Requests");
  });

  test("should return proper error body on 429", async () => {
    const app = createTestApp({ maxRequests: 1, windowMs: 60000 });
    const ip = "10.0.0.4";
    const headers = { "x-forwarded-for": ip };

    await app.request("/test", { headers });
    const res = await app.request("/test", { headers });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Too Many Requests");
    expect(body.message).toBe("Rate limit exceeded");
  });

  test("should isolate rate limits per IP", async () => {
    const app = createTestApp({ maxRequests: 1, windowMs: 60000 });

    // IP A: use up its limit
    const resA1 = await app.request("/test", {
      headers: { "x-forwarded-for": "10.0.0.5" },
    });
    expect(resA1.status).toBe(200);

    const resA2 = await app.request("/test", {
      headers: { "x-forwarded-for": "10.0.0.5" },
    });
    expect(resA2.status).toBe(429);

    // IP B: should still be allowed
    const resB1 = await app.request("/test", {
      headers: { "x-forwarded-for": "10.0.0.6" },
    });
    expect(resB1.status).toBe(200);
  });

  test("should reset after window expires", async () => {
    // Use a very short window
    const app = createTestApp({ maxRequests: 1, windowMs: 50 });
    const ip = "10.0.0.7";
    const headers = { "x-forwarded-for": ip };

    await app.request("/test", { headers });
    const blocked = await app.request("/test", { headers });
    expect(blocked.status).toBe(429);

    // Wait for window to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    const afterReset = await app.request("/test", { headers });
    expect(afterReset.status).toBe(200);
  });

  test("should evict expired entries when map exceeds maxMapSize", async () => {
    // Create app with very small maxMapSize so eviction triggers
    const app = createTestApp({ maxRequests: 100, windowMs: 10, maxMapSize: 1 });

    // Send request from IP 1
    await app.request("/test", {
      headers: { "x-forwarded-for": "10.0.0.10" },
    });

    // Wait for the window to expire for IP 1
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Send request from IP 2 — this should trigger eviction of expired IP 1
    const res = await app.request("/test", {
      headers: { "x-forwarded-for": "10.0.0.11" },
    });
    expect(res.status).toBe(200);

    // IP 1 should have been evicted and gets a fresh window
    const res2 = await app.request("/test", {
      headers: { "x-forwarded-for": "10.0.0.10" },
    });
    expect(res2.status).toBe(200);
  });

  test("should work with POST requests", async () => {
    const app = createTestApp({ maxRequests: 1, windowMs: 60000 });
    const ip = "10.0.0.12";
    const headers = { "x-forwarded-for": ip };

    const res1 = await app.request("/test", { method: "POST", headers });
    expect(res1.status).toBe(200);

    const res2 = await app.request("/test", { method: "POST", headers });
    expect(res2.status).toBe(429);
  });
});
