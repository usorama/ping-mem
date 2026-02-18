/**
 * LLM Proxy with Ollama primary + Gemini Flash fallback
 *
 * Tries Ollama first (local, fast). If Ollama fails or times out,
 * falls back to Gemini Flash via Google AI API.
 */

import type {
  ChatMessage,
  ChatResponse,
  ChatStreamChunk,
  LLMProviderConfig,
} from "./types.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "llama3.2";
const DEFAULT_OLLAMA_TIMEOUT_MS = 8000;
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

export class LLMProxy {
  private readonly ollamaUrl: string;
  private readonly ollamaModel: string;
  private readonly ollamaTimeoutMs: number;
  private readonly geminiApiKey: string | undefined;
  private readonly geminiModel: string;

  constructor(config?: LLMProviderConfig) {
    this.ollamaUrl = config?.ollamaUrl ?? DEFAULT_OLLAMA_URL;
    this.ollamaModel = config?.ollamaModel ?? DEFAULT_OLLAMA_MODEL;
    this.ollamaTimeoutMs = config?.ollamaTimeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;
    this.geminiApiKey = config?.geminiApiKey ?? process.env.GEMINI_API_KEY;
    this.geminiModel = config?.geminiModel ?? DEFAULT_GEMINI_MODEL;
  }

  /**
   * Send chat completion request. Tries Ollama first, then Gemini fallback.
   */
  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    // Try Ollama first
    try {
      return await this.chatOllama(messages);
    } catch (err) {
      console.warn("[LLMProxy] Ollama chat failed:", err instanceof Error ? err.message : err);
    }

    // Try Gemini fallback
    if (this.geminiApiKey) {
      try {
        return await this.chatGemini(messages);
      } catch (err) {
        console.warn("[LLMProxy] Gemini chat failed:", err instanceof Error ? err.message : err);
      }
    }

    return {
      content: "Unable to reach any LLM provider. Ensure Ollama is running locally or set GEMINI_API_KEY.",
      model: "none",
      provider: "ollama",
    };
  }

  /**
   * Stream chat completion. Tries Ollama first, then Gemini fallback.
   * Returns an async generator of chunks.
   */
  async *chatStream(messages: ChatMessage[]): AsyncGenerator<ChatStreamChunk> {
    // Try Ollama first
    let yielded = false;
    try {
      const chunks = this.streamOllama(messages);
      for await (const chunk of chunks) {
        yielded = true;
        yield chunk;
      }
      if (yielded) return;
    } catch (err) {
      console.warn("[LLMProxy] Ollama stream failed:", err instanceof Error ? err.message : err);
      // If we already sent partial chunks, signal completion and don't fall through to Gemini
      if (yielded) {
        yield { content: "", done: true, model: this.ollamaModel, provider: "ollama" as const };
        return;
      }
    }

    // Try Gemini fallback (non-streaming, return as single chunk)
    if (this.geminiApiKey) {
      try {
        const response = await this.chatGemini(messages);
        yield {
          content: response.content,
          done: true,
          model: response.model,
          provider: "gemini" as const,
        };
        return;
      } catch (err) {
        console.warn("[LLMProxy] Gemini fallback failed:", err instanceof Error ? err.message : err);
      }
    }

    yield {
      content: "Unable to reach any LLM provider. Ensure Ollama is running locally or set GEMINI_API_KEY.",
      done: true,
      model: "none",
      provider: "ollama" as const,
    };
  }

  private async chatOllama(messages: ChatMessage[]): Promise<ChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.ollamaTimeoutMs);

    try {
      const response = await fetch(`${this.ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.ollamaModel,
          messages,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama returned ${response.status}`);
      }

      const data = (await response.json()) as {
        message?: { content?: string };
        model?: string;
      };
      return {
        content: data.message?.content ?? "",
        model: data.model ?? this.ollamaModel,
        provider: "ollama",
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async *streamOllama(messages: ChatMessage[]): AsyncGenerator<ChatStreamChunk> {
    const controller = new AbortController();
    let chunkTimeout = setTimeout(() => controller.abort(), this.ollamaTimeoutMs);

    try {
      const response = await fetch(`${this.ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.ollamaModel,
          messages,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama returned ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Reset timeout on each chunk — prevents hanging if model stalls mid-stream
        clearTimeout(chunkTimeout);
        chunkTimeout = setTimeout(() => controller.abort(), this.ollamaTimeoutMs);

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line) as {
              message?: { content?: string };
              done?: boolean;
              model?: string;
              error?: string;
            };
            if (chunk.error) {
              console.error("[LLMProxy] Ollama stream error:", chunk.error);
              throw new Error(`Ollama: ${chunk.error}`);
            }
            yield {
              content: chunk.message?.content ?? "",
              done: chunk.done ?? false,
              model: chunk.model ?? this.ollamaModel,
              provider: "ollama" as const,
            };
          } catch (err) {
            if (err instanceof SyntaxError) {
              console.warn("[LLMProxy] Malformed NDJSON line:", line.slice(0, 100));
            } else {
              throw err;
            }
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const chunk = JSON.parse(buffer) as {
            message?: { content?: string };
            done?: boolean;
            model?: string;
            error?: string;
          };
          if (chunk.error) {
            console.error("[LLMProxy] Ollama stream error (buffer):", chunk.error);
            throw new Error(`Ollama: ${chunk.error}`);
          }
          yield {
            content: chunk.message?.content ?? "",
            done: chunk.done ?? false,
            model: chunk.model ?? this.ollamaModel,
            provider: "ollama" as const,
          };
        } catch (err) {
          if (err instanceof SyntaxError) {
            console.warn("[LLMProxy] Malformed NDJSON in buffer:", buffer.slice(0, 100));
          } else {
            throw err;
          }
        }
      }
    } finally {
      clearTimeout(chunkTimeout);
    }
  }

  private async chatGemini(messages: ChatMessage[]): Promise<ChatResponse> {
    if (!this.geminiApiKey) {
      throw new Error("No Gemini API key configured");
    }

    // Convert messages to Gemini format
    const systemMsg = messages.find((m) => m.role === "system");
    const chatMessages = messages.filter((m) => m.role !== "system");

    const contents = chatMessages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const body: Record<string, unknown> = { contents };
    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiApiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Gemini returned ${response.status}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return {
      content: text,
      model: this.geminiModel,
      provider: "gemini",
    };
  }
}
