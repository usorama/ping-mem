/**
 * Chat API handler for ping-mem UI
 *
 * POST /ui/api/chat — accepts user message, enriches with context from
 * memory search + codebase search, sends to LLMProxy (Ollama → Gemini),
 * streams response back.
 */

import type { Context } from "hono";
import { LLMProxy } from "../../llm/LLMProxy.js";
import type { ChatMessage } from "../../llm/types.js";
import type { UIDependencies } from "./routes.js";

const SYSTEM_PROMPT = `You are ping-mem's assistant. You help developers understand their codebase, memories, and diagnostics data stored in ping-mem. Answer concisely based on the provided context. If you don't have enough context, say so.`;

export function registerChatRoutes(deps: UIDependencies) {
  const llm = new LLMProxy();

  return {
    /** POST /ui/api/chat — streaming chat completion */
    chat: async (c: Context) => {
      let userMessage: string;
      try {
        const body = (await c.req.json()) as { message?: string };
        userMessage = body.message ?? "";
      } catch {
        return c.json({ error: "Invalid request body" }, 400);
      }

      if (!userMessage.trim()) {
        return c.json({ error: "Message is required" }, 400);
      }

      // Build context from ping-mem data
      const contextParts: string[] = [];

      // Search memories for relevant context
      try {
        const db = deps.eventStore.getDatabase();
        const memRows = db.prepare(`
          SELECT json_extract(payload, '$.key') as key,
                 json_extract(payload, '$.memory.value') as value
          FROM events
          WHERE event_type = 'MEMORY_SAVED'
          AND (json_extract(payload, '$.key') LIKE $query
               OR json_extract(payload, '$.memory.value') LIKE $query)
          ORDER BY timestamp DESC
          LIMIT 5
        `).all({ $query: `%${userMessage.slice(0, 50)}%` }) as Array<{
          key: string;
          value: string;
        }>;

        if (memRows.length > 0) {
          contextParts.push(
            "Relevant memories:\n" +
            memRows.map((r) => `- ${r.key}: ${r.value}`).join("\n"),
          );
        }
      } catch {
        // Memory search failed, continue without
      }

      // Build messages
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
      ];

      if (contextParts.length > 0) {
        messages.push({
          role: "system",
          content: "Context from ping-mem:\n\n" + contextParts.join("\n\n"),
        });
      }

      messages.push({ role: "user", content: userMessage });

      // Stream response
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          try {
            for await (const chunk of llm.chatStream(messages)) {
              const data = JSON.stringify({
                content: chunk.content,
                done: chunk.done,
                model: chunk.model,
                provider: chunk.provider,
              });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ content: errMsg, done: true, model: "error", provider: "ollama" })}\n\n`,
              ),
            );
          }
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    },
  };
}
