/**
 * Knowledge commands: search, ingest
 */

import { defineCommand } from "citty";
import { createClient } from "../client.js";
import { printOutput, resolveFormat } from "../output.js";
import { outputArgs, serverArgs } from "../shared.js";

const search = defineCommand({
  meta: { name: "search", description: "Search knowledge entries" },
  args: {
    query: { type: "positional", description: "Search query", required: true },
    projectId: { type: "string", description: "Filter by project ID" },
    crossProject: { type: "boolean", description: "Search across all projects", default: false },
    tags: { type: "string", description: "Comma-separated tags" },
    limit: { type: "string", description: "Max results" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const body: Record<string, unknown> = { query: args.query };
    if (args.projectId) body.projectId = args.projectId;
    if (args.crossProject) body.crossProject = true;
    if (args.tags) body.tags = args.tags.split(",").map((t) => t.trim());
    if (args.limit) body.limit = parseInt(args.limit, 10);
    const result = await client.post("/api/v1/knowledge/search", body);
    printOutput(result, resolveFormat(args));
  },
});

const ingest = defineCommand({
  meta: { name: "ingest", description: "Ingest a knowledge entry" },
  args: {
    title: { type: "string", description: "Entry title", required: true },
    solution: { type: "string", description: "Solution content", required: true },
    projectId: { type: "string", description: "Project ID", required: true },
    symptoms: { type: "string", description: "Symptoms" },
    rootCause: { type: "string", description: "Root cause" },
    tags: { type: "string", description: "Comma-separated tags" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const body: Record<string, unknown> = {
      title: args.title,
      solution: args.solution,
      projectId: args.projectId,
    };
    if (args.symptoms) body.symptoms = args.symptoms;
    if (args.rootCause) body.rootCause = args.rootCause;
    if (args.tags) body.tags = args.tags.split(",").map((t) => t.trim());
    const result = await client.post("/api/v1/knowledge/ingest", body);
    printOutput(result, resolveFormat(args));
  },
});

export default defineCommand({
  meta: { name: "knowledge", description: "Knowledge base operations" },
  subCommands: { search, ingest },
});
