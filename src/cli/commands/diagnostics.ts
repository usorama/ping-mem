/**
 * Diagnostics commands: ingest, latest, list, diff, summary, summarize, compare, by-symbol
 */

import { defineCommand } from "citty";
import { createClient } from "../client.js";
import { printOutput, resolveFormat } from "../output.js";
import { outputArgs, serverArgs } from "../shared.js";
import * as fs from "node:fs";
import * as path from "node:path";

const ingest = defineCommand({
  meta: { name: "ingest", description: "Ingest diagnostics from SARIF file" },
  args: {
    sarifPath: { type: "positional", description: "Path to SARIF file", required: true },
    projectId: { type: "string", description: "Project ID", required: true },
    treeHash: { type: "string", description: "Git tree hash", required: true },
    toolName: { type: "string", description: "Tool name" },
    toolVersion: { type: "string", description: "Tool version" },
    configHash: { type: "string", description: "Config hash" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const sarifRaw = fs.readFileSync(path.resolve(args.sarifPath), "utf-8");
    const sarif = JSON.parse(sarifRaw);
    const body: Record<string, unknown> = {
      projectId: args.projectId,
      treeHash: args.treeHash,
      sarif,
    };
    if (args.toolName) body.toolName = args.toolName;
    if (args.toolVersion) body.toolVersion = args.toolVersion;
    if (args.configHash) body.configHash = args.configHash;
    const result = await client.post("/api/v1/diagnostics/ingest", body);
    printOutput(result, resolveFormat(args));
  },
});

const latest = defineCommand({
  meta: { name: "latest", description: "Get latest diagnostics run" },
  args: {
    projectId: { type: "string", description: "Project ID" },
    toolName: { type: "string", description: "Tool name" },
    treeHash: { type: "string", description: "Tree hash" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = {};
    if (args.projectId) params.projectId = args.projectId;
    if (args.toolName) params.toolName = args.toolName;
    if (args.treeHash) params.treeHash = args.treeHash;
    const result = await client.get("/api/v1/diagnostics/latest", params);
    printOutput(result, resolveFormat(args));
  },
});

const listCmd = defineCommand({
  meta: { name: "list", description: "List findings for an analysis" },
  args: {
    analysisId: { type: "positional", description: "Analysis ID", required: true },
    severity: { type: "string", description: "Filter by severity" },
    limit: { type: "string", description: "Max results" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = {};
    if (args.severity) params.severity = args.severity;
    if (args.limit) params.limit = args.limit;
    const result = await client.get(`/api/v1/diagnostics/findings/${encodeURIComponent(args.analysisId)}`, params);
    printOutput(result, resolveFormat(args));
  },
});

const diff = defineCommand({
  meta: { name: "diff", description: "Compare two diagnostics analyses" },
  args: {
    analysisIdA: { type: "string", description: "First analysis ID", required: true },
    analysisIdB: { type: "string", description: "Second analysis ID", required: true },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const result = await client.post("/api/v1/diagnostics/diff", {
      analysisIdA: args.analysisIdA,
      analysisIdB: args.analysisIdB,
    });
    printOutput(result, resolveFormat(args));
  },
});

const summary = defineCommand({
  meta: { name: "summary", description: "Get finding counts by severity" },
  args: {
    analysisId: { type: "positional", description: "Analysis ID", required: true },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const result = await client.get(`/api/v1/diagnostics/summary/${encodeURIComponent(args.analysisId)}`);
    printOutput(result, resolveFormat(args));
  },
});

const summarize = defineCommand({
  meta: { name: "summarize", description: "LLM-powered summary of an analysis" },
  args: {
    analysisId: { type: "positional", description: "Analysis ID", required: true },
    useLLM: { type: "boolean", description: "Use LLM for summary", default: true },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const body: Record<string, unknown> = {};
    if (args.useLLM !== undefined) body.useLLM = args.useLLM;
    const result = await client.post(`/api/v1/diagnostics/summarize/${encodeURIComponent(args.analysisId)}`, body);
    printOutput(result, resolveFormat(args));
  },
});

const compare = defineCommand({
  meta: { name: "compare", description: "Compare diagnostics across tools" },
  args: {
    projectId: { type: "string", description: "Project ID", required: true },
    treeHash: { type: "string", description: "Tree hash", required: true },
    toolNames: { type: "string", description: "Comma-separated tool names" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = {
      projectId: args.projectId,
      treeHash: args.treeHash,
    };
    if (args.toolNames) params.toolNames = args.toolNames;
    const result = await client.get("/api/v1/diagnostics/compare", params);
    printOutput(result, resolveFormat(args));
  },
});

const bySymbol = defineCommand({
  meta: { name: "by-symbol", description: "Group findings by symbol" },
  args: {
    analysisId: { type: "positional", description: "Analysis ID", required: true },
    groupBy: { type: "string", description: "Group by: symbol or file" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = { analysisId: args.analysisId };
    if (args.groupBy) params.groupBy = args.groupBy;
    const result = await client.get("/api/v1/diagnostics/by-symbol", params);
    printOutput(result, resolveFormat(args));
  },
});

export default defineCommand({
  meta: { name: "diagnostics", description: "Diagnostics and code quality tracking" },
  subCommands: { ingest, latest, list: listCmd, diff, summary, summarize, compare, "by-symbol": bySymbol },
});
