/**
 * SummaryGenerator: LLM-powered diagnostics summaries
 * 
 * Non-deterministic component clearly marked.
 * Always backed by deterministic findings.
 */

import type { NormalizedFinding } from "./types.js";
import type { SummaryCache } from "./SummaryCache.js";

export interface LLMProvider {
  name: string;
  generateSummary(findings: NormalizedFinding[]): Promise<SummaryResult>;
}

export interface SummaryResult {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd?: number | undefined;
}

export interface DiagnosticSummary {
  summaryId: string;
  analysisId: string;
  summaryText: string;
  llmModel: string;
  llmProvider: string;
  generatedAt: string;
  promptTokens: number;
  completionTokens: number;
  costUsd?: number | undefined;
  sourceFindingIds: string[];
  isFromCache: boolean;
}

export class SummaryGenerator {
  constructor(
    private provider: LLMProvider,
    private cache: SummaryCache
  ) {}

  async summarize(
    analysisId: string,
    findings: NormalizedFinding[],
    forceRefresh: boolean = false
  ): Promise<DiagnosticSummary> {
    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = this.cache.get(analysisId);
      if (cached) {
        return {
          ...cached,
          isFromCache: true,
        };
      }
    }

    // Generate new summary via LLM
    const result = await this.provider.generateSummary(findings);

    // Create summary object
    const summary: DiagnosticSummary = {
      summaryId: this.generateSummaryId(analysisId),
      analysisId,
      summaryText: result.text,
      llmModel: result.model,
      llmProvider: this.provider.name,
      generatedAt: new Date().toISOString(),
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costUsd: result.costUsd,
      sourceFindingIds: findings.map(f => f.findingId),
      isFromCache: false,
    };

    // Store in cache
    this.cache.set(analysisId, summary);

    return summary;
  }

  private generateSummaryId(analysisId: string): string {
    return `summary-${analysisId}-${Date.now()}`;
  }
}

/**
 * OpenAI LLM Provider
 */
export class OpenAIProvider implements LLMProvider {
  name = "openai";

  constructor(private apiKey: string, private model: string = "gpt-4o-mini") {}

  async generateSummary(findings: NormalizedFinding[]): Promise<SummaryResult> {
    // Group findings by severity and file
    const bySeverity: Record<string, number> = {};
    const byFile: Record<string, number> = {};
    const bySymbol = new Map<string, { name: string; kind: string; count: number }>();

    for (const finding of findings) {
      bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
      byFile[finding.filePath] = (byFile[finding.filePath] ?? 0) + 1;

      if (finding.symbolName) {
        const key = `${finding.filePath}:${finding.symbolName}`;
        if (!bySymbol.has(key)) {
          bySymbol.set(key, {
            name: finding.symbolName,
            kind: finding.symbolKind ?? "unknown",
            count: 0,
          });
        }
        bySymbol.get(key)!.count += 1;
      }
    }

    // Format prompt
    const prompt = this.buildPrompt(findings, bySeverity, byFile, bySymbol);

    // Call OpenAI API
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: "system",
            content: "You are a code analysis assistant. Provide concise, actionable summaries of diagnostic findings.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
      model: string;
    };

    const text = data.choices[0]?.message?.content ?? "No summary generated";
    const usage = data.usage;

    // Estimate cost (GPT-4o-mini pricing as of 2026)
    const costUsd = (usage.prompt_tokens * 0.00015 / 1000) + (usage.completion_tokens * 0.0006 / 1000);

    return {
      text,
      model: data.model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      costUsd,
    };
  }

  private buildPrompt(
    findings: NormalizedFinding[],
    bySeverity: Record<string, number>,
    byFile: Record<string, number>,
    bySymbol: Map<string, { name: string; kind: string; count: number }>
  ): string {
    const lines: string[] = [];

    lines.push(`Analyze the following diagnostic findings and provide a concise summary:\n`);
    lines.push(`Total findings: ${findings.length}`);
    lines.push(`\nBy severity:`);
    for (const [severity, count] of Object.entries(bySeverity).sort(([a], [b]) => b.localeCompare(a))) {
      lines.push(`  - ${severity}: ${count}`);
    }

    lines.push(`\nTop affected files:`);
    const topFiles = Object.entries(byFile)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);
    for (const [file, count] of topFiles) {
      lines.push(`  - ${file}: ${count} findings`);
    }

    if (bySymbol.size > 0) {
      lines.push(`\nTop affected symbols:`);
      const topSymbols = Array.from(bySymbol.entries())
        .sort(([, a], [, b]) => b.count - a.count)
        .slice(0, 5);
      for (const [key, symbol] of topSymbols) {
        lines.push(`  - ${symbol.name} (${symbol.kind}): ${symbol.count} findings`);
      }
    }

    lines.push(`\nSample findings (first 3):`);
    for (const finding of findings.slice(0, 3)) {
      const location = finding.symbolName 
        ? `${finding.filePath}:${finding.symbolName}`
        : `${finding.filePath}:${finding.startLine ?? '?'}`;
      lines.push(`  - [${finding.severity}] ${finding.ruleId}: ${finding.message} (${location})`);
    }

    lines.push(`\nProvide a 2-3 sentence summary highlighting:`);
    lines.push(`1. The overall quality assessment`);
    lines.push(`2. The most critical issues`);
    lines.push(`3. Recommended actions`);

    return lines.join("\n");
  }
}
