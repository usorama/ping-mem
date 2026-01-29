/**
 * SummaryCache: SQLite-backed cache for LLM diagnostic summaries
 * 
 * Content-addressable: Same analysisId -> same cached summary
 */

import { Database } from "bun:sqlite";
import type { DiagnosticSummary } from "./SummaryGenerator.js";

export interface SummaryCacheConfig {
  db: Database;
}

interface SummaryCacheRow {
  summary_id: string;
  analysis_id: string;
  summary_text: string;
  llm_model: string;
  llm_provider: string;
  generated_at: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number | null;
  source_finding_ids: string;
}

export class SummaryCache {
  private db: Database;

  constructor(config: SummaryCacheConfig) {
    this.db = config.db;
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS diagnostic_summaries (
        summary_id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        llm_model TEXT NOT NULL,
        llm_provider TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        cost_usd REAL,
        source_finding_ids TEXT NOT NULL,
        UNIQUE(analysis_id)
      );

      CREATE INDEX IF NOT EXISTS idx_summaries_analysis
        ON diagnostic_summaries(analysis_id);
    `);
  }

  get(analysisId: string): DiagnosticSummary | null {
    const stmt = this.db.prepare(`
      SELECT * FROM diagnostic_summaries
      WHERE analysis_id = $analysis_id
      LIMIT 1
    `);

    const row = stmt.get({ $analysis_id: analysisId }) as SummaryCacheRow | undefined;
    if (!row) {
      return null;
    }

    return this.rowToSummary(row);
  }

  set(analysisId: string, summary: DiagnosticSummary): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO diagnostic_summaries (
        summary_id, analysis_id, summary_text, llm_model, llm_provider,
        generated_at, prompt_tokens, completion_tokens, cost_usd, source_finding_ids
      ) VALUES (
        $summary_id, $analysis_id, $summary_text, $llm_model, $llm_provider,
        $generated_at, $prompt_tokens, $completion_tokens, $cost_usd, $source_finding_ids
      )
    `);

    stmt.run({
      $summary_id: summary.summaryId,
      $analysis_id: summary.analysisId,
      $summary_text: summary.summaryText,
      $llm_model: summary.llmModel,
      $llm_provider: summary.llmProvider,
      $generated_at: summary.generatedAt,
      $prompt_tokens: summary.promptTokens,
      $completion_tokens: summary.completionTokens,
      $cost_usd: summary.costUsd ?? null,
      $source_finding_ids: JSON.stringify(summary.sourceFindingIds),
    });
  }

  private rowToSummary(row: SummaryCacheRow): DiagnosticSummary {
    const summary: DiagnosticSummary = {
      summaryId: row.summary_id,
      analysisId: row.analysis_id,
      summaryText: row.summary_text,
      llmModel: row.llm_model,
      llmProvider: row.llm_provider,
      generatedAt: row.generated_at,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      sourceFindingIds: JSON.parse(row.source_finding_ids) as string[],
      isFromCache: true,
    };

    if (row.cost_usd !== null) {
      summary.costUsd = row.cost_usd;
    }

    return summary;
  }
}
