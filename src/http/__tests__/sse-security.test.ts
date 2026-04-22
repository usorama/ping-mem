import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SSEPingMemServer, createDefaultSSEConfig, _resetSseRateLimitMapForTest } from "../sse-server.js";

function createMockRequest(
  headers: Record<string, string> = {},
  remoteAddress: string = "127.0.0.1"
): IncomingMessage {
  return {
    headers,
    method: "GET",
    url: "/mcp",
    socket: { remoteAddress } as IncomingMessage["socket"],
  } as IncomingMessage;
}

function createMockResponse(): ServerResponse {
  const headers = new Map<string, string>();
  return {
    headersSent: false,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    writeHead(_statusCode: number, record?: Record<string, string>) {
      if (record) {
        for (const [key, value] of Object.entries(record)) {
          headers.set(key.toLowerCase(), value);
        }
      }
      this.headersSent = true;
      return this;
    },
    end() {
      return this;
    },
  } as unknown as ServerResponse;
}

describe("SSE /mcp security parity", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    delete process.env.PING_MEM_BEHIND_PROXY;
    delete process.env.NODE_ENV;
    _resetSseRateLimitMapForTest();
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    delete process.env.PING_MEM_BEHIND_PROXY;
    _resetSseRateLimitMapForTest();
  });

  it("applies security headers to MCP responses", async () => {
    process.env.NODE_ENV = "production";
    const server = new SSEPingMemServer({
      ...createDefaultSSEConfig(),
      dbPath: ":memory:",
      apiKey: "secret",
    });
    const req = createMockRequest();
    const res = createMockResponse();

    await server.handleRequest(req, res);

    expect(res.getHeader("x-content-type-options")).toBe("nosniff");
    expect(res.getHeader("x-frame-options")).toBe("DENY");
    expect(res.getHeader("content-security-policy")).toBe(
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    expect(res.getHeader("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.getHeader("strict-transport-security")).toBe("max-age=63072000; includeSubDomains");

    await server.stop();
  });

  it("rate limits repeated requests from the same IP", async () => {
    const server = new SSEPingMemServer({
      ...createDefaultSSEConfig(),
      dbPath: ":memory:",
    });
    const req = createMockRequest({}, "10.0.0.8");

    for (let i = 0; i < 60; i++) {
      const allowed = (server as any).checkRateLimit(req, createMockResponse());
      expect(allowed).toBe(true);
    }

    const limitedRes = createMockResponse();
    const allowed = (server as any).checkRateLimit(req, limitedRes);
    expect(allowed).toBe(false);
    expect(limitedRes.getHeader("retry-after")).toBeDefined();

    await server.stop();
  });
});
