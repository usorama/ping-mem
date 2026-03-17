/**
 * Tools commands: list, get, invoke
 */

import { defineCommand } from "citty";
import { createClient } from "../client.js";
import { printOutput, resolveFormat } from "../output.js";
import { outputArgs, serverArgs } from "../shared.js";

const list = defineCommand({
  meta: { name: "list", description: "List all available tools" },
  args: {
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const result = await client.get("/api/v1/tools");
    printOutput(result, resolveFormat(args));
  },
});

const get = defineCommand({
  meta: { name: "get", description: "Get tool schema by name" },
  args: {
    name: { type: "positional", description: "Tool name", required: true },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const result = await client.get(`/api/v1/tools/${encodeURIComponent(args.name)}`);
    printOutput(result, resolveFormat(args));
  },
});

const invoke = defineCommand({
  meta: { name: "invoke", description: "Invoke a tool by name" },
  args: {
    name: { type: "positional", description: "Tool name", required: true },
    arguments: { type: "string", description: "JSON arguments string", required: true },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    let toolArgs: Record<string, unknown>;
    try {
      toolArgs = JSON.parse(args.arguments) as Record<string, unknown>;
    } catch {
      throw new Error("Invalid JSON for --arguments. Provide a valid JSON string.");
    }
    const result = await client.post(`/api/v1/tools/${encodeURIComponent(args.name)}/invoke`, {
      arguments: toolArgs,
    });
    printOutput(result, resolveFormat(args));
  },
});

export default defineCommand({
  meta: { name: "tools", description: "Tool discovery and invocation" },
  subCommands: { list, get, invoke },
});
