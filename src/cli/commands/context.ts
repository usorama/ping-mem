/**
 * Context commands: save, get, search, delete, checkpoint, status
 */

import { defineCommand } from "citty";
import { createClient } from "../client.js";
import { printOutput, resolveFormat } from "../output.js";
import { outputArgs, serverArgs } from "../shared.js";

const save = defineCommand({
  meta: { name: "save", description: "Save a context memory" },
  args: {
    key: { type: "positional", description: "Memory key", required: true },
    value: { type: "positional", description: "Memory content", required: true },
    category: { type: "string", description: "Category (task, decision, progress, note)" },
    priority: { type: "string", description: "Priority (high, normal, low)" },
    tags: { type: "string", description: "Comma-separated tags" },
    sessionId: { type: "string", description: "Session ID" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const body: Record<string, unknown> = {
      key: args.key,
      value: args.value,
    };
    if (args.category) body.category = args.category;
    if (args.priority) body.priority = args.priority;
    if (args.tags) body.tags = args.tags.split(",").map((t) => t.trim());
    if (args.sessionId) body.sessionId = args.sessionId;
    const result = await client.post("/api/v1/context", body);
    printOutput(result, resolveFormat(args));
  },
});

const get = defineCommand({
  meta: { name: "get", description: "Get a memory by key" },
  args: {
    key: { type: "positional", description: "Memory key", required: true },
    sessionId: { type: "string", description: "Session ID" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = {};
    if (args.sessionId) params.sessionId = args.sessionId;
    const result = await client.get(`/api/v1/context/${encodeURIComponent(args.key)}`, params);
    printOutput(result, resolveFormat(args));
  },
});

const search = defineCommand({
  meta: { name: "search", description: "Search memories" },
  args: {
    query: { type: "positional", description: "Search query", required: true },
    limit: { type: "string", description: "Max results" },
    category: { type: "string", description: "Filter by category" },
    sessionId: { type: "string", description: "Session ID" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = { query: args.query };
    if (args.limit) params.limit = args.limit;
    if (args.category) params.category = args.category;
    if (args.sessionId) params.sessionId = args.sessionId;
    const result = await client.get("/api/v1/search", params);
    printOutput(result, resolveFormat(args));
  },
});

const del = defineCommand({
  meta: { name: "delete", description: "Delete a memory" },
  args: {
    key: { type: "positional", description: "Memory key", required: true },
    sessionId: { type: "string", description: "Session ID" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = {};
    if (args.sessionId) params.sessionId = args.sessionId;
    const result = await client.delete(`/api/v1/context/${encodeURIComponent(args.key)}`);
    printOutput(result, resolveFormat(args));
  },
});

const checkpoint = defineCommand({
  meta: { name: "checkpoint", description: "Create a named checkpoint" },
  args: {
    name: { type: "positional", description: "Checkpoint name", required: true },
    sessionId: { type: "string", description: "Session ID" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const body: Record<string, unknown> = { name: args.name };
    if (args.sessionId) body.sessionId = args.sessionId;
    const result = await client.post("/api/v1/checkpoint", body);
    printOutput(result, resolveFormat(args));
  },
});

const status = defineCommand({
  meta: { name: "status", description: "Get session and server status" },
  args: {
    sessionId: { type: "string", description: "Session ID" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = {};
    if (args.sessionId) params.sessionId = args.sessionId;
    const result = await client.get("/api/v1/status", params);
    printOutput(result, resolveFormat(args));
  },
});

export default defineCommand({
  meta: { name: "context", description: "Context memory operations" },
  subCommands: { save, get, search, delete: del, checkpoint, status },
});
