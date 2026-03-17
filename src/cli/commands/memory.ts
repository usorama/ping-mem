/**
 * Memory commands: stats, consolidate, subscribe, unsubscribe, compress
 */

import { defineCommand } from "citty";
import { createClient } from "../client.js";
import { printOutput, resolveFormat } from "../output.js";
import { outputArgs, serverArgs } from "../shared.js";

const stats = defineCommand({
  meta: { name: "stats", description: "Get memory statistics" },
  args: {
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const result = await client.get("/api/v1/memory/stats");
    printOutput(result, resolveFormat(args));
  },
});

const consolidate = defineCommand({
  meta: { name: "consolidate", description: "Consolidate duplicate memories" },
  args: {
    sessionId: { type: "string", description: "Session ID" },
    dryRun: { type: "boolean", description: "Preview without changes", default: false },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const body: Record<string, unknown> = {};
    if (args.sessionId) body.sessionId = args.sessionId;
    if (args.dryRun) body.dryRun = true;
    const result = await client.post("/api/v1/memory/consolidate", body);
    printOutput(result, resolveFormat(args));
  },
});

const subscribe = defineCommand({
  meta: { name: "subscribe", description: "Subscribe to memory change events" },
  args: {
    pattern: { type: "string", description: "Event pattern to subscribe to" },
    sessionId: { type: "string", description: "Session ID" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const body: Record<string, unknown> = {};
    if (args.pattern) body.pattern = args.pattern;
    if (args.sessionId) body.sessionId = args.sessionId;
    const result = await client.post("/api/v1/memory/subscribe", body);
    printOutput(result, resolveFormat(args));
  },
});

const unsubscribe = defineCommand({
  meta: { name: "unsubscribe", description: "Unsubscribe from memory events" },
  args: {
    subscriptionId: { type: "positional", description: "Subscription ID", required: true },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const result = await client.post("/api/v1/memory/unsubscribe", {
      subscriptionId: args.subscriptionId,
    });
    printOutput(result, resolveFormat(args));
  },
});

const compress = defineCommand({
  meta: { name: "compress", description: "Compress memories into digest facts" },
  args: {
    sessionId: { type: "string", description: "Session ID" },
    strategy: { type: "string", description: "Strategy: heuristic or llm" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const body: Record<string, unknown> = {};
    if (args.sessionId) body.sessionId = args.sessionId;
    if (args.strategy) body.strategy = args.strategy;
    const result = await client.post("/api/v1/memory/compress", body);
    printOutput(result, resolveFormat(args));
  },
});

export default defineCommand({
  meta: { name: "memory", description: "Memory management" },
  subCommands: { stats, consolidate, subscribe, unsubscribe, compress },
});
