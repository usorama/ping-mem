/**
 * Semantic Compressor for ping-mem
 *
 * LLM-powered memory compression system that takes a batch of memories
 * and compresses them into a smaller set of "digest" entries.
 * Falls back to heuristic deduplication when no LLM API key is available.
 *
 * @module memory/SemanticCompressor
 * @version 1.0.0
 */

import type { Memory } from "../types/index.js";

// ============================================================================
// Types
// ============================================================================

export interface CompressionResult {
  facts: string[];
  sourceCount: number;
  compressionRatio: number; // 0-1, lower = more compressed
  strategy: "llm" | "heuristic";
  costEstimate?: { inputTokens: number; outputTokens: number };
}

export interface CompressorConfig {
  /** OpenAI API key for LLM-based compression */
  apiKey?: string;
  /** Max tokens per batch sent to LLM (default: 4000) */
  maxBatchTokens?: number;
  /** Model to use (default: "gpt-4o-mini") */
  model?: string;
}

// ============================================================================
// OpenAI Response Types
// ============================================================================

interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// ============================================================================
// SemanticCompressor Implementation
// ============================================================================

export class SemanticCompressor {
  private apiKey: string | undefined;
  private maxBatchTokens: number;
  private model: string;

  constructor(config: CompressorConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    this.maxBatchTokens = config.maxBatchTokens ?? 4000;
    this.model = config.model ?? "gpt-4o-mini";
  }

  /**
   * Compress a batch of memories into facts.
   * Uses LLM when API key available, falls back to heuristic.
   */
  async compress(memories: Memory[]): Promise<CompressionResult> {
    if (memories.length === 0) {
      return {
        facts: [],
        sourceCount: 0,
        compressionRatio: 1,
        strategy: "heuristic",
      };
    }

    if (this.apiKey) {
      return this.compressWithLLM(memories);
    }
    return this.compressWithHeuristic(memories);
  }

  /**
   * LLM compression: Send memories to OpenAI and extract key facts.
   */
  private async compressWithLLM(
    memories: Memory[]
  ): Promise<CompressionResult> {
    // Build prompt with memory values
    const memoryText = memories
      .map(
        (m, i) =>
          `[${i + 1}] (${m.category ?? "note"}) ${m.key}: ${m.value}`
      )
      .join("\n");

    // Estimate tokens (~4 chars per token)
    const inputTokens = Math.ceil(memoryText.length / 4);

    // Batch if too large
    if (inputTokens > this.maxBatchTokens) {
      if (memories.length <= 1) {
        console.warn(`[SemanticCompressor] Single memory exceeds token limit (${inputTokens} > ${this.maxBatchTokens}), using heuristic fallback`);
        return this.compressWithHeuristic(memories);
      }
      return this.compressInBatches(memories);
    }

    const systemPrompt = `You are a memory compression agent. Extract the essential facts from the following memories. Output ONLY a JSON object with a "facts" key containing an array of fact strings. Each fact should be a complete, standalone statement. Remove duplicates and merge related facts. Be concise but preserve all important information.`;

    try {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: memoryText },
            ],
            temperature: 0.1,
            response_format: { type: "json_object" },
          }),
        }
      );

      if (!response.ok) {
        const body = await response.text().catch(() => "<unreadable>");
        console.warn(
          `[SemanticCompressor] LLM call failed (${response.status}): ${body.slice(0, 500)}, falling back to heuristic`
        );
        return this.compressWithHeuristic(memories);
      }

      const data = (await response.json()) as ChatCompletionResponse;

      const content = data.choices[0]?.message?.content ?? "{}";
      let parsed: { facts?: unknown };
      try {
        parsed = JSON.parse(content) as { facts?: unknown };
      } catch {
        console.warn(`[SemanticCompressor] LLM returned invalid JSON, falling back to heuristic. Preview: ${content.slice(0, 200)}`);
        return this.compressWithHeuristic(memories);
      }

      const facts = Array.isArray(parsed.facts)
        ? parsed.facts.filter((f): f is string => typeof f === "string")
        : [];
      const outputTokens =
        data.usage?.completion_tokens ?? Math.ceil(content.length / 4);

      return {
        facts,
        sourceCount: memories.length,
        compressionRatio:
          facts.length > 0 ? facts.length / memories.length : 1,
        strategy: "llm",
        costEstimate: {
          inputTokens: data.usage?.prompt_tokens ?? inputTokens,
          outputTokens,
        },
      };
    } catch (error) {
      console.error(
        "[SemanticCompressor] LLM compression failed, falling back to heuristic:",
        error instanceof Error ? error.message : "Unknown error"
      );
      return this.compressWithHeuristic(memories);
    }
  }

  /**
   * Heuristic compression: Simple dedup + truncation without LLM.
   */
  private compressWithHeuristic(memories: Memory[]): CompressionResult {
    // Deduplicate by value similarity
    const seen = new Set<string>();
    const facts: string[] = [];

    for (const memory of memories) {
      // Normalize: lowercase, trim, collapse whitespace
      const normalized = memory.value
        .toLowerCase()
        .trim()
        .replace(/\s+/g, " ");
      const dedupKey = String(Bun.hash(normalized));

      if (!seen.has(dedupKey)) {
        seen.add(dedupKey);
        // Build a fact string: "key: value" (truncated to 200 chars)
        const fact = `${memory.key}: ${memory.value}`.slice(0, 200);
        facts.push(fact);
      }
    }

    return {
      facts,
      sourceCount: memories.length,
      compressionRatio: facts.length / memories.length,
      strategy: "heuristic",
    };
  }

  /**
   * Handle large batches by splitting into chunks and merging results.
   */
  private async compressInBatches(
    memories: Memory[]
  ): Promise<CompressionResult> {
    const batchSize = Math.max(
      1,
      Math.floor(this.maxBatchTokens / 50)
    ); // ~50 tokens per memory
    const batches: Memory[][] = [];

    for (let i = 0; i < memories.length; i += batchSize) {
      batches.push(memories.slice(i, i + batchSize));
    }

    const allFacts: string[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let usedLLM = false;

    for (const batch of batches) {
      const result = await this.compressWithLLM(batch);
      allFacts.push(...result.facts);
      if (result.costEstimate) {
        totalInputTokens += result.costEstimate.inputTokens;
        totalOutputTokens += result.costEstimate.outputTokens;
      }
      if (result.strategy === "llm") usedLLM = true;
    }

    // Deduplicate across batches
    const uniqueFacts = [...new Set(allFacts)];

    const result: CompressionResult = {
      facts: uniqueFacts,
      sourceCount: memories.length,
      compressionRatio: uniqueFacts.length / memories.length,
      strategy: usedLLM ? "llm" : "heuristic",
    };

    if (usedLLM) {
      result.costEstimate = {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      };
    }

    return result;
  }

  /** Check if LLM compression is available */
  get isLLMAvailable(): boolean {
    return !!this.apiKey;
  }
}
