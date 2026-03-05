/**
 * Diagnostics tool handlers — ingest, query, diff, summarize diagnostics.
 *
 * Tools: diagnostics_ingest, diagnostics_latest, diagnostics_list,
 * diagnostics_diff, diagnostics_summary, diagnostics_summarize,
 * diagnostics_by_symbol, diagnostics_compare_tools
 *
 * @module mcp/handlers/DiagnosticsToolModule
 */

import type { ToolDefinition, ToolModule } from "../types.js";
import type { SessionState } from "./shared.js";
import {
  parseSarif,
  normalizeFindings,
  computeFindingsDigest,
  computeAnalysisId,
} from "../../diagnostics/index.js";
import type { FindingInput } from "../../diagnostics/types.js";

// ============================================================================
// Tool Schemas
// ============================================================================

export const DIAGNOSTICS_TOOLS: ToolDefinition[] = [
  {
    name: "diagnostics_ingest",
    description: "Ingest diagnostics results (SARIF 2.1.0 or normalized findings).",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID" },
        treeHash: { type: "string", description: "Tree hash" },
        commitHash: { type: "string", description: "Optional commit hash" },
        toolName: { type: "string", description: "Tool name (optional if SARIF provides it)" },
        toolVersion: { type: "string", description: "Tool version (optional if SARIF provides it)" },
        configHash: { type: "string", description: "Deterministic config hash" },
        environmentHash: { type: "string", description: "Environment hash" },
        status: {
          type: "string",
          enum: ["passed", "failed", "partial"],
          description: "Run status",
        },
        durationMs: { type: "number", description: "Duration in milliseconds" },
        sarif: { type: ["object", "string"], description: "SARIF 2.1.0 payload" },
        findings: {
          type: "array",
          description: "Normalized findings (optional alternative to SARIF)",
          items: { type: "object" },
        },
        metadata: { type: "object", description: "Additional metadata" },
      },
      required: ["projectId", "treeHash", "configHash"],
    },
  },
  {
    name: "diagnostics_latest",
    description: "Get latest diagnostics run for a project/tool/treeHash.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID" },
        toolName: { type: "string", description: "Tool name" },
        toolVersion: { type: "string", description: "Tool version" },
        treeHash: { type: "string", description: "Tree hash" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "diagnostics_list",
    description: "List findings for a specific analysisId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        analysisId: { type: "string", description: "Analysis ID" },
      },
      required: ["analysisId"],
    },
  },
  {
    name: "diagnostics_diff",
    description: "Diff two analyses by analysisId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        analysisIdA: { type: "string", description: "Base analysis ID" },
        analysisIdB: { type: "string", description: "Compare analysis ID" },
      },
      required: ["analysisIdA", "analysisIdB"],
    },
  },
  {
    name: "diagnostics_summary",
    description: "Summarize findings for a specific analysisId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        analysisId: { type: "string", description: "Analysis ID" },
      },
      required: ["analysisId"],
    },
  },
  {
    name: "diagnostics_compare_tools",
    description: "Compare diagnostics across multiple tools for the same project state (treeHash).",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID" },
        treeHash: { type: "string", description: "Tree hash" },
        toolNames: {
          type: "array",
          items: { type: "string" },
          description: "Filter by specific tool names (optional)",
        },
      },
      required: ["projectId", "treeHash"],
    },
  },
  {
    name: "diagnostics_by_symbol",
    description: "Group diagnostic findings by symbol.",
    inputSchema: {
      type: "object" as const,
      properties: {
        analysisId: { type: "string", description: "Analysis ID" },
        groupBy: {
          type: "string",
          enum: ["symbol", "file"],
          description: "Group by symbol or file (default: symbol)",
        },
      },
      required: ["analysisId"],
    },
  },
  {
    name: "diagnostics_summarize",
    description: "Generate or retrieve LLM-powered summary of diagnostic findings.",
    inputSchema: {
      type: "object" as const,
      properties: {
        analysisId: { type: "string", description: "Analysis ID" },
        useLLM: {
          type: "boolean",
          description: "Use LLM to generate summary (default: false for raw findings)",
        },
        forceRefresh: {
          type: "boolean",
          description: "Bypass cache and regenerate summary (default: false)",
        },
      },
      required: ["analysisId"],
    },
  },
];

// ============================================================================
// Module
// ============================================================================

