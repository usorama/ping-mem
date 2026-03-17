/**
 * Codebase commands: ingest, verify, search, timeline, projects, delete
 */

import { defineCommand } from "citty";
import { createClient } from "../client.js";
import { printOutput, resolveFormat } from "../output.js";
import { outputArgs, serverArgs } from "../shared.js";

const ingest = defineCommand({
  meta: { name: "ingest", description: "Ingest a project codebase" },
  args: {
    projectDir: { type: "positional", description: "Project directory", required: true },
    forceReingest: { type: "boolean", description: "Force full re-ingestion", default: false },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const body: Record<string, unknown> = { projectDir: args.projectDir };
    if (args.forceReingest) body.forceReingest = true;
    const result = await client.post("/api/v1/codebase/ingest", body);
    printOutput(result, resolveFormat(args));
  },
});

const verify = defineCommand({
  meta: { name: "verify", description: "Verify project manifest integrity" },
  args: {
    projectDir: { type: "positional", description: "Project directory", required: true },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const result = await client.post("/api/v1/codebase/verify", { projectDir: args.projectDir });
    printOutput(result, resolveFormat(args));
  },
});

const search = defineCommand({
  meta: { name: "search", description: "Semantic code search" },
  args: {
    query: { type: "positional", description: "Search query", required: true },
    projectId: { type: "string", description: "Project ID" },
    type: { type: "string", description: "Type filter (code, comment, docstring)" },
    limit: { type: "string", description: "Max results" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = { query: args.query };
    if (args.projectId) params.projectId = args.projectId;
    if (args.type) params.type = args.type;
    if (args.limit) params.limit = args.limit;
    const result = await client.get("/api/v1/codebase/search", params);
    printOutput(result, resolveFormat(args));
  },
});

const timeline = defineCommand({
  meta: { name: "timeline", description: "Query temporal commit history" },
  args: {
    projectId: { type: "string", description: "Project ID" },
    filePath: { type: "string", description: "File path filter" },
    limit: { type: "string", description: "Max results" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = {};
    if (args.projectId) params.projectId = args.projectId;
    if (args.filePath) params.filePath = args.filePath;
    if (args.limit) params.limit = args.limit;
    const result = await client.get("/api/v1/codebase/timeline", params);
    printOutput(result, resolveFormat(args));
  },
});

const projects = defineCommand({
  meta: { name: "projects", description: "List ingested projects" },
  args: {
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const result = await client.get("/api/v1/codebase/projects");
    printOutput(result, resolveFormat(args));
  },
});

const del = defineCommand({
  meta: { name: "delete", description: "Delete an ingested project" },
  args: {
    projectId: { type: "positional", description: "Project ID", required: true },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const result = await client.delete(`/api/v1/codebase/projects/${encodeURIComponent(args.projectId)}`);
    printOutput(result, resolveFormat(args));
  },
});

export default defineCommand({
  meta: { name: "codebase", description: "Code ingestion and search" },
  subCommands: { ingest, verify, search, timeline, projects, delete: del },
});
