export type DiagnosticSeverity = "error" | "warning" | "info" | "note";

export type DiagnosticStatus = "passed" | "failed" | "partial";

export interface DiagnosticToolIdentity {
  name: string;
  version: string;
}

export interface DiagnosticRunMetadata {
  [key: string]: unknown;
}

export interface DiagnosticRun {
  runId: string;
  analysisId: string;
  projectId: string;
  treeHash: string;
  commitHash?: string | undefined;
  tool: DiagnosticToolIdentity;
  configHash: string;
  environmentHash?: string | undefined;
  status: DiagnosticStatus;
  createdAt: string;
  durationMs?: number | undefined;
  findingsDigest: string;
  rawSarif?: string | undefined;
  metadata: DiagnosticRunMetadata;
}

export interface NormalizedFinding {
  findingId: string;
  analysisId: string;
  ruleId: string;
  severity: DiagnosticSeverity;
  message: string;
  filePath: string;
  startLine?: number | undefined;
  startColumn?: number | undefined;
  endLine?: number | undefined;
  endColumn?: number | undefined;
  chunkId?: string | undefined;
  fingerprint?: string | undefined;
  properties: Record<string, unknown>;
}

export interface FindingInput {
  ruleId: string;
  severity: DiagnosticSeverity;
  message: string;
  filePath: string;
  startLine?: number | undefined;
  startColumn?: number | undefined;
  endLine?: number | undefined;
  endColumn?: number | undefined;
  chunkId?: string | undefined;
  fingerprint?: string | undefined;
  properties?: Record<string, unknown> | undefined;
}

export interface SarifParseResult {
  findings: FindingInput[];
  toolName?: string | undefined;
  toolVersion?: string | undefined;
}

export interface DiagnosticsQueryFilter {
  projectId: string;
  toolName?: string | undefined;
  toolVersion?: string | undefined;
  treeHash?: string | undefined;
}
