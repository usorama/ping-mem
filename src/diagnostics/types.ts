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
  commitHash?: string;
  tool: DiagnosticToolIdentity;
  configHash: string;
  environmentHash?: string;
  status: DiagnosticStatus;
  createdAt: string;
  durationMs?: number;
  findingsDigest: string;
  rawSarif?: string;
  metadata: DiagnosticRunMetadata;
}

export interface NormalizedFinding {
  findingId: string;
  analysisId: string;
  ruleId: string;
  severity: DiagnosticSeverity;
  message: string;
  filePath: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  chunkId?: string;
  fingerprint?: string;
  properties: Record<string, unknown>;
}

export interface FindingInput {
  ruleId: string;
  severity: DiagnosticSeverity;
  message: string;
  filePath: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  chunkId?: string;
  fingerprint?: string;
  properties?: Record<string, unknown>;
}

export interface SarifParseResult {
  findings: FindingInput[];
  toolName?: string;
  toolVersion?: string;
}

export interface DiagnosticsQueryFilter {
  projectId: string;
  toolName?: string;
  toolVersion?: string;
  treeHash?: string;
}
