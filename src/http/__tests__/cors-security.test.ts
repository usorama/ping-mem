/**
 * Regression test for fix-002: CORS origin restriction
 * Verifies that CORS is no longer wildcard by default.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createDefaultRESTConfig } from "../rest-server.js";
import { createDefaultSSEConfig } from "../sse-server.js";

describe("CORS Security", () => {
  const originalEnv = process.env.PING_MEM_CORS_ORIGIN;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PING_MEM_CORS_ORIGIN;
    } else {
      process.env.PING_MEM_CORS_ORIGIN = originalEnv;
    }
  });

  describe("REST server default config", () => {
    it("should not default CORS origin to wildcard '*'", () => {
      delete process.env.PING_MEM_CORS_ORIGIN;
      const config = createDefaultRESTConfig();
      const origin = config.cors?.origin;
      expect(origin).not.toBe("*");
      expect(origin).not.toContain("*");
    });

    it("should use PING_MEM_CORS_ORIGIN env var when set", () => {
      process.env.PING_MEM_CORS_ORIGIN = "https://example.com,https://app.example.com";
      const config = createDefaultRESTConfig();
      const origin = config.cors?.origin;
      expect(origin).toEqual(["https://example.com", "https://app.example.com"]);
    });

    it("should default to empty array (reject cross-origin) when env var is not set", () => {
      delete process.env.PING_MEM_CORS_ORIGIN;
      const config = createDefaultRESTConfig();
      const origin = config.cors?.origin;
      expect(Array.isArray(origin)).toBe(true);
      expect((origin as string[]).length).toBe(0);
    });
  });

  describe("SSE server default config", () => {
    it("should not default CORS origin to wildcard '*'", () => {
      delete process.env.PING_MEM_CORS_ORIGIN;
      const config = createDefaultSSEConfig();
      const origin = config.cors?.origin;
      expect(origin).not.toBe("*");
      expect(origin).not.toContain("*");
    });

    it("should use PING_MEM_CORS_ORIGIN env var when set", () => {
      process.env.PING_MEM_CORS_ORIGIN = "https://myapp.com";
      const config = createDefaultSSEConfig();
      const origin = config.cors?.origin;
      expect(origin).toEqual(["https://myapp.com"]);
    });

    it("should default to empty array (reject cross-origin) when env var is not set", () => {
      delete process.env.PING_MEM_CORS_ORIGIN;
      const config = createDefaultSSEConfig();
      const origin = config.cors?.origin;
      expect(Array.isArray(origin)).toBe(true);
      expect((origin as string[]).length).toBe(0);
    });
  });
});
