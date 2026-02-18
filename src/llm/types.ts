/**
 * LLM types for ping-mem chat
 */

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string | undefined;
  stream?: boolean | undefined;
}

export interface ChatResponse {
  content: string;
  model: string;
  provider: "ollama" | "gemini";
}

export interface ChatStreamChunk {
  content: string;
  done: boolean;
  model: string;
  provider: "ollama" | "gemini";
}

export interface LLMProviderConfig {
  ollamaUrl?: string | undefined;
  ollamaModel?: string | undefined;
  ollamaTimeoutMs?: number | undefined;
  geminiApiKey?: string | undefined;
  geminiModel?: string | undefined;
}
