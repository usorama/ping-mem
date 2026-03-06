import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { LLMProxy } from "../LLMProxy.js";

// Mock fetch globally for these tests
const originalFetch = globalThis.fetch;

describe("LLMProxy", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("chat (non-streaming)", () => {
    test("returns Ollama response when available", async () => {
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            message: { content: "Hello from Ollama" },
            model: "llama3.2",
          }),
          { status: 200 },
        );
      }) as typeof fetch;

      const proxy = new LLMProxy({ ollamaUrl: "http://localhost:11434" });
      const result = await proxy.chat([
        { role: "user", content: "Hello" },
      ]);

      expect(result.content).toBe("Hello from Ollama");
      expect(result.provider).toBe("ollama");
      expect(result.model).toBe("llama3.2");
    });

    test("falls back to Gemini when Ollama fails", async () => {
      let callCount = 0;
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        callCount++;
        const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

        if (urlStr.includes("localhost:11434")) {
          throw new Error("Connection refused");
        }
        if (urlStr.includes("generativelanguage.googleapis.com")) {
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: "Hello from Gemini" }],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error("Unexpected URL: " + urlStr);
      }) as typeof fetch;

      const proxy = new LLMProxy({
        ollamaUrl: "http://localhost:11434",
        geminiApiKey: "test-key",
      });

      const result = await proxy.chat([
        { role: "user", content: "Hello" },
      ]);

      expect(result.content).toBe("Hello from Gemini");
      expect(result.provider).toBe("gemini");
      expect(callCount).toBe(2);
    });

    test("returns error message when both providers fail", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("Connection refused");
      }) as typeof fetch;

      const proxy = new LLMProxy({
        ollamaUrl: "http://localhost:11434",
        geminiApiKey: "test-key",
      });

      await expect(proxy.chat([
        { role: "user", content: "Hello" },
      ])).rejects.toThrow("Unable to reach any LLM provider");
    });

    test("throws when Ollama fails and no Gemini key", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("Connection refused");
      }) as typeof fetch;

      const proxy = new LLMProxy({
        ollamaUrl: "http://localhost:11434",
        geminiApiKey: undefined,
      });

      await expect(proxy.chat([
        { role: "user", content: "Hello" },
      ])).rejects.toThrow("Unable to reach any LLM provider");
    });

    test("falls back on Ollama HTTP error", async () => {
      let callCount = 0;
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        callCount++;
        const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

        if (urlStr.includes("localhost:11434")) {
          return new Response("Internal Server Error", { status: 500 });
        }
        if (urlStr.includes("generativelanguage.googleapis.com")) {
          return new Response(
            JSON.stringify({
              candidates: [
                { content: { parts: [{ text: "Gemini fallback" }] } },
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error("Unexpected URL");
      }) as typeof fetch;

      const proxy = new LLMProxy({
        ollamaUrl: "http://localhost:11434",
        geminiApiKey: "test-key",
      });

      const result = await proxy.chat([
        { role: "user", content: "Hello" },
      ]);

      expect(result.content).toBe("Gemini fallback");
      expect(result.provider).toBe("gemini");
    });
  });

  describe("chatStream", () => {
    test("streams chunks from Ollama", async () => {
      const chunks = [
        JSON.stringify({ message: { content: "Hello" }, done: false, model: "llama3.2" }),
        JSON.stringify({ message: { content: " world" }, done: true, model: "llama3.2" }),
      ];

      globalThis.fetch = mock(async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(chunk + "\n"));
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }) as typeof fetch;

      const proxy = new LLMProxy({ ollamaUrl: "http://localhost:11434" });
      const collected: string[] = [];

      for await (const chunk of proxy.chatStream([
        { role: "user", content: "Hello" },
      ])) {
        collected.push(chunk.content);
        if (chunk.done) break;
      }

      expect(collected.join("")).toBe("Hello world");
    });

    test("falls back to Gemini single chunk on Ollama failure", async () => {
      let callCount = 0;
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        callCount++;
        const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

        if (urlStr.includes("localhost:11434")) {
          throw new Error("Connection refused");
        }
        if (urlStr.includes("generativelanguage.googleapis.com")) {
          return new Response(
            JSON.stringify({
              candidates: [
                { content: { parts: [{ text: "Gemini response" }] } },
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error("Unexpected URL");
      }) as typeof fetch;

      const proxy = new LLMProxy({
        ollamaUrl: "http://localhost:11434",
        geminiApiKey: "test-key",
      });

      const collected: string[] = [];
      for await (const chunk of proxy.chatStream([
        { role: "user", content: "Hello" },
      ])) {
        collected.push(chunk.content);
        expect(chunk.provider).toBe("gemini");
      }

      expect(collected.join("")).toBe("Gemini response");
    });
  });

  describe("Gemini message conversion", () => {
    test("sends system instruction separately", async () => {
      let capturedBody: string = "";

      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

        if (urlStr.includes("localhost:11434")) {
          throw new Error("Connection refused");
        }
        if (urlStr.includes("generativelanguage.googleapis.com")) {
          capturedBody = init?.body as string ?? "";
          return new Response(
            JSON.stringify({
              candidates: [
                { content: { parts: [{ text: "OK" }] } },
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error("Unexpected URL");
      }) as typeof fetch;

      const proxy = new LLMProxy({
        ollamaUrl: "http://localhost:11434",
        geminiApiKey: "test-key",
      });

      await proxy.chat([
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" },
      ]);

      const parsed = JSON.parse(capturedBody);
      expect(parsed.systemInstruction).toBeDefined();
      expect(parsed.systemInstruction.parts[0].text).toBe("You are helpful");
      // System message should not be in contents
      expect(parsed.contents.length).toBe(1);
      expect(parsed.contents[0].role).toBe("user");
    });
  });
});
