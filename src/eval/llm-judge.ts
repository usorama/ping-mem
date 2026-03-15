/**
 * LLM-as-Judge for search result relevance grading
 *
 * Uses dual judges (Anthropic primary, Google secondary) with
 * disagreement resolution for calibrated relevance scoring.
 *
 * @module eval/llm-judge
 */

import type { JudgeScore } from "./types.js";

export interface JudgeProviderConfig {
  provider: "anthropic" | "google";
  model: string;
  apiKey: string;
}

export interface JudgeConfig {
  primary: JudgeProviderConfig;
  secondary: JudgeProviderConfig;
  maxBudgetUsd: number;
}

interface JudgeResponse {
  relevance: number;
  reasoning: string;
}

const JUDGE_PROMPT = `Given this search query and retrieved result, rate relevance 0-3:
  0 = completely irrelevant
  1 = marginally relevant (mentions related concepts)
  2 = relevant (directly addresses query topic)
  3 = perfectly relevant (exact answer to query)

Query: {QUERY}

Retrieved Result: {RESULT}

Ground Truth (expected): {GROUND_TRUTH}

Respond with ONLY valid JSON: { "relevance": N, "reasoning": "..." }`;

export class LLMJudge {
  private costAccumulator = 0;
  private readonly maxBudget: number;

  constructor(private readonly config: JudgeConfig) {
    this.maxBudget = config.maxBudgetUsd;
  }

  async judge(
    query: string,
    result: string,
    groundTruth: string,
    resultId: string,
    queryId: string,
  ): Promise<JudgeScore> {
    if (this.costAccumulator >= this.maxBudget) {
      throw new Error(
        `Budget ceiling reached: $${this.costAccumulator.toFixed(2)} >= $${this.maxBudget}`,
      );
    }

    const prompt = JUDGE_PROMPT
      .replace("{QUERY}", query)
      .replace("{RESULT}", result)
      .replace("{GROUND_TRUTH}", groundTruth);

    const [primaryResult, secondaryResult] = await Promise.all([
      this.callProvider(this.config.primary, prompt),
      this.callProvider(this.config.secondary, prompt),
    ]);

    const primaryRel = clampRelevance(primaryResult.relevance);
    const secondaryRel = clampRelevance(secondaryResult.relevance);
    const disagreement = Math.abs(primaryRel - secondaryRel) >= 2;

    const finalScore = disagreement
      ? Math.floor((primaryRel + secondaryRel) / 2)
      : primaryRel;

    return {
      queryId,
      resultId,
      primaryRelevance: primaryRel,
      secondaryRelevance: secondaryRel,
      finalScore,
      primaryReasoning: primaryResult.reasoning,
      secondaryReasoning: secondaryResult.reasoning,
      disagreement,
    };
  }

  getCostSoFar(): number {
    return this.costAccumulator;
  }

  private async callProvider(
    provider: JudgeProviderConfig,
    prompt: string,
  ): Promise<JudgeResponse> {
    if (provider.provider === "anthropic") {
      return this.callAnthropic(provider, prompt);
    }
    return this.callGoogle(provider, prompt);
  }

  private async callAnthropic(
    provider: JudgeProviderConfig,
    prompt: string,
  ): Promise<JudgeResponse> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic returned ${response.status}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    // Track cost (approximate: $15/MTok input, $75/MTok output for Opus)
    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    this.costAccumulator += (inputTokens * 15 + outputTokens * 75) / 1_000_000;

    const text = data.content?.[0]?.text ?? "";
    return parseJudgeResponse(text);
  }

  private async callGoogle(
    provider: JudgeProviderConfig,
    prompt: string,
  ): Promise<JudgeResponse> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": provider.apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Google returned ${response.status}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      };
    };

    // Track cost (approximate: $1.25/MTok input, $10/MTok output for Gemini Pro)
    const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
    this.costAccumulator += (inputTokens * 1.25 + outputTokens * 10) / 1_000_000;

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return parseJudgeResponse(text);
  }
}

function clampRelevance(value: number): number {
  return Math.max(0, Math.min(3, Math.round(value)));
}

function parseJudgeResponse(text: string): JudgeResponse {
  // Extract JSON from response (may have surrounding text)
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) {
    return { relevance: 0, reasoning: "Failed to parse judge response" };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { relevance?: number; reasoning?: string };
    return {
      relevance: typeof parsed.relevance === "number" ? parsed.relevance : 0,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  } catch {
    return { relevance: 0, reasoning: "JSON parse error" };
  }
}
