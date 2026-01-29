#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

import { ProjectScanner } from "./ingest/ProjectScanner.js";
import { DiagnosticsStore } from "./diagnostics/DiagnosticsStore.js";
import {
  parseSarif,
  normalizeFindings,
  computeFindingsDigest,
  computeAnalysisId,
} from "./diagnostics/index.js";
import { EventStore } from "./storage/EventStore.js";
import { SessionManager } from "./session/SessionManager.js";
import type { WorklogEventData } from "./types/index.js";

type ArgMap = Record<string, string | boolean>;

function parseArgs(argv: string[]): { command: string; args: ArgMap } {
  const args: ArgMap = {};
  const [command, ...rest] = argv;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token) continue;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return { command: command ?? "help", args };
}

function getArg(args: ArgMap, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function getBool(args: ArgMap, key: string, defaultValue: boolean): boolean {
  const value = args[key];
  if (typeof value === "boolean") return value;
  return defaultValue;
}

function printHelp(): void {
  console.log(`
ping-mem diagnostics collector

Usage:
  ping-mem collect --projectDir <path> --configHash <hash> --sarifPath <file> [options]

Options:
  --toolName <name>            Tool name (optional if SARIF provides it)
  --toolVersion <version>      Tool version (optional if SARIF provides it)
  --sarifPaths <paths>         Comma-separated list of SARIF file paths (for batch ingestion)
  --environmentHash <hash>     Environment hash
  --status <passed|failed|partial>
  --durationMs <number>
  --diagnosticsDbPath <path>   Diagnostics DB path
  --eventsDbPath <path>        Event store DB path
  --sessionName <name>         Session name for worklog
  --recordWorklog              Record a worklog event (default: true)

Examples:
  ping-mem collect --projectDir . --configHash abc123 --sarifPath results.sarif
  ping-mem collect --projectDir . --configHash abc123 --sarifPath results.sarif --toolName eslint --toolVersion 9.0.0
  ping-mem collect --projectDir . --configHash abc123 --sarifPaths "tsc.sarif,eslint.sarif,prettier.sarif"
`);
}

function getCommitHash(projectDir: string): string | undefined {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

async function collectDiagnostics(args: ArgMap): Promise<void> {
  const projectDir = getArg(args, "projectDir");
  const configHash = getArg(args, "configHash");
  const sarifPath = getArg(args, "sarifPath");
  const sarifPaths = getArg(args, "sarifPaths");
  
  if (!projectDir || !configHash) {
    throw new Error("projectDir and configHash are required.");
  }

  if (!sarifPath && !sarifPaths) {
    throw new Error("Either sarifPath or sarifPaths is required.");
  }

  // Parse SARIF paths (single or batch)
  const paths = sarifPaths 
    ? sarifPaths.split(",").map(p => p.trim())
    : [sarifPath!];

  const scanner = new ProjectScanner();
  const scan = scanner.scanProject(projectDir);
  const projectId = scan.manifest.projectId;
  const treeHash = scan.manifest.treeHash;

  const diagnosticsDbPath = getArg(args, "diagnosticsDbPath");
  const diagnosticsStore = new DiagnosticsStore(
    diagnosticsDbPath ? { dbPath: diagnosticsDbPath } : {}
  );

  const results: Array<{
    analysisId: string;
    runId: string;
    toolName: string;
    findingsCount: number;
  }> = [];

  // Process each SARIF file
  for (const sarifFilePath of paths) {
    const sarifRaw = fs.readFileSync(path.resolve(sarifFilePath), "utf-8");
    const sarifPayload = JSON.parse(sarifRaw);

    const parsed = parseSarif(sarifPayload);
    const toolName = getArg(args, "toolName") ?? parsed.toolName ?? "unknown";
    const toolVersion = getArg(args, "toolVersion") ?? parsed.toolVersion ?? "unknown";
    const environmentHash = getArg(args, "environmentHash");
    const statusArg = getArg(args, "status");
    const durationMs = getArg(args, "durationMs");

    const tempFindings = normalizeFindings(parsed.findings, "temp-analysis");
    const findingsDigest = computeFindingsDigest(tempFindings);
    const analysisId = computeAnalysisId({
      projectId,
      treeHash,
      toolName,
      toolVersion,
      configHash,
      findingsDigest,
    });
    const normalizedFindings = normalizeFindings(parsed.findings, analysisId);

    const runId = diagnosticsStore.createRunId();
    const diagnosticStatus =
      (statusArg as "passed" | "failed" | "partial" | undefined) ??
      (normalizedFindings.length === 0 ? "passed" : "failed");

    diagnosticsStore.saveRun(
      {
        runId,
        analysisId,
        projectId,
        treeHash,
        commitHash: getCommitHash(projectDir) ?? undefined,
        tool: { name: toolName, version: toolVersion },
        configHash,
        environmentHash: environmentHash ?? undefined,
        status: diagnosticStatus,
        createdAt: new Date().toISOString(),
        durationMs: durationMs ? parseInt(durationMs, 10) : undefined,
        findingsDigest,
        rawSarif: sarifRaw,
        metadata: {},
      },
      normalizedFindings
    );

    results.push({
      analysisId,
      runId,
      toolName,
      findingsCount: normalizedFindings.length,
    });
  }

  // Record worklog if requested
  const recordWorklog = getBool(args, "recordWorklog", true);
  if (recordWorklog) {
    const eventsDbPath = getArg(args, "eventsDbPath");
    const eventStore = new EventStore(eventsDbPath ? { dbPath: eventsDbPath } : {});
    const sessionManager = new SessionManager({ eventStore });
    const session = await sessionManager.startSession({
      name: getArg(args, "sessionName") ?? "collector",
      projectDir,
    });

    for (const result of results) {
      const worklogStatus = result.findingsCount === 0 ? "success" : "failed";
      const payload: WorklogEventData = {
        sessionId: session.id,
        kind: "diagnostics",
        title: `${result.toolName} diagnostics`,
        status: worklogStatus,
        toolName: result.toolName,
        configHash,
        environmentHash: getArg(args, "environmentHash"),
        projectId,
        treeHash,
        commitHash: getCommitHash(projectDir) ?? undefined,
        runId: result.runId,
        summary: `${result.findingsCount} findings`,
      };

      await eventStore.createEvent(session.id, "DIAGNOSTICS_INGESTED", payload, {
        toolName: result.toolName,
        projectId,
        treeHash,
        runId: result.runId,
      });
    }

    await sessionManager.endSession(session.id, "collector");
    await eventStore.close();
    await sessionManager.close();
  }

  diagnosticsStore.close();

  console.log(
    JSON.stringify(
      {
        success: true,
        projectId,
        treeHash,
        results,
        totalFindings: results.reduce((sum, r) => sum + r.findingsCount, 0),
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "collect") {
    await collectDiagnostics(args);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unknown error");
  process.exit(1);
});
