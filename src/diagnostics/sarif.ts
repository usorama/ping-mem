import type { FindingInput, SarifParseResult } from "./types.js";
import { normalizeSeverity } from "./normalizer.js";

type SarifResult = Record<string, unknown>;

export function parseSarif(input: unknown): SarifParseResult {
  if (!input || typeof input !== "object") {
    return { findings: [] };
  }

  const sarif = input as Record<string, unknown>;
  const runs = Array.isArray(sarif.runs) ? sarif.runs : [];
  const findings: FindingInput[] = [];

  let toolName: string | undefined;
  let toolVersion: string | undefined;

  for (const run of runs) {
    if (!toolName || !toolVersion) {
      const tool = (run as Record<string, unknown>).tool as Record<string, unknown> | undefined;
      const driver = tool?.driver as Record<string, unknown> | undefined;
      if (driver) {
        toolName = toolName ?? (driver.name as string | undefined);
        toolVersion = toolVersion ?? (driver.version as string | undefined);
      }
    }

    const results = Array.isArray((run as Record<string, unknown>).results)
      ? ((run as Record<string, unknown>).results as SarifResult[])
      : [];

    for (const result of results) {
      const messageObj = result.message as Record<string, unknown> | undefined;
      const messageText = (messageObj?.text as string | undefined) ?? "";
      const ruleId =
        (result.ruleId as string | undefined) ??
        ((result.rule as Record<string, unknown> | undefined)?.id as string | undefined) ??
        "unknown";

      const level = (result.level as string | undefined) ?? "info";
      const severity = normalizeSeverity(level);

      const locations = Array.isArray(result.locations) ? result.locations : [];
      const location = locations[0] as Record<string, unknown> | undefined;
      const physical = location?.physicalLocation as Record<string, unknown> | undefined;
      const artifact = physical?.artifactLocation as Record<string, unknown> | undefined;
      const region = physical?.region as Record<string, unknown> | undefined;

      const uri = (artifact?.uri as string | undefined) ?? "";
      const filePath = uri.replace(/^file:\/\//, "");

      const finding: FindingInput = {
        ruleId,
        severity,
        message: messageText,
        filePath,
      };

      const startLine = region?.startLine as number | undefined;
      const startColumn = region?.startColumn as number | undefined;
      const endLine = region?.endLine as number | undefined;
      const endColumn = region?.endColumn as number | undefined;
      if (startLine !== undefined) finding.startLine = startLine;
      if (startColumn !== undefined) finding.startColumn = startColumn;
      if (endLine !== undefined) finding.endLine = endLine;
      if (endColumn !== undefined) finding.endColumn = endColumn;

      const fingerprints = result.fingerprints as Record<string, unknown> | undefined;
      const partial = result.partialFingerprints as Record<string, unknown> | undefined;
      const fingerprint =
        (fingerprints?.primaryLocationLineHash as string | undefined) ??
        (partial?.primaryLocationLineHash as string | undefined);
      if (fingerprint) {
        finding.fingerprint = fingerprint;
      }

      finding.properties = {
        kind: result.kind,
        level: result.level,
        baselineState: result.baselineState,
      };

      findings.push(finding);
    }
  }

  return { findings, toolName, toolVersion };
}
