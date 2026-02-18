import { describe, test, expect, mock, afterEach } from "bun:test";
import { createInMemoryEventStore } from "../../../storage/EventStore.js";
import { SessionManager } from "../../../session/SessionManager.js";
import { DiagnosticsStore } from "../../../diagnostics/DiagnosticsStore.js";

const originalFetch = globalThis.fetch;

describe("Chat API", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("registerChatRoutes returns chat handler", async () => {
    const { registerChatRoutes } = await import("../chat-api.js");
    const eventStore = createInMemoryEventStore();
    const sessionManager = new SessionManager({ eventStore });
    const diagnosticsStore = new DiagnosticsStore({ dbPath: ":memory:" });

    const routes = registerChatRoutes({
      eventStore,
      sessionManager,
      diagnosticsStore,
    });

    expect(routes.chat).toBeDefined();
    expect(typeof routes.chat).toBe("function");
  });

  test("returns 400 for empty message", async () => {
    const { registerChatRoutes } = await import("../chat-api.js");
    const eventStore = createInMemoryEventStore();
    const sessionManager = new SessionManager({ eventStore });
    const diagnosticsStore = new DiagnosticsStore({ dbPath: ":memory:" });

    const routes = registerChatRoutes({
      eventStore,
      sessionManager,
      diagnosticsStore,
    });

    const mockContext = {
      req: {
        json: async () => ({ message: "" }),
      },
      json: (data: unknown, status: number) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        }),
    } as any;

    const response = await routes.chat(mockContext);
    expect(response.status).toBe(400);
  });

  test("returns 400 for invalid JSON body", async () => {
    const { registerChatRoutes } = await import("../chat-api.js");
    const eventStore = createInMemoryEventStore();
    const sessionManager = new SessionManager({ eventStore });
    const diagnosticsStore = new DiagnosticsStore({ dbPath: ":memory:" });

    const routes = registerChatRoutes({
      eventStore,
      sessionManager,
      diagnosticsStore,
    });

    const mockContext = {
      req: {
        json: async () => {
          throw new Error("Invalid JSON");
        },
      },
      json: (data: unknown, status: number) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        }),
    } as any;

    const response = await routes.chat(mockContext);
    expect(response.status).toBe(400);
  });

  test("returns SSE stream for valid message", async () => {
    // Mock Ollama to return a simple response
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          message: { content: "Test response" },
          model: "llama3.2",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const { registerChatRoutes } = await import("../chat-api.js");
    const eventStore = createInMemoryEventStore();
    const sessionManager = new SessionManager({ eventStore });
    const diagnosticsStore = new DiagnosticsStore({ dbPath: ":memory:" });

    const routes = registerChatRoutes({
      eventStore,
      sessionManager,
      diagnosticsStore,
    });

    const mockContext = {
      req: {
        json: async () => ({ message: "What is ping-mem?" }),
      },
      json: (data: unknown, status: number) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        }),
    } as any;

    const response = await routes.chat(mockContext);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    // Read the stream
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let fullText = "";
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      fullText += decoder.decode(value, { stream: true });
    }

    // Should contain SSE data lines
    expect(fullText).toContain("data: ");
  });
});
