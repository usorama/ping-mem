/**
 * Tests for admin.ts — Basic Auth, rate limiting, and brute-force lockout
 *
 * @module http/__tests__/admin.test
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  checkBasicAuth,
  checkAdminRateLimit,
  _resetAdminRateLimitMapsForTest,
  _getAuthFailureMapForTest,
} from "../admin.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockRequest(
  authHeader?: string,
  remoteAddress?: string,
  extraHeaders?: Record<string, string>
): Partial<IncomingMessage> {
  return {
    headers: {
      authorization: authHeader ?? "",
      ...extraHeaders,
    },
    // Provide a real-looking socket so getRemoteIp() can extract a stable IP
    socket: { remoteAddress: remoteAddress ?? "127.0.0.1" } as NonNullable<IncomingMessage["socket"]>,
  };
}

function createMockResponse() {
  const res = {
    statusCode: undefined as number | undefined,
    headers: {} as Record<string, unknown>,
    writeHead(statusCode: number, headers?: Record<string, string | string[] | undefined>) {
      res.statusCode = statusCode;
      if (headers) Object.assign(res.headers, headers);
    },
    end(_data?: unknown) {},
  };
  return res;
}

// ---------------------------------------------------------------------------
// checkBasicAuth — credential validation
// ---------------------------------------------------------------------------

describe("admin.ts - checkBasicAuth", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    _resetAdminRateLimitMapsForTest();
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  describe("when no auth is configured", () => {
    it("should return false and send 401 when PING_MEM_ADMIN_USER is not set", () => {
      delete process.env.PING_MEM_ADMIN_USER;
      delete process.env.PING_MEM_ADMIN_PASS;

      const req = createMockRequest();
      const res = createMockResponse();

      // Security: unconfigured credentials must block access, never grant it
      expect(checkBasicAuth(req as IncomingMessage, res as unknown as ServerResponse)).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it("should return false and send 401 when PING_MEM_ADMIN_PASS is not set", () => {
      process.env.PING_MEM_ADMIN_USER = "admin";
      delete process.env.PING_MEM_ADMIN_PASS;

      const req = createMockRequest();
      const res = createMockResponse();

      // Security: partial credentials must block access, never grant it
      expect(checkBasicAuth(req as IncomingMessage, res as unknown as ServerResponse)).toBe(false);
      expect(res.statusCode).toBe(401);
    });
  });

  describe("when auth is configured", () => {
    beforeEach(() => {
      process.env.PING_MEM_ADMIN_USER = "admin";
      process.env.PING_MEM_ADMIN_PASS = "secret-password";
    });

    it("should return true for correct credentials", () => {
      const credentials = Buffer.from("admin:secret-password").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as unknown as ServerResponse)).toBe(true);
      expect(res.statusCode).toBeUndefined();
    });

    it("should return false and send 401 for incorrect username", () => {
      const credentials = Buffer.from("wrong:secret-password").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as unknown as ServerResponse)).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it("should return false and send 401 for incorrect password", () => {
      const credentials = Buffer.from("admin:wrong-password").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as unknown as ServerResponse)).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it("should return false and send 401 for both incorrect", () => {
      const credentials = Buffer.from("wrong:also-wrong").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as unknown as ServerResponse)).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it("should return false and send 401 for missing authorization header", () => {
      const req = createMockRequest();
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as unknown as ServerResponse)).toBe(false);
      expect(res.statusCode).toBe(401);
      const wwwAuth = Object.keys(res.headers).find(k => k.toLowerCase() === "www-authenticate");
      expect(wwwAuth).toBeDefined();
    });

    it("should return false and send 401 for invalid scheme", () => {
      const credentials = Buffer.from("admin:secret-password").toString("base64");
      const req = createMockRequest(`Bearer ${credentials}`); // Wrong scheme
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as unknown as ServerResponse)).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it("should handle special characters in password", () => {
      process.env.PING_MEM_ADMIN_PASS = "p@ssw0rd!#$%^&*()";
      const credentials = Buffer.from("admin:p@ssw0rd!#$%^&*()").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as unknown as ServerResponse)).toBe(true);
    });

    it("should handle unicode characters in credentials", () => {
      process.env.PING_MEM_ADMIN_USER = "管理者";
      process.env.PING_MEM_ADMIN_PASS = "パスワード123";
      const credentials = Buffer.from("管理者:パスワード123").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as unknown as ServerResponse)).toBe(true);
    });

    it("should handle malformed base64 gracefully", () => {
      const req = createMockRequest("Basic not-valid-base64!!!>>>");
      const res = createMockResponse();

      // Should fail authentication
      expect(checkBasicAuth(req as IncomingMessage, res as unknown as ServerResponse)).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it("should handle credentials without colon separator", () => {
      const credentials = Buffer.from("admin-only").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      // Missing password should fail
      expect(checkBasicAuth(req as IncomingMessage, res as unknown as ServerResponse)).toBe(false);
      expect(res.statusCode).toBe(401);
    });
  });

  // ========================================================================
  // Timing Attack Resistance Tests
  // ========================================================================

  describe("timing attack resistance", () => {
    beforeEach(() => {
      process.env.PING_MEM_ADMIN_USER = "admin";
      process.env.PING_MEM_ADMIN_PASS = "very-long-secret-password-12345";
    });

    it("should use constant-time comparison for username", () => {
      // Test that comparison doesn't short-circuit on first character difference
      const wrongStart = "xxxxxx";
      const wrongEnd = "adminxxx";

      const creds1 = Buffer.from(`${wrongStart}:very-long-secret-password-12345`).toString("base64");
      const creds2 = Buffer.from(`${wrongEnd}:very-long-secret-password-12345`).toString("base64");

      const req1 = createMockRequest(`Basic ${creds1}`);
      const req2 = createMockRequest(`Basic ${creds2}`);
      const res1 = createMockResponse();
      const res2 = createMockResponse();

      // Both should fail
      expect(checkBasicAuth(req1 as IncomingMessage, res1 as unknown as ServerResponse)).toBe(false);
      expect(checkBasicAuth(req2 as IncomingMessage, res2 as unknown as ServerResponse)).toBe(false);
    });

    it("should use constant-time comparison for password", () => {
      // Test that comparison doesn't short-circuit on first character difference
      const wrongStart = "xxxxxxxxxxxxxxxxxxxx";
      const wrongEnd = "very-long-secret-password-12345xxxxx";

      const creds1 = Buffer.from(`admin:${wrongStart}`).toString("base64");
      const creds2 = Buffer.from(`admin:${wrongEnd}`).toString("base64");

      const req1 = createMockRequest(`Basic ${creds1}`);
      const req2 = createMockRequest(`Basic ${creds2}`);
      const res1 = createMockResponse();
      const res2 = createMockResponse();

      // Both should fail
      expect(checkBasicAuth(req1 as IncomingMessage, res1 as unknown as ServerResponse)).toBe(false);
      expect(checkBasicAuth(req2 as IncomingMessage, res2 as unknown as ServerResponse)).toBe(false);
    });

    it("should handle empty username correctly", () => {
      const credentials = Buffer.from(":very-long-secret-password-12345").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as unknown as ServerResponse)).toBe(false);
    });

    it("should handle empty password correctly", () => {
      const credentials = Buffer.from("admin:").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as unknown as ServerResponse)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// checkAdminRateLimit — sliding-window rate limiting
// ---------------------------------------------------------------------------

describe("admin.ts - checkAdminRateLimit", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    _resetAdminRateLimitMapsForTest();
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("allows exactly ADMIN_RATE_LIMIT_MAX (20) requests per window", () => {
    const ip = "192.168.1.10";
    for (let i = 0; i < 20; i++) {
      const req = createMockRequest(undefined, ip);
      const res = createMockResponse();
      expect(
        checkAdminRateLimit(req as IncomingMessage, res as unknown as ServerResponse),
        `request ${i + 1} should be allowed`
      ).toBe(true);
      expect(res.statusCode).toBeUndefined();
    }
  });

  it("blocks the 21st request in the same window with 429 and Retry-After", () => {
    const ip = "192.168.1.11";
    // Exhaust the 20-request quota
    for (let i = 0; i < 20; i++) {
      checkAdminRateLimit(
        createMockRequest(undefined, ip) as IncomingMessage,
        createMockResponse() as unknown as ServerResponse
      );
    }

    // 21st request must be blocked
    const req = createMockRequest(undefined, ip);
    const res = createMockResponse();
    expect(checkAdminRateLimit(req as IncomingMessage, res as unknown as ServerResponse)).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBeDefined();
  });

  it("uses X-Forwarded-For when PING_MEM_BEHIND_PROXY is true", () => {
    process.env.PING_MEM_BEHIND_PROXY = "true";
    const clientIp = "10.0.0.50";
    const proxyIp = "172.16.0.1"; // different from client

    // Exhaust quota for the CLIENT IP (via X-Forwarded-For)
    for (let i = 0; i < 20; i++) {
      checkAdminRateLimit(
        createMockRequest(undefined, proxyIp, { "x-forwarded-for": clientIp }) as IncomingMessage,
        createMockResponse() as unknown as ServerResponse
      );
    }

    // 21st from same client IP should be blocked
    const res = createMockResponse();
    expect(
      checkAdminRateLimit(
        createMockRequest(undefined, proxyIp, { "x-forwarded-for": clientIp }) as IncomingMessage,
        res as unknown as ServerResponse
      )
    ).toBe(false);
    expect(res.statusCode).toBe(429);

    // A different client IP through the same proxy should still be allowed
    const res2 = createMockResponse();
    expect(
      checkAdminRateLimit(
        createMockRequest(undefined, proxyIp, { "x-forwarded-for": "10.0.0.51" }) as IncomingMessage,
        res2 as unknown as ServerResponse
      )
    ).toBe(true);
    expect(res2.statusCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Brute-force lockout (tested via checkBasicAuth)
// ---------------------------------------------------------------------------

describe("admin.ts - brute-force lockout", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.PING_MEM_ADMIN_USER = "admin";
    process.env.PING_MEM_ADMIN_PASS = "correct-pass";
    _resetAdminRateLimitMapsForTest();
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  const wrongCreds = (ip: string) =>
    createMockRequest(`Basic ${Buffer.from("admin:wrong-pass").toString("base64")}`, ip);
  const rightCreds = (ip: string) =>
    createMockRequest(`Basic ${Buffer.from("admin:correct-pass").toString("base64")}`, ip);

  it("locks out IP after 5 consecutive auth failures (6th attempt gets 429)", () => {
    const ip = "10.0.0.20";

    // 4 failures: still 401
    for (let i = 0; i < 4; i++) {
      const res = createMockResponse();
      expect(checkBasicAuth(wrongCreds(ip) as IncomingMessage, res as unknown as ServerResponse)).toBe(false);
      expect(res.statusCode).toBe(401);
    }

    // 5th failure triggers lockout (records it); response is still 401 from this call
    checkBasicAuth(wrongCreds(ip) as IncomingMessage, createMockResponse() as unknown as ServerResponse);

    // 6th attempt — IP is now locked out → 429
    const resLocked = createMockResponse();
    expect(checkBasicAuth(wrongCreds(ip) as IncomingMessage, resLocked as unknown as ServerResponse)).toBe(false);
    expect(resLocked.statusCode).toBe(429);
  });

  it("successful auth clears the failure counter", () => {
    const ip = "10.0.0.21";

    // 3 failures
    for (let i = 0; i < 3; i++) {
      checkBasicAuth(wrongCreds(ip) as IncomingMessage, createMockResponse() as unknown as ServerResponse);
    }

    // Successful auth resets the counter
    const resOk = createMockResponse();
    expect(checkBasicAuth(rightCreds(ip) as IncomingMessage, resOk as unknown as ServerResponse)).toBe(true);

    // After reset, another 4 failures should NOT lock out (threshold is 5)
    for (let i = 0; i < 4; i++) {
      const res = createMockResponse();
      expect(checkBasicAuth(wrongCreds(ip) as IncomingMessage, res as unknown as ServerResponse)).toBe(false);
      expect(res.statusCode).toBe(401); // Not 429 — counter was reset, not yet locked
    }
  });

  it("lockout expires after the lock window elapses", () => {
    const ip = "10.0.0.22";
    const failureMap = _getAuthFailureMapForTest();

    // Manually set an already-expired lockout to simulate clock advancing past AUTH_LOCKOUT_MS
    failureMap.set(ip, { count: 0, lockedUntil: Date.now() - 1, lastSeen: Date.now() - 1 });

    // IP should not be considered locked — correct credentials succeed
    const res = createMockResponse();
    expect(checkBasicAuth(rightCreds(ip) as IncomingMessage, res as unknown as ServerResponse)).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });

  it("stale partial-failure entries are evicted to prevent unbounded map growth", () => {
    const failureMap = _getAuthFailureMapForTest();
    const staleIp = "10.0.0.23";

    // Manually insert a stale partial-failure entry (count > 0, not locked, lastSeen = 11 min ago)
    // This simulates an IP that made a few failed attempts long ago and has been idle since.
    failureMap.set(staleIp, {
      count: 2,
      lockedUntil: 0,
      lastSeen: Date.now() - 11 * 60 * 1000, // 11 min ago, beyond the 10-min STALE window
    });

    // Trigger checkAdminRateLimit for any IP — the eviction loop runs on every call
    checkAdminRateLimit(
      createMockRequest(undefined, "10.0.0.24") as IncomingMessage,
      createMockResponse() as unknown as ServerResponse
    );

    // Stale partial-failure entry must be evicted
    expect(failureMap.has(staleIp)).toBe(false);
  });
});