export class DiagnosticsToolModule implements ToolModule {
  readonly tools: ToolDefinition[] = DIAGNOSTICS_TOOLS;
  private readonly state: SessionState;

  constructor(state: SessionState) {
    this.state = state;
  }

  handle(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> | undefined {
    switch (name) {
      case "diagnostics_ingest":
        return this.handleDiagnosticsIngest(args);
      case "diagnostics_latest":
        return this.handleDiagnosticsLatest(args);
      case "diagnostics_list":
        return this.handleDiagnosticsList(args);
      case "diagnostics_diff":
        return this.handleDiagnosticsDiff(args);
      case "diagnostics_summary":
        return this.handleDiagnosticsSummary(args);
      case "diagnostics_compare_tools":
        return this.handleDiagnosticsCompareTools(args);
      case "diagnostics_by_symbol":
        return this.handleDiagnosticsBySymbol(args);
      case "diagnostics_summarize":
        return this.handleDiagnosticsSummarize(args);
      default:
        return undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Handlers (moved verbatim from PingMemServer)
  // --------------------------------------------------------------------------

  private async handleDiagnosticsIngest(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.diagnosticsStore) {
      throw new Error("DiagnosticsStore not configured.");
    }

    const projectId = args.projectId as string;
    const treeHash = args.treeHash as string;
    const commitHash = args.commitHash as string | undefined;
    const configHash = args.configHash as string;
    const environmentHash = args.environmentHash as string | undefined;
    const status = (args.status as "passed" | "failed" | "partial" | undefined) ?? "failed";
    const durationMs = args.durationMs as number | undefined;
    const metadata = (args.metadata as Record<string, unknown> | undefined) ?? {};

    let findings: FindingInput[] = [];
    let toolName = args.toolName as string | undefined;
    let toolVersion = args.toolVersion as string | undefined;
    let rawSarif: string | undefined;

    if (args.sarif !== undefined) {
      const sarifPayload = typeof args.sarif === "string" ? JSON.parse(args.sarif) : args.sarif;
      const parsed = parseSarif(sarifPayload);
      findings = parsed.findings;
      toolName = toolName ?? parsed.toolName;
      toolVersion = toolVersion ?? parsed.toolVersion;
      rawSarif = typeof args.sarif === "string" ? args.sarif : JSON.stringify(args.sarif);
    } else if (Array.isArray(args.findings)) {
      findings = args.findings as FindingInput[];
    } else {
      throw new Error("Diagnostics ingest requires sarif or findings.");
    }

    if (!toolName || !toolVersion) {
      throw new Error("toolName and toolVersion are required (or must be in SARIF).");
    }

    const tempFindings = normalizeFindings(findings, "temp-analysis");
    const findingsDigest = computeFindingsDigest(tempFindings);
    const analysisId = computeAnalysisId({
      projectId,
      treeHash,
      toolName,
      toolVersion,
      configHash,
      findingsDigest,
    });

    const normalizedFindings = normalizeFindings(findings, analysisId);
    const runId = this.state.diagnosticsStore.createRunId();

    this.state.diagnosticsStore.saveRun(
      {
        runId,
        analysisId,
        projectId,
        treeHash,
        commitHash,
        tool: { name: toolName, version: toolVersion },
        configHash,
        environmentHash,
        status,
        createdAt: new Date().toISOString(),
        durationMs,
        findingsDigest,
        rawSarif,
        metadata,
      },
      normalizedFindings
    );

    return {
      success: true,
      runId,
      analysisId,
      findingsCount: normalizedFindings.length,
      toolName,
      toolVersion,
      treeHash,
    };
  }

  private async handleDiagnosticsLatest(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.diagnosticsStore) {
      throw new Error("DiagnosticsStore not configured.");
    }

    const result = this.state.diagnosticsStore.getLatestRun({
      projectId: args.projectId as string,
      toolName: args.toolName as string | undefined,
      toolVersion: args.toolVersion as string | undefined,
      treeHash: args.treeHash as string | undefined,
    });

    if (!result) {
      return { found: false };
    }

    return { found: true, run: result };
  }

  private async handleDiagnosticsList(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.diagnosticsStore) {
      throw new Error("DiagnosticsStore not configured.");
    }

    const analysisId = args.analysisId as string;
    const findings = this.state.diagnosticsStore.listFindings(analysisId);

    return {
      analysisId,
      count: findings.length,
      findings,
    };
  }

