/**
 * Session commands: start, end, list
 */

import { defineCommand } from "citty";
import { createClient } from "../client.js";
import { printOutput, resolveFormat } from "../output.js";
import { outputArgs, serverArgs } from "../shared.js";

const start = defineCommand({
  meta: { name: "start", description: "Start a new session" },
  args: {
    name: { type: "positional", description: "Session name", required: true },
    projectDir: { type: "string", description: "Project directory" },
    autoIngest: { type: "boolean", description: "Auto-ingest on start", default: false },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const body: Record<string, unknown> = { name: args.name };
    if (args.projectDir) body.projectDir = args.projectDir;
    if (args.autoIngest) body.autoIngest = true;
    const result = await client.post("/api/v1/session/start", body);
    printOutput(result, resolveFormat(args));
  },
});

const end = defineCommand({
  meta: { name: "end", description: "End a session" },
  args: {
    sessionId: { type: "positional", description: "Session ID", required: true },
    agentId: { type: "string", description: "Agent ID" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const body: Record<string, unknown> = { sessionId: args.sessionId };
    if (args.agentId) body.agentId = args.agentId;
    const result = await client.post("/api/v1/session/end", body);
    printOutput(result, resolveFormat(args));
  },
});

const list = defineCommand({
  meta: { name: "list", description: "List recent sessions" },
  args: {
    limit: { type: "string", description: "Max results (default: 10)" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = {};
    if (args.limit) params.limit = args.limit;
    const result = await client.get("/api/v1/session/list", params);
    printOutput(result, resolveFormat(args));
  },
});

export default defineCommand({
  meta: { name: "session", description: "Session management" },
  subCommands: { start, end, list },
});
