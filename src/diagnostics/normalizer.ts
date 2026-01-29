import * as crypto from "crypto";
import * as path from "path";
import type {
  DiagnosticSeverity,
  FindingInput,
  NormalizedFinding,
} from "./types.js";

export function normalizeSeverity(level?: string): DiagnosticSeverity {
  switch ((level ?? "").toLowerCase()) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "note":
      return "note";
    case "info":
    case "none":
    default:
      return "info";
  }
}

export function normalizeMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

export function normalizeFilePath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

export function normalizeFinding(
  input: FindingInput,
  analysisId: string
): NormalizedFinding {
  const normalized: NormalizedFinding = {
    findingId: "",
    analysisId,
    ruleId: input.ruleId.trim() || "unknown",
    severity: input.severity,
    message: normalizeMessage(input.message),
    filePath: normalizeFilePath(input.filePath),
    properties: input.properties ?? {},
  };

  if (input.startLine !== undefined) normalized.startLine = input.startLine;
  if (input.startColumn !== undefined) normalized.startColumn = input.startColumn;
  if (input.endLine !== undefined) normalized.endLine = input.endLine;
  if (input.endColumn !== undefined) normalized.endColumn = input.endColumn;
  if (input.chunkId !== undefined) normalized.chunkId = input.chunkId;
  if (input.fingerprint !== undefined) normalized.fingerprint = input.fingerprint;

  normalized.findingId = computeFindingId(normalized);
  return normalized;
}

export function normalizeFindings(
  inputs: FindingInput[],
  analysisId: string
): NormalizedFinding[] {
  const normalized = inputs.map((input) => normalizeFinding(input, analysisId));
  return normalized.sort((a, b) => sortFindingKey(a).localeCompare(sortFindingKey(b)));
}

export function computeFindingsDigest(findings: NormalizedFinding[]): string {
  const hash = crypto.createHash("sha256");
  for (const finding of findings) {
    hash.update(sortFindingKey(finding));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function computeAnalysisId(input: {
  projectId: string;
  treeHash: string;
  toolName: string;
  toolVersion: string;
  configHash: string;
  findingsDigest: string;
}): string {
  const hash = crypto.createHash("sha256");
  hash.update(input.projectId);
  hash.update("\n");
  hash.update(input.treeHash);
  hash.update("\n");
  hash.update(input.toolName);
  hash.update("\n");
  hash.update(input.toolVersion);
  hash.update("\n");
  hash.update(input.configHash);
  hash.update("\n");
  hash.update(input.findingsDigest);
  return hash.digest("hex");
}

function computeFindingId(finding: NormalizedFinding): string {
  const hash = crypto.createHash("sha256");
  hash.update(finding.analysisId);
  hash.update("\n");
  hash.update(sortFindingKey(finding));
  return hash.digest("hex");
}

function sortFindingKey(finding: NormalizedFinding): string {
  const startLine = finding.startLine ?? 0;
  const startColumn = finding.startColumn ?? 0;
  const endLine = finding.endLine ?? 0;
  const endColumn = finding.endColumn ?? 0;
  return [
    finding.filePath,
    startLine,
    startColumn,
    endLine,
    endColumn,
    finding.ruleId,
    finding.severity,
    finding.message,
    finding.fingerprint ?? "",
  ].join("|");
}
