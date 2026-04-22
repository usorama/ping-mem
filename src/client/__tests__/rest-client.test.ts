/**
 * Tests for RESTPingMemClient.
 *
 * Mocks global fetch using bun's mock.module to isolate network calls.
 *
 * @module client/__tests__/rest-client.test
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { RESTPingMemClient, createRESTClient, createLocalRESTClient } from "../rest-client.js";
import {
  AuthenticationError,
  NotFoundError,
  ServerError,
  ValidationError,
} from "../types.js";

// ============================================================================
// Mock fetch
// ============================================================================

/** Typed mock for the global fetch function. */
let fetchMock: ReturnType<typeof mock>;
let originalFetch: typeof globalThis.fetch;

function installFetchMock(): void {
  originalFetch = globalThis.fetch;
  fetchMock = mock<typeof globalThis.fetch>();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

/** Helper to make fetchMock resolve with a JSON response. */
function mockFetchResponse(body: unknown, status = 200): void {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  fetchMock.mockResolvedValueOnce(response);
}

/** Helper to make fetchMock resolve with an error status and JSON body. */
function mockFetchErrorResponse(
  status: number,
  body: { error: string; message: string }
): void {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  fetchMock.mockResolvedValueOnce(response);
}

// ============================================================================
// Tests
// ============================================================================

describe("RESTPingMemClient", () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    restoreFetch();
  });

  // --------------------------------------------------------------------------
  // Construction
  // --------------------------------------------------------------------------

  describe("constructor", () => {
    it("constructs with default options", () => {
      const client = new RESTPingMemClient();

      expect(client.getSessionId()).toBeUndefined();
    });

    it("constructs with custom baseUrl and apiKey", () => {
      const client = new RESTPingMemClient({
        baseUrl: "https://custom.example.com",
        apiKey: "my-key",
      });

      expect(client.getSessionId()).toBeUndefined();
    });

    it("uses provided sessionId", () => {
      const client = new RESTPingMemClient({
        sessionId: "pre-existing-session",
      });

      expect(client.getSessionId()).toBe("pre-existing-session");
    });
  });

  // --------------------------------------------------------------------------
  // startSession
  // --------------------------------------------------------------------------

  describe("startSession", () => {
    it("sends POST to /api/v1/session/start and returns session", async () => {
      const sessionData = {
        id: "sess-123",
        name: "test-session",
        status: "active",
        startedAt: "2026-03-08T00:00:00Z",
        memoryCount: 0,
        eventCount: 0,
        lastActivityAt: "2026-03-08T00:00:00Z",
        metadata: {},
      };
      mockFetchResponse({ data: sessionData });

      const client = new RESTPingMemClient({ baseUrl: "http://localhost:3000" });
      const session = await client.startSession({ name: "test-session" });

      expect(session.id).toBe("sess-123");
      expect(session.name).toBe("test-session");
      expect(client.getSessionId()).toBe("sess-123");

      // Verify fetch was called with correct URL and method
      const fetchCall = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(fetchCall[0]).toBe("http://localhost:3000/api/v1/session/start");
      expect(fetchCall[1]?.method).toBe("POST");
    });
  });

  // --------------------------------------------------------------------------
  // save
  // --------------------------------------------------------------------------

  describe("save", () => {
    it("sends correct payload to /api/v1/context", async () => {
      mockFetchResponse({ data: { message: "saved" } });

      const client = new RESTPingMemClient({ baseUrl: "http://localhost:3000" });
      await client.save("my-key", "my-value", {
        category: "decision",
        priority: "high",
      });

      const fetchCall = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(fetchCall[0]).toBe("http://localhost:3000/api/v1/context");
      expect(fetchCall[1]?.method).toBe("POST");

      const body = JSON.parse(fetchCall[1]?.body as string) as Record<string, unknown>;
      expect(body["key"]).toBe("my-key");
      expect(body["value"]).toBe("my-value");
      expect(body["category"]).toBe("decision");
      expect(body["priority"]).toBe("high");
    });
  });

  // --------------------------------------------------------------------------
  // API key header
  // --------------------------------------------------------------------------

  describe("authentication headers", () => {
    it("includes X-API-Key header when apiKey is configured", async () => {
      mockFetchResponse({ data: { totalEvents: 0, sessions: { total: 0, active: 0 }, currentSession: null } });

      const client = new RESTPingMemClient({
        baseUrl: "http://localhost:3000",
        apiKey: "secret-api-key",
      });
      await client.getStatus();

      const fetchCall = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = fetchCall[1]?.headers as Headers;
      expect(headers.get("X-API-Key")).toBe("secret-api-key");
    });

    it("does not include X-API-Key header when apiKey is not configured", async () => {
      mockFetchResponse({ data: { totalEvents: 0, sessions: { total: 0, active: 0 }, currentSession: null } });

      const client = new RESTPingMemClient({ baseUrl: "http://localhost:3000" });
      await client.getStatus();

      const fetchCall = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = fetchCall[1]?.headers as Headers;
      expect(headers.get("X-API-Key")).toBeNull();
    });

    it("includes X-Session-ID header when session is set", async () => {
      mockFetchResponse({ data: { totalEvents: 0, sessions: { total: 0, active: 0 }, currentSession: null } });

      const client = new RESTPingMemClient({ baseUrl: "http://localhost:3000" });
      client.setSessionId("my-session-id");
      await client.getStatus();

      const fetchCall = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = fetchCall[1]?.headers as Headers;
      expect(headers.get("X-Session-ID")).toBe("my-session-id");
    });
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  describe("error handling", () => {
    it("throws AuthenticationError on 401", async () => {
      mockFetchErrorResponse(401, {
        error: "UNAUTHORIZED",
        message: "Invalid API key",
      });

      const client = new RESTPingMemClient({ baseUrl: "http://localhost:3000" });

      await expect(client.getStatus()).rejects.toBeInstanceOf(AuthenticationError);
    });

    it("throws NotFoundError on 404", async () => {
      mockFetchErrorResponse(404, {
        error: "NOT_FOUND",
        message: "Memory not found",
      });

      const client = new RESTPingMemClient({ baseUrl: "http://localhost:3000" });

      await expect(client.get("nonexistent-key")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws ValidationError on 400", async () => {
      mockFetchErrorResponse(400, {
        error: "VALIDATION_ERROR",
        message: "Invalid payload",
      });

      const client = new RESTPingMemClient({ baseUrl: "http://localhost:3000" });

      await expect(client.save("", "")).rejects.toBeInstanceOf(ValidationError);
    });

    it("throws ServerError on 500", async () => {
      mockFetchErrorResponse(500, {
        error: "INTERNAL",
        message: "Internal server error",
      });

      const client = new RESTPingMemClient({ baseUrl: "http://localhost:3000" });

      await expect(client.getStatus()).rejects.toBeInstanceOf(ServerError);
    });

    it("throws ServerError on 503", async () => {
      mockFetchErrorResponse(503, {
        error: "SERVICE_UNAVAILABLE",
        message: "Ingestion service not configured",
      });

      const client = new RESTPingMemClient({ baseUrl: "http://localhost:3000" });

      await expect(client.getStatus()).rejects.toBeInstanceOf(ServerError);
    });
  });

  // --------------------------------------------------------------------------
  // Other operations
  // --------------------------------------------------------------------------

  describe("search", () => {
    it("sends query params for search", async () => {
      mockFetchResponse({ data: [] });

      const client = new RESTPingMemClient({ baseUrl: "http://localhost:3000" });
      await client.search({
        key: "memory-key",
        keyPattern: "memory-*",
        query: "test query",
        category: "note",
        sessionId: "session-123",
        minSimilarity: 0.5,
        limit: 5,
      });

      const fetchCall = fetchMock.mock.calls[0] as [string, RequestInit];
      const url = new URL(fetchCall[0] as string);
      expect(url.searchParams.get("key")).toBe("memory-key");
      expect(url.searchParams.get("keyPattern")).toBe("memory-*");
      expect(url.searchParams.get("query")).toBe("test query");
      expect(url.searchParams.get("limit")).toBe("5");
      expect(url.searchParams.get("category")).toBe("note");
      expect(url.searchParams.get("sessionId")).toBe("session-123");
      expect(url.searchParams.get("minSimilarity")).toBe("0.5");
      expect(fetchCall[1]?.method).toBe("GET");
    });

    it("includes zero-value numeric params", async () => {
      mockFetchResponse({ data: [] });

      const client = new RESTPingMemClient({ baseUrl: "http://localhost:3000" });
      await client.search({ query: "zero", offset: 0, limit: 0, minSimilarity: 0 });

      const fetchCall = fetchMock.mock.calls[0] as [string, RequestInit];
      const url = new URL(fetchCall[0] as string);
      expect(url.searchParams.get("offset")).toBe("0");
      expect(url.searchParams.get("limit")).toBe("0");
      expect(url.searchParams.get("minSimilarity")).toBe("0");
      expect(fetchCall[1]?.method).toBe("GET");
    });
  });

  describe("close", () => {
    it("clears session ID on close", async () => {
      const client = new RESTPingMemClient({ sessionId: "active-session" });
      expect(client.getSessionId()).toBe("active-session");

      await client.close();
      expect(client.getSessionId()).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Factory functions
  // --------------------------------------------------------------------------

  describe("factory functions", () => {
    it("createRESTClient creates a client instance", () => {
      const client = createRESTClient({ apiKey: "key-1" });

      expect(client).toBeInstanceOf(RESTPingMemClient);
    });

    it("createLocalRESTClient creates a client with localhost baseUrl", async () => {
      mockFetchResponse({ data: [] });

      const client = createLocalRESTClient();
      await client.listSessions(5);

      const fetchCall = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((fetchCall[0] as string).startsWith("http://localhost:3003")).toBe(true);
    });
  });
});
