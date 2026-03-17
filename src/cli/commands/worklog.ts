/**
 * Worklog commands: record, list
 */

import { defineCommand } from "citty";
import { createClient } from "../client.js";
import { printOutput, resolveFormat } from "../output.js";
import { outputArgs, serverArgs } from "../shared.js";

const record = defineCommand({
  meta: { name: "record", description: "Record a worklog event" },
  args: {
    kind: { type: "positional", description: "Event kind (diagnostics, git, task, tool)", required: true },
    title: { type: "positional", description: "Event title", required: true },
    status: { type: "string", description: "Status (success, failed, skipped)", required: true },
    sessionId: { type: "string", description: "Session ID" },
    toolName: { type: "string", description: "Tool name" },
    durationMs: { type: "string", description: "Duration in ms" },
    summary: { type: "string", description: "Event summary" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const body: Record<string, unknown> = {
      kind: args.kind,
      title: args.title,
      status: args.status,
    };
    if (args.sessionId) body.sessionId = args.sessionId;
    if (args.toolName) body.toolName = args.toolName;
    if (args.durationMs) body.durationMs = parseInt(args.durationMs, 10);
    if (args.summary) body.summary = args.summary;
    const result = await client.post("/api/v1/worklog", body);
    printOutput(result, resolveFormat(args));
  },
});

const list = defineCommand({
  meta: { name: "list", description: "List worklog events" },
  args: {
    sessionId: { type: "string", description: "Filter by session ID" },
    kind: { type: "string", description: "Filter by kind" },
    limit: { type: "string", description: "Max results" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = {};
    if (args.sessionId) params.sessionId = args.sessionId;
    if (args.kind) params.kind = args.kind;
    if (args.limit) params.limit = args.limit;
    const result = await client.get("/api/v1/worklog", params);
    printOutput(result, resolveFormat(args));
  },
});

export default defineCommand({
  meta: { name: "worklog", description: "Worklog event tracking" },
  subCommands: { record, list },
});
