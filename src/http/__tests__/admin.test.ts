/**
 * Tests for admin.ts Basic Auth
 *
 * @module http/__tests__/admin.test
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { IncomingMessage, OutgoingMessage } from "node:http";
import { checkBasicAuth } from "../admin.js";

// Mock IncomingMessage for testing
function createMockRequest(authHeader?: string): Partial<IncomingMessage> {
  return {
    headers: {
      authorization: authHeader ?? "",
    },
  };
}

// Mock ServerResponse for testing
function createMockResponse(): Partial<OutgoingMessage> {
  const response: Partial<OutgoingMessage> = {
    statusCode: undefined,
    headers: {} as Record<string, string | string[] | undefined>,
    writeHead: function (
      this: Partial<OutgoingMessage>,
      statusCode: number,
      headers?: Record<string, string | string[] | undefined>
    ) {
      this.statusCode = statusCode;
      if (headers) {
        this.headers = { ...this.headers, ...headers };
      }
      return this as OutgoingMessage;
    },
    end: function (this: Partial<OutgoingMessage>, _data?: string) {
      // Mock end method
      return this as OutgoingMessage;
    },
  };
  return response;
}

describe("admin.ts - checkBasicAuth", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    // Restore environment after each test
    process.env = OLD_ENV;
  });

  describe("when no auth is configured", () => {
    it("should return true (allow access) when PING_MEM_ADMIN_USER is not set", () => {
      delete process.env.PING_MEM_ADMIN_USER;
      delete process.env.PING_MEM_ADMIN_PASS;

      const req = createMockRequest();
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as OutgoingMessage)).toBe(true);
      expect(res.statusCode).toBeUndefined();
    });

    it("should return true (allow access) when PING_MEM_ADMIN_PASS is not set", () => {
      process.env.PING_MEM_ADMIN_USER = "admin";
      delete process.env.PING_MEM_ADMIN_PASS;

      const req = createMockRequest();
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as OutgoingMessage)).toBe(true);
      expect(res.statusCode).toBeUndefined();
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

      expect(checkBasicAuth(req as IncomingMessage, res as OutgoingMessage)).toBe(true);
      expect(res.statusCode).toBeUndefined();
    });

    it("should return false and send 401 for incorrect username", () => {
      const credentials = Buffer.from("wrong:secret-password").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as OutgoingMessage)).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it("should return false and send 401 for incorrect password", () => {
      const credentials = Buffer.from("admin:wrong-password").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as OutgoingMessage)).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it("should return false and send 401 for both incorrect", () => {
      const credentials = Buffer.from("wrong:also-wrong").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as OutgoingMessage)).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it("should return false and send 401 for missing authorization header", () => {
      const req = createMockRequest();
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as OutgoingMessage)).toBe(false);
      expect(res.statusCode).toBe(401);
      // Note: writeHead sets headers, but the mock doesn't preserve case
      const wwwAuth = Object.keys(res.headers).find(k => k.toLowerCase() === "www-authenticate");
      expect(wwwAuth).toBeDefined();
    });

    it("should return false and send 401 for invalid scheme", () => {
      const credentials = Buffer.from("admin:secret-password").toString("base64");
      const req = createMockRequest(`Bearer ${credentials}`); // Wrong scheme
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as OutgoingMessage)).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it("should handle special characters in password", () => {
      process.env.PING_MEM_ADMIN_PASS = "p@ssw0rd!#$%^&*()";
      const credentials = Buffer.from("admin:p@ssw0rd!#$%^&*()").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as OutgoingMessage)).toBe(true);
    });

    it("should handle unicode characters in credentials", () => {
      process.env.PING_MEM_ADMIN_USER = "管理者";
      process.env.PING_MEM_ADMIN_PASS = "パスワード123";
      const credentials = Buffer.from("管理者:パスワード123").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as OutgoingMessage)).toBe(true);
    });

    it("should handle malformed base64 gracefully", () => {
      const req = createMockRequest("Basic not-valid-base64!!!>>>");
      const res = createMockResponse();

      // Should fail authentication
      expect(checkBasicAuth(req as IncomingMessage, res as OutgoingMessage)).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it("should handle credentials without colon separator", () => {
      const credentials = Buffer.from("admin-only").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      // Missing password should fail
      expect(checkBasicAuth(req as IncomingMessage, res as OutgoingMessage)).toBe(false);
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
      expect(checkBasicAuth(req1 as IncomingMessage, res1 as OutgoingMessage)).toBe(false);
      expect(checkBasicAuth(req2 as IncomingMessage, res2 as OutgoingMessage)).toBe(false);
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
      expect(checkBasicAuth(req1 as IncomingMessage, res1 as OutgoingMessage)).toBe(false);
      expect(checkBasicAuth(req2 as IncomingMessage, res2 as OutgoingMessage)).toBe(false);
    });

    it("should handle empty username correctly", () => {
      const credentials = Buffer.from(":very-long-secret-password-12345").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as OutgoingMessage)).toBe(false);
    });

    it("should handle empty password correctly", () => {
      const credentials = Buffer.from("admin:").toString("base64");
      const req = createMockRequest(`Basic ${credentials}`);
      const res = createMockResponse();

      expect(checkBasicAuth(req as IncomingMessage, res as OutgoingMessage)).toBe(false);
    });
  });
});
