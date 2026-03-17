/**
 * Agent commands: register, quotas, deregister
 */

import { defineCommand } from "citty";
import { createClient } from "../client.js";
import { printOutput, resolveFormat } from "../output.js";
import { outputArgs, serverArgs } from "../shared.js";

const register = defineCommand({
  meta: { name: "register", description: "Register or update an agent" },
  args: {
    agentId: { type: "positional", description: "Agent ID", required: true },
    role: { type: "string", description: "Agent role", required: true },
    admin: { type: "boolean", description: "Admin privileges", default: false },
    ttlMs: { type: "string", description: "TTL in milliseconds" },
    quotaBytes: { type: "string", description: "Storage quota in bytes" },
    quotaCount: { type: "string", description: "Memory count quota" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const body: Record<string, unknown> = {
      agentId: args.agentId,
      role: args.role,
    };
    if (args.admin) body.admin = true;
    if (args.ttlMs) body.ttlMs = parseInt(args.ttlMs, 10);
    if (args.quotaBytes) body.quotaBytes = parseInt(args.quotaBytes, 10);
    if (args.quotaCount) body.quotaCount = parseInt(args.quotaCount, 10);
    const result = await client.post("/api/v1/agents/register", body);
    printOutput(result, resolveFormat(args));
  },
});

const quotas = defineCommand({
  meta: { name: "quotas", description: "Get agent quota status" },
  args: {
    agentId: { type: "string", description: "Filter by agent ID" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = {};
    if (args.agentId) params.agentId = args.agentId;
    const result = await client.get("/api/v1/agents/quotas", params);
    printOutput(result, resolveFormat(args));
  },
});

const deregister = defineCommand({
  meta: { name: "deregister", description: "Deregister an agent" },
  args: {
    agentId: { type: "positional", description: "Agent ID", required: true },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const result = await client.delete(`/api/v1/agents/${encodeURIComponent(args.agentId)}`);
    printOutput(result, resolveFormat(args));
  },
});

export default defineCommand({
  meta: { name: "agent", description: "Agent registration and quota management" },
  subCommands: { register, quotas, deregister },
});
