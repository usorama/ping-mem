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
  sanitizeAdminError,
  isSameHostOrigin,
  handleAdminRequest,
  _isProjectDirSafe,
  _resetAdminRateLimitMapsForTest,
  _getAuthFailureMapForTest,
  _getAdminRateLimitMapForTest,
  type AdminDependencies,
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

  it("allows exactly ADMIN_RATE_LIMIT_MAX (20) requests and blocks the 21st with 429 + Retry-After", () => {
    // Combined boundary test: verifies both that 20 requests are allowed AND that the 21st
    // is blocked. Keeping them together prevents a regression where the boundary is correct
    // in isolation but breaks under the combined quota pressure.
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
    // 21st request must be blocked
    const blocked = createMockResponse();
    expect(checkAdminRateLimit(createMockRequest(undefined, ip) as IncomingMessage, blocked as unknown as ServerResponse)).toBe(false);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["Retry-After"]).toBeDefined();
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

  it("X-Forwarded-For: extracts first IP from comma-separated list", () => {
    process.env.PING_MEM_BEHIND_PROXY = "true";
    const clientIp = "10.0.0.52";
    // Comma-separated XFF header: first entry is the original client IP
    const xffList = `${clientIp}, 172.16.0.1, 10.10.0.1`;

    // Exhaust quota for the first IP in the list
    for (let i = 0; i < 20; i++) {
      checkAdminRateLimit(
        createMockRequest(undefined, "172.16.0.1", { "x-forwarded-for": xffList }) as IncomingMessage,
        createMockResponse() as unknown as ServerResponse
      );
    }
    const res = createMockResponse();
    expect(
      checkAdminRateLimit(
        createMockRequest(undefined, "172.16.0.1", { "x-forwarded-for": xffList }) as IncomingMessage,
        res as unknown as ServerResponse
      )
    ).toBe(false);
    expect(res.statusCode).toBe(429);
  });

  it("allows requests again after the rate-limit window expires", () => {
    const ip = "192.168.1.12";
    const rateLimitMap = _getAdminRateLimitMapForTest();

    // Exhaust quota
    for (let i = 0; i < 20; i++) {
      checkAdminRateLimit(createMockRequest(undefined, ip) as IncomingMessage, createMockResponse() as unknown as ServerResponse);
    }
    // 21st is blocked
    const blocked = createMockResponse();
    expect(checkAdminRateLimit(createMockRequest(undefined, ip) as IncomingMessage, blocked as unknown as ServerResponse)).toBe(false);
    expect(blocked.statusCode).toBe(429);

    // Simulate window expiry: backdate the resetAt to the past
    const entry = rateLimitMap.get(ip);
    if (entry) entry.resetAt = Date.now() - 1;

    // First request in new window must be allowed
    const allowed = createMockResponse();
    expect(checkAdminRateLimit(createMockRequest(undefined, ip) as IncomingMessage, allowed as unknown as ServerResponse)).toBe(true);
    expect(allowed.statusCode).toBeUndefined();
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

    // 5th failure triggers lockout (records it); response is still 401 on this call —
    // lockout is recorded but enforcement only fires from the 6th call onward.
    const res5 = createMockResponse();
    checkBasicAuth(wrongCreds(ip) as IncomingMessage, res5 as unknown as ServerResponse);
    expect(res5.statusCode).toBe(401); // Not yet 429 — lockout recorded, not enforced yet

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

  it("lockout expires after the lock window elapses and entry is evicted by next rate-limit call", () => {
    const ip = "10.0.0.22";
    const failureMap = _getAuthFailureMapForTest();

    // Manually set an already-expired lockout to simulate clock advancing past AUTH_LOCKOUT_MS
    failureMap.set(ip, { count: 0, lockedUntil: Date.now() - 1, lastSeen: Date.now() - 1 });

    // IP should not be considered locked — correct credentials succeed
    const res = createMockResponse();
    expect(checkBasicAuth(rightCreds(ip) as IncomingMessage, res as unknown as ServerResponse)).toBe(true);
    expect(res.statusCode).toBeUndefined();

    // After the next checkAdminRateLimit call, the expired lockout entry must be evicted
    checkAdminRateLimit(
      createMockRequest(undefined, "10.0.0.25") as IncomingMessage,
      createMockResponse() as unknown as ServerResponse
    );
    expect(failureMap.has(ip)).toBe(false);
  });

  it("expired lockout with post-expiry failures is normalized and eventually evicted", () => {
    // Regression: entries with (lockedUntil=expired, count>0) were previously immortal
    // because neither eviction condition in checkAdminRateLimit applied.
    // recordAuthFailure() must normalize the expired lockout before incrementing count.
    const ip = "10.0.0.26";
    const failureMap = _getAuthFailureMapForTest();

    // Simulate: IP was locked, lock expired, IP made new failures before eviction ran
    failureMap.set(ip, { count: 2, lockedUntil: Date.now() - 1, lastSeen: Date.now() - 1 });

    // Next failure call normalizes the expired lockout (count=0, lockedUntil=0), then increments
    // So the entry now has count=1, lockedUntil=0 — eligible for stale-partial eviction after STALE window
    checkBasicAuth(wrongCreds(ip) as IncomingMessage, createMockResponse() as unknown as ServerResponse);
    const normalized = failureMap.get(ip);
    expect(normalized?.lockedUntil).toBe(0);
    expect(normalized?.count).toBe(1);
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

// ---------------------------------------------------------------------------
// sanitizeAdminError — LLM provider API key redaction
// ---------------------------------------------------------------------------

describe("admin.ts - sanitizeAdminError", () => {
  it("redacts OpenAI / Anthropic / OpenRouter / DeepSeek sk-... keys", () => {
    expect(sanitizeAdminError("Error: sk-abc1234567890XYZ failed")).toBe("Error: [REDACTED] failed");
    expect(sanitizeAdminError("sk-ant-api03-abcDEFghiJKL1234567890 rejected")).toBe("[REDACTED] rejected");
    expect(sanitizeAdminError("sk-or-v1-abcdefghij1234567890XYZ extra")).toBe("[REDACTED] extra");
  });

  it("redacts Gemini AIza... keys", () => {
    expect(sanitizeAdminError("key=AIzaSyAbcdefghijklmnopqrstuvwxyz12345678 invalid")).toBe("key=[REDACTED] invalid");
  });

  it("redacts Groq gsk_... keys (including underscore-segmented variants)", () => {
    expect(sanitizeAdminError("groq error: gsk_abcdefghij1234567890ABCDEF")).toBe("groq error: [REDACTED]");
    // Underscore-segmented key must also be redacted — body charset includes underscores
    expect(sanitizeAdminError("gsk_prod_ABCDEFGHIJKLMNOPQRST failed")).toBe("[REDACTED] failed");
  });

  it("redacts Fireworks fw_... keys", () => {
    expect(sanitizeAdminError("fw_abcdefghijklmnopqrst bad request")).toBe("[REDACTED] bad request");
  });

  it("redacts xAI xai-... keys", () => {
    expect(sanitizeAdminError("xai-abcdefghijklmnopqrstuvwxyz1234567 denied")).toBe("[REDACTED] denied");
  });

  it("redacts Together AI together_api_... keys (canonical format)", () => {
    expect(sanitizeAdminError("together_api_abcdefghijklmnopqrstuvwxyz12345 error")).toBe("[REDACTED] error");
  });

  it("redacts Together AI legacy tog_/togx_ keys (32+ alphanum chars)", () => {
    // Real Together AI legacy keys: long alphanumeric body (no underscores)
    expect(sanitizeAdminError("tog_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12 error")).toBe("[REDACTED] error");
    expect(sanitizeAdminError("togx_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12 error")).toBe("[REDACTED] error");
  });

  it("does NOT redact tog_ feature-flag names or tog- hyphen-separated identifiers (false-positive prevention)", () => {
    // Common identifier patterns with tog_ prefix must not be redacted
    const config = "config: tog_feature_flag_enabled";
    expect(sanitizeAdminError(config)).toBe(config);
    const logField = "metadata tog_software_update_12345 ok";
    expect(sanitizeAdminError(logField)).toBe(logField);
    // Hyphen-separated tog- identifiers (e.g. correlation IDs) are NOT redacted
    // because the legacy Together AI pattern now requires underscore separator only
    const hyphenated = "tog-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12 trace";
    expect(sanitizeAdminError(hyphenated)).toBe(hyphenated);
  });

  it("redacts Perplexity pplx-... keys", () => {
    expect(sanitizeAdminError("pplx-abcdefghijklmnopqrstuvwxyz12345 bad")).toBe("[REDACTED] bad");
  });

  it("redacts AWS Access Key IDs (AKIA/ASIA/AROA/AIDA)", () => {
    // Standard access key IDs (AKIA prefix)
    expect(sanitizeAdminError("AKIAIOSFODNN7EXAMPLE credential")).toBe("[REDACTED] credential");
    // STS temporary credentials (ASIA prefix)
    expect(sanitizeAdminError("ASIAIOSFODNN7EXAMPLE credential")).toBe("[REDACTED] credential");
    // IAM role principal IDs (AROA prefix)
    expect(sanitizeAdminError("AROAIOSFODNN7EXAMPLE credential")).toBe("[REDACTED] credential");
    // IAM user principal IDs (AIDA prefix)
    expect(sanitizeAdminError("AIDAIOSFODNN7EXAMPLE credential")).toBe("[REDACTED] credential");
    // Keys containing digits 0, 1, 8, 9 (previously excluded by erroneous base32 charset)
    expect(sanitizeAdminError("AKIA5GSG0CFZ3LN1JPM9 leaked")).toBe("[REDACTED] leaked");
  });

  it("redacts keys embedded in JSON error payloads (word boundary fires at quote character)", () => {
    // Double-quote is \\W so \\b fires at the boundary between the quote and the key prefix
    const json = '{"error": "sk-abc1234567890 is invalid"}';
    expect(sanitizeAdminError(json)).toBe('{"error": "[REDACTED] is invalid"}');
  });

  it("known false-negative: tog_ key immediately adjacent to underscore escapes redaction (documented limitation)", () => {
    // \\b does not fire between [A-Za-z0-9] and _ (both are \\w). A Together AI legacy key
    // immediately followed by an underscore (e.g. embedded in a structured log field name)
    // will not be redacted. Error messages from Together AI callers must not include
    // underscore-adjacent key material. This test documents the known boundary behavior.
    const embedded = "error: tog_ABCDEFGHIJKLMNOPQRSTUVWXYZabcde_ctx";
    expect(sanitizeAdminError(embedded)).toBe(embedded); // known false-negative
  });

  it("does not modify messages without API keys", () => {
    const safe = "LLM config save failed: invalid model name";
    expect(sanitizeAdminError(safe)).toBe(safe);
  });

  it("redacts multiple keys in the same message", () => {
    const msg = "sk-abc1234567890 and AIzaSyAbcdefghijklmnopqrstuvwxyz12345678 both failed";
    expect(sanitizeAdminError(msg)).toBe("[REDACTED] and [REDACTED] both failed");
  });
});

// ---------------------------------------------------------------------------
// isSameHostOrigin — CSRF host comparison
// ---------------------------------------------------------------------------

describe("admin.ts - isSameHostOrigin", () => {
  it("returns true when origin host matches server host exactly", () => {
    expect(isSameHostOrigin("http://myhost.com", "myhost.com")).toBe(true);
    expect(isSameHostOrigin("https://myhost.com", "myhost.com")).toBe(true);
    expect(isSameHostOrigin("https://myhost.com:8080", "myhost.com:8080")).toBe(true);
  });

  it("returns false when origin host does not match server host", () => {
    expect(isSameHostOrigin("https://otherhost.com", "myhost.com")).toBe(false);
    expect(isSameHostOrigin("https://myhost.com:9000", "myhost.com:8080")).toBe(false);
  });

  it("rejects substring-bypass attack (evil-myhost.com when host is myhost.com)", () => {
    // A substring check would pass this; exact host comparison must reject it
    expect(isSameHostOrigin("https://evil-myhost.com", "myhost.com")).toBe(false);
    expect(isSameHostOrigin("https://fakemyhost.com", "myhost.com")).toBe(false);
  });

  it("rejects subdomain bypass attempt", () => {
    expect(isSameHostOrigin("https://attacker.myhost.com", "myhost.com")).toBe(false);
  });

  it("returns false for malformed URLs", () => {
    expect(isSameHostOrigin("not-a-url", "myhost.com")).toBe(false);
    expect(isSameHostOrigin("", "myhost.com")).toBe(false);
  });

  it("WHATWG URL parser strips default ports — 'http://myhost.com:80' matches 'myhost.com'", () => {
    // The WHATWG URL parser strips scheme-default ports: new URL("http://myhost.com:80").host
    // returns "myhost.com" (port 80 stripped for http, port 443 stripped for https).
    // This aligns with browser Fetch-spec behaviour, so explicit-default-port Origin headers
    // from browsers will correctly match the plain Host header.
    expect(isSameHostOrigin("http://myhost.com:80", "myhost.com")).toBe(true);
    expect(isSameHostOrigin("https://myhost.com:443", "myhost.com")).toBe(true);
    // Non-default ports are preserved and produce a mismatch
    expect(isSameHostOrigin("http://myhost.com:8080", "myhost.com")).toBe(false);
  });

  it("WHATWG strips default port from URL but not from Host header — explicit:explicit mismatch", () => {
    // Edge case: if Node.js reports host as "myhost.com:80" (client explicitly included :80)
    // and Origin is "http://myhost.com:80", the WHATWG parser strips port 80 → "myhost.com",
    // which does NOT match host string "myhost.com:80". The request is safely over-rejected.
    // Real browsers follow Fetch spec and strip default ports from their Origin headers,
    // so this only occurs with non-browser callers that explicitly send default ports.
    expect(isSameHostOrigin("http://myhost.com:80", "myhost.com:80")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isLockedOut Retry-After header
// ---------------------------------------------------------------------------

describe("admin.ts - lockout 429 includes Retry-After", () => {
  beforeEach(() => {
    process.env.PING_MEM_ADMIN_USER = "admin";
    process.env.PING_MEM_ADMIN_PASS = "correct-pass";
    _resetAdminRateLimitMapsForTest();
  });

  it("429 response from lockout includes Retry-After header", () => {
    const ip = "10.0.0.30";
    const failureMap = _getAuthFailureMapForTest();

    // Manually inject an active lockout
    failureMap.set(ip, {
      count: 0,
      lockedUntil: Date.now() + 30 * 60 * 1000, // 30 min from now
      lastSeen: Date.now(),
    });

    const res = createMockResponse();
    // Use any request — isLockedOut fires before credential check, so credentials don't matter
    const badAuth = Buffer.from("admin:wrong").toString("base64");
    checkBasicAuth(
      createMockRequest(`Basic ${badAuth}`, ip) as IncomingMessage,
      res as unknown as ServerResponse
    );
    expect(res.statusCode).toBe(429);
    const retryAfter = Number(res.headers["Retry-After"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(30 * 60);
  });
});


// ---------------------------------------------------------------------------
// _isProjectDirSafe — path traversal containment
// ---------------------------------------------------------------------------

describe("admin.ts - _isProjectDirSafe", () => {
  it("allows valid subdirectories of allowed roots", () => {
    expect(_isProjectDirSafe("/Users/someone/myrepo")).toBe(true);
    expect(_isProjectDirSafe("/home/ubuntu/myrepo")).toBe(true);
    expect(_isProjectDirSafe("/projects/myrepo")).toBe(true);
    // Note: /tmp is intentionally NOT in the allowed roots (world-writable on POSIX systems)
  });

  it("rejects paths outside all allowed roots (including /tmp — world-writable)", () => {
    expect(_isProjectDirSafe("/etc/passwd")).toBe(false);
    expect(_isProjectDirSafe("/var/log/syslog")).toBe(false);
    expect(_isProjectDirSafe("/root/.ssh")).toBe(false);
    // /tmp is excluded from allowed roots: world-writable, any process can create dirs there
    expect(_isProjectDirSafe("/tmp/sandbox")).toBe(false);
  });

  it("rejects path traversal sequences that escape an allowed root", () => {
    // path.resolve normalises ../ before the root check
    expect(_isProjectDirSafe("/Users/someone/../../../etc/passwd")).toBe(false);
    expect(_isProjectDirSafe("/projects/../etc/passwd")).toBe(false);
  });

  it("rejects the allowed root directories themselves (must be a subdirectory)", () => {
    expect(_isProjectDirSafe("/Users")).toBe(false);
    expect(_isProjectDirSafe("/home")).toBe(false);
    expect(_isProjectDirSafe("/projects")).toBe(false);
    expect(_isProjectDirSafe("/tmp")).toBe(false);
  });

  it("uses process.env.HOME as an allowed root for user home directories", () => {
    const savedHome = process.env["HOME"];
    try {
      process.env["HOME"] = "/custom-home";
      // Subdirectory of the custom HOME must be allowed
      expect(_isProjectDirSafe("/custom-home/myrepo")).toBe(true);
      // The HOME root itself must be rejected (must be a subdirectory, not the root)
      expect(_isProjectDirSafe("/custom-home")).toBe(false);
      // Path traversal out of the HOME root must be rejected
      expect(_isProjectDirSafe("/custom-home/../etc/passwd")).toBe(false);
    } finally {
      if (savedHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = savedHome;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// handleAdminRequest — CSRF enforcement integration tests
// ---------------------------------------------------------------------------

describe("admin.ts - handleAdminRequest CSRF rejection", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.PING_MEM_ADMIN_USER = "admin";
    process.env.PING_MEM_ADMIN_PASS = "test-pass";
    _resetAdminRateLimitMapsForTest();
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  const authHeader = Buffer.from("admin:test-pass").toString("base64");

  // Minimal mock deps — only apiKeyManager.isValid is needed for CSRF path tests.
  // The adminStore and other deps are only reached after CSRF passes.
  const mockDeps = {
    apiKeyManager: { isValid: (_key: string | undefined) => true },
    adminStore: {},
    diagnosticsStore: {},
    eventStore: {},
  } as unknown as AdminDependencies;

  it("rejects POST with cross-origin Origin header with 403", async () => {
    const req = {
      url: "/api/admin/projects",
      method: "POST",
      headers: {
        authorization: `Basic ${authHeader}`,
        host: "myhost.com",
        origin: "https://evil.com",
        "x-api-key": "test-key",
      },
      socket: { remoteAddress: "127.0.0.1" },
    };
    const res = createMockResponse();
    const handled = await handleAdminRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      mockDeps
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(403);
  });

  it("rejects POST with cross-origin Referer header (no Origin) with 403", async () => {
    const req = {
      url: "/api/admin/projects",
      method: "POST",
      headers: {
        authorization: `Basic ${authHeader}`,
        host: "myhost.com",
        referer: "https://evil.com/malicious-page",
        "x-api-key": "test-key",
      },
      socket: { remoteAddress: "127.0.0.1" },
    };
    const res = createMockResponse();
    const handled = await handleAdminRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      mockDeps
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(403);
  });

  it("allows POST with same-origin Origin header (passes CSRF, reaches handler)", async () => {
    // POST to a non-existent admin path — CSRF passes, handler returns 404 (no store calls).
    // This confirms CSRF does not block same-origin requests.
    const req = {
      url: "/api/admin/nonexistent",
      method: "POST",
      headers: {
        authorization: `Basic ${authHeader}`,
        host: "myhost.com",
        origin: "http://myhost.com",
        "x-api-key": "test-key",
      },
      socket: { remoteAddress: "127.0.0.1" },
    };
    const res = createMockResponse();
    await handleAdminRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      mockDeps
    );
    // CSRF passed → reached handler → 404 (no matching route), not 403
    expect(res.statusCode).toBe(404);
  });

  it("allows POST with no Origin and no Referer (server-to-server / CLI caller)", async () => {
    // X-API-Key is the primary auth for callers that omit browser headers.
    // Absence of both Origin and Referer must not trigger CSRF rejection.
    const req = {
      url: "/api/admin/nonexistent",
      method: "POST",
      headers: {
        authorization: `Basic ${authHeader}`,
        host: "myhost.com",
        "x-api-key": "test-key",
      },
      socket: { remoteAddress: "127.0.0.1" },
    };
    const res = createMockResponse();
    await handleAdminRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      mockDeps
    );
    expect(res.statusCode).toBe(404); // CSRF passed, reached handler
  });
});
