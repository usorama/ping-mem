/**
 * Chat API handler for ping-mem UI
 *
 * POST /ui/api/chat — accepts user message, enriches with context from
 * memory search, sends to LLMProxy (Ollama → Gemini),
 * streams response back.
 */

import type { Context } from "hono";
import { z } from "zod";
import { LLMProxy } from "../../llm/LLMProxy.js";
import type { ChatMessage } from "../../llm/types.js";
import type { UIDependencies } from "./routes.js";
import { getClientIp } from "./layout.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("UI:Chat");

const ChatRequestSchema = z.object({
  message: z.string().min(1, "Message is required").max(4096, "Message too long"),
});

// ============================================================================
// Rate Limiting
// ============================================================================

const rateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 30; // requests per minute
const RATE_WINDOW = 60_000;
const MAX_MAP_SIZE = 10_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  if (rateLimits.size > MAX_MAP_SIZE) {
    for (const [key, entry] of rateLimits) {
      if (now > entry.resetAt) rateLimits.delete(key);
    }
  }
  const entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

const SYSTEM_PROMPT = `You are ping-mem's assistant. You help developers understand their codebase, memories, and diagnostics data stored in ping-mem. Answer concisely based on the provided context. If you don't have enough context, say so.`;

export function registerChatRoutes(deps: UIDependencies) {
  const llm = new LLMProxy();

  return {
    /** POST /ui/api/chat — streaming chat completion */
    chat: async (c: Context) => {
      // Rate limit — uses getClientIp which only trusts forwarded headers when TRUST_PROXY is set
      const ip = getClientIp(c);
      if (!checkRateLimit(ip)) {
        return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
      }

      let userMessage: string;
      try {
        const raw = await c.req.json();
        const parsed = ChatRequestSchema.safeParse(raw);
        if (!parsed.success) {
          return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, 400);
        }
        userMessage = parsed.data.message;
      } catch (err) {
        log.warn("Invalid request body", { error: err instanceof Error ? err.message : String(err) });
        return c.json({ error: "Invalid request body" }, 400);
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
          AND (json_extract(payload, '$.key') LIKE $query ESCAPE '\'
               OR json_extract(payload, '$.memory.value') LIKE $query ESCAPE '\')
          ORDER BY timestamp DESC
          LIMIT 5
        `).all({ $query: `%${userMessage.slice(0, 50).replace(/%/g, "\\%").replace(/_/g, "\\_")}%` }) as Array<{
          key: string;
          value: string;
        }>;

        if (memRows.length > 0) {
          contextParts.push(
            "Relevant memories:\n" +
            memRows.map((r) => `- ${r.key}: ${r.value}`).join("\n"),
          );
        }
      } catch (err) {
        log.error("Memory search failed", { error: err instanceof Error ? err.message : String(err) });
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
            log.error("Stream error", { error: errMsg });
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ content: "", done: true, model: "error", provider: "error", error: "An internal error occurred. Please try again." })}\n\n`,
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
