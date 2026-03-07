/**
 * Tests for CSRF middleware
 *
 * @module http/middleware/__tests__/csrf.test
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { csrfProtection, generateCsrfToken } from "../csrf.js";

/**
 * Helper to create a test app with CSRF protection.
 */
function createTestApp() {
  const app = new Hono();
  app.use("/*", csrfProtection());
  app.get("/form", (c) => c.json({ ok: true }));
  app.post("/submit", (c) => c.json({ ok: true }));
  app.put("/update", (c) => c.json({ ok: true }));
  app.delete("/remove", (c) => c.json({ ok: true }));
  return app;
}

/**
 * Extract CSRF cookie value from response Set-Cookie header.
 */
function extractCsrfCookie(res: Response): string | null {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = setCookie.match(/csrf_token=([^;]+)/);
  return match ? match[1] : null;
}

describe("CSRF Middleware", () => {
  describe("generateCsrfToken", () => {
    test("should generate a valid UUID token", () => {
      const token = generateCsrfToken();
      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");
      // UUID format check
      expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    test("should generate unique tokens", () => {
      const tokens = new Set(Array.from({ length: 10 }, () => generateCsrfToken()));
      expect(tokens.size).toBe(10);
    });
  });

  describe("GET requests", () => {
    test("should set CSRF token cookie on GET request", async () => {
      const app = createTestApp();
      const res = await app.request("/form");
      expect(res.status).toBe(200);

      const csrfToken = extractCsrfCookie(res);
      expect(csrfToken).toBeTruthy();
    });

    test("should set HttpOnly and SameSite=Strict on CSRF cookie", async () => {
      const app = createTestApp();
      const res = await app.request("/form");
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
    });
  });

  describe("POST without token", () => {
    test("should return 403 when POST has no CSRF token", async () => {
      const app = createTestApp();
      const res = await app.request("/submit", { method: "POST" });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Forbidden");
      expect(body.message).toContain("CSRF");
    });
  });

  describe("POST with matching header and cookie", () => {
    test("should pass when header and cookie CSRF tokens match", async () => {
      const app = createTestApp();

      // First GET to get a CSRF token
      const getRes = await app.request("/form");
      const csrfToken = extractCsrfCookie(getRes);
      expect(csrfToken).toBeTruthy();

      // POST with matching token in header and cookie
      const res = await app.request("/submit", {
        method: "POST",
        headers: {
          "x-csrf-token": csrfToken!,
          cookie: `csrf_token=${csrfToken}`,
        },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("POST with mismatched tokens", () => {
    test("should return 403 when header and cookie tokens do not match", async () => {
      const app = createTestApp();
      const res = await app.request("/submit", {
        method: "POST",
        headers: {
          "x-csrf-token": "token-aaa",
          cookie: "csrf_token=token-bbb",
        },
      });
      expect(res.status).toBe(403);
    });

    test("should return 403 when header is present but cookie is missing", async () => {
      const app = createTestApp();
      const res = await app.request("/submit", {
        method: "POST",
        headers: {
          "x-csrf-token": "token-aaa",
        },
      });
      expect(res.status).toBe(403);
    });

    test("should return 403 when cookie is present but header is missing", async () => {
      const app = createTestApp();
      const res = await app.request("/submit", {
        method: "POST",
        headers: {
          cookie: "csrf_token=token-aaa",
        },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("API key bypass", () => {
    test("should bypass CSRF when X-API-Key header is present", async () => {
      const app = createTestApp();
      const res = await app.request("/submit", {
        method: "POST",
        headers: {
          "x-api-key": "some-api-key",
        },
      });
      expect(res.status).toBe(200);
    });

    test("should bypass CSRF when Authorization Bearer header is present", async () => {
      const app = createTestApp();
      const res = await app.request("/submit", {
        method: "POST",
        headers: {
          authorization: "Bearer some-token",
        },
      });
      expect(res.status).toBe(200);
    });

    test("should NOT bypass for Authorization that is not Bearer", async () => {
      const app = createTestApp();
      const res = await app.request("/submit", {
        method: "POST",
        headers: {
          authorization: "Basic dXNlcjpwYXNz",
        },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("Other HTTP methods", () => {
    test("PUT should also require CSRF token", async () => {
      const app = createTestApp();
      const res = await app.request("/update", { method: "PUT" });
      expect(res.status).toBe(403);
    });

    test("DELETE should also require CSRF token", async () => {
      const app = createTestApp();
      const res = await app.request("/remove", { method: "DELETE" });
      expect(res.status).toBe(403);
    });

    test("HEAD should not require CSRF token (safe method)", async () => {
      const app = createTestApp();
      const res = await app.request("/form", { method: "HEAD" });
      // HEAD may return 200 or 404 depending on route match, but not 403
      expect(res.status).not.toBe(403);
    });
  });
});