  private async handleDiagnosticsDiff(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.diagnosticsStore) {
      throw new Error("DiagnosticsStore not configured.");
    }

    const analysisIdA = args.analysisIdA as string;
    const analysisIdB = args.analysisIdB as string;
    const diff = this.state.diagnosticsStore.diffAnalyses(analysisIdA, analysisIdB);

    return {
      analysisIdA,
      analysisIdB,
      ...diff,
    };
  }

  private async handleDiagnosticsSummary(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.diagnosticsStore) {
      throw new Error("DiagnosticsStore not configured.");
    }

    const analysisId = args.analysisId as string;
    const findings = this.state.diagnosticsStore.listFindings(analysisId);
    const counts: Record<string, number> = {};

    for (const finding of findings) {
      counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
    }

    return {
      analysisId,
      total: findings.length,
      bySeverity: counts,
    };
  }

  private async handleDiagnosticsSummarize(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.diagnosticsStore) {
      throw new Error("DiagnosticsStore not configured.");
    }

    const analysisId = args.analysisId as string;
    const useLLM = args.useLLM === true;
    const forceRefresh = args.forceRefresh === true;

    const findings = this.state.diagnosticsStore.listFindings(analysisId);

    if (!useLLM) {
      // Return raw findings (deterministic)
      return {
        analysisId,
        useLLM: false,
        total: findings.length,
        findings: findings.slice(0, 100), // Limit to first 100 for output size
      };
    }

    // Generate LLM summary
    if (!this.state.summaryGenerator) {
      return {
        error: "LLM summarization not available. Set OPENAI_API_KEY environment variable.",
        fallbackAvailable: true,
        suggestion: "Retry with useLLM: false to get raw findings",
      };
    }

    try {
      const summary = await this.state.summaryGenerator.summarize(analysisId, findings, forceRefresh);
      return {
        analysisId,
        useLLM: true,
        summary: {
          text: summary.summaryText,
          model: summary.llmModel,
          provider: summary.llmProvider,
          generatedAt: summary.generatedAt,
          promptTokens: summary.promptTokens,
          completionTokens: summary.completionTokens,
          costUsd: summary.costUsd,
          isFromCache: summary.isFromCache,
        },
        findingsCount: findings.length,
        sourceFindingIds: summary.sourceFindingIds.slice(0, 10), // First 10 for reference
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        error: `Failed to generate summary: ${errorMessage}`,
        fallbackAvailable: true,
        suggestion: "Retry with useLLM: false to get raw findings",
      };
    }
  }

  private async handleDiagnosticsBySymbol(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.diagnosticsStore) {
      throw new Error("DiagnosticsStore not configured.");
    }

    const analysisId = args.analysisId as string;
    const groupBy = (args.groupBy as string | undefined) ?? "symbol";
    const findings = this.state.diagnosticsStore.listFindings(analysisId);

    if (groupBy === "symbol") {
      // Group by symbol
      const symbolGroups = new Map<string, {
        symbolName: string;
        symbolKind: string;
        filePath: string;
        findings: typeof findings;
        bySeverity: Record<string, number>;
      }>();

      for (const finding of findings) {
        if (!finding.symbolId || !finding.symbolName) {
          // No symbol attribution
          continue;
        }

        if (!symbolGroups.has(finding.symbolId)) {
          symbolGroups.set(finding.symbolId, {
            symbolName: finding.symbolName,
            symbolKind: finding.symbolKind ?? "unknown",
            filePath: finding.filePath,
            findings: [],
            bySeverity: {},
          });
        }

        const group = symbolGroups.get(finding.symbolId)!;
        group.findings.push(finding);
        group.bySeverity[finding.severity] = (group.bySeverity[finding.severity] ?? 0) + 1;
      }

      const symbols = Array.from(symbolGroups.entries()).map(([symbolId, group]) => ({
        symbolId,
        symbolName: group.symbolName,
        symbolKind: group.symbolKind,
        filePath: group.filePath,
        total: group.findings.length,
        bySeverity: group.bySeverity,
      })).sort((a, b) => b.total - a.total);

      return {
        analysisId,
        groupBy: "symbol",
        symbolCount: symbols.length,
        symbols,
        totalAttributed: symbols.reduce((sum, s) => sum + s.total, 0),
        totalUnattributed: findings.filter(f => !f.symbolId).length,
      };
    } else {
      // Group by file
      const fileGroups = new Map<string, {
        symbols: Map<string, {
          symbolName: string;
          symbolKind: string;
          count: number;
        }>;
        total: number;
      }>();

      for (const finding of findings) {
        if (!fileGroups.has(finding.filePath)) {
          fileGroups.set(finding.filePath, {
            symbols: new Map(),
            total: 0,
          });
        }

        const group = fileGroups.get(finding.filePath)!;
        group.total += 1;

        if (finding.symbolId && finding.symbolName) {
          if (!group.symbols.has(finding.symbolId)) {
            group.symbols.set(finding.symbolId, {
              symbolName: finding.symbolName,
              symbolKind: finding.symbolKind ?? "unknown",
              count: 0,
            });
          }
          group.symbols.get(finding.symbolId)!.count += 1;
        }
      }

      const files = Array.from(fileGroups.entries()).map(([filePath, group]) => ({
        filePath,
        total: group.total,
        symbols: Array.from(group.symbols.entries()).map(([symbolId, symbol]) => ({
          symbolId,
          symbolName: symbol.symbolName,
          symbolKind: symbol.symbolKind,
          count: symbol.count,
        })).sort((a, b) => b.count - a.count),
      })).sort((a, b) => b.total - a.total);

      return {
        analysisId,
        groupBy: "file",
        fileCount: files.length,
        files,
      };
    }
  }

  private async handleDiagnosticsCompareTools(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.diagnosticsStore) {
      throw new Error("DiagnosticsStore not configured.");
    }

    const projectId = args.projectId as string;
    const treeHash = args.treeHash as string;
    const toolNames = args.toolNames as string[] | undefined;

    // Query all tools for this project + treeHash
    const allRuns: Array<{
      toolName: string;
      analysisId: string;
      status: string;
      createdAt: string;
    }> = [];

    // Get list of unique tools (we need to query one by one)
    const toolsToQuery = toolNames ?? ["tsc", "eslint", "prettier"];

    for (const toolName of toolsToQuery) {
      const run = this.state.diagnosticsStore.getLatestRun({
        projectId,
        treeHash,
        toolName,
      });

      if (run) {
        allRuns.push({
          toolName: run.tool.name,
          analysisId: run.analysisId,
          status: run.status,
          createdAt: run.createdAt,
        });
      }
    }

    // Get findings summaries for each tool
    const toolSummaries = allRuns.map(run => {
      const findings = this.state.diagnosticsStore!.listFindings(run.analysisId);
      const bySeverity: Record<string, number> = {};
      const fileSet = new Set<string>();

      for (const finding of findings) {
        bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
        fileSet.add(finding.filePath);
      }

      return {
        toolName: run.toolName,
        analysisId: run.analysisId,
        status: run.status,
        createdAt: run.createdAt,
        total: findings.length,
        bySeverity,
        affectedFiles: fileSet.size,
      };
    });

    // Find overlapping files
    const allFiles = new Map<string, string[]>();
    for (const run of allRuns) {
      const findings = this.state.diagnosticsStore!.listFindings(run.analysisId);
      for (const finding of findings) {
        if (!allFiles.has(finding.filePath)) {
          allFiles.set(finding.filePath, []);
        }
        allFiles.get(finding.filePath)!.push(run.toolName);
      }
    }

    const overlappingFiles = Array.from(allFiles.entries())
      .filter(([_, tools]) => tools.length > 1)
      .map(([filePath, tools]) => ({
        filePath,
        tools: Array.from(new Set(tools)).sort(),
      }));

    // Aggregate severity counts
    const aggregateSeverity: Record<string, number> = {};
    for (const summary of toolSummaries) {
      for (const [severity, count] of Object.entries(summary.bySeverity)) {
        aggregateSeverity[severity] = (aggregateSeverity[severity] ?? 0) + count;
      }
    }

    return {
      projectId,
      treeHash,
      toolCount: toolSummaries.length,
      tools: toolSummaries,
      overlappingFiles: overlappingFiles.slice(0, 20), // Limit to top 20
      aggregateSeverity,
      totalFindings: toolSummaries.reduce((sum, s) => sum + s.total, 0),
    };
  }
}
