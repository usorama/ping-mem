/**
 * Causal commands: causes, effects, chain, discover
 */

import { defineCommand } from "citty";
import { createClient } from "../client.js";
import { printOutput, resolveFormat } from "../output.js";
import { outputArgs, serverArgs } from "../shared.js";

const causes = defineCommand({
  meta: { name: "causes", description: "Search causes for an entity" },
  args: {
    entityId: { type: "positional", description: "Entity ID", required: true },
    maxDepth: { type: "string", description: "Max depth" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = { entityId: args.entityId };
    if (args.maxDepth) params.maxDepth = args.maxDepth;
    const result = await client.get("/api/v1/causal/causes", params);
    printOutput(result, resolveFormat(args));
  },
});

const effects = defineCommand({
  meta: { name: "effects", description: "Search effects of an entity" },
  args: {
    entityId: { type: "positional", description: "Entity ID", required: true },
    maxDepth: { type: "string", description: "Max depth" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = { entityId: args.entityId };
    if (args.maxDepth) params.maxDepth = args.maxDepth;
    const result = await client.get("/api/v1/causal/effects", params);
    printOutput(result, resolveFormat(args));
  },
});

const chain = defineCommand({
  meta: { name: "chain", description: "Get causal chain between entities" },
  args: {
    fromId: { type: "string", description: "Source entity ID", required: true },
    toId: { type: "string", description: "Target entity ID", required: true },
    maxDepth: { type: "string", description: "Max depth" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = {};
    if (args.fromId) params.fromId = args.fromId;
    if (args.toId) params.toId = args.toId;
    if (args.maxDepth) params.maxDepth = args.maxDepth;
    const result = await client.get("/api/v1/causal/chain", params);
    printOutput(result, resolveFormat(args));
  },
});

const discover = defineCommand({
  meta: { name: "discover", description: "Trigger causal discovery" },
  args: {
    sessionId: { type: "string", description: "Session ID" },
    minConfidence: { type: "string", description: "Min confidence threshold (0-1)" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const body: Record<string, unknown> = {};
    if (args.sessionId) body.sessionId = args.sessionId;
    if (args.minConfidence) body.minConfidence = parseFloat(args.minConfidence);
    const result = await client.post("/api/v1/causal/discover", body);
    printOutput(result, resolveFormat(args));
  },
});

export default defineCommand({
  meta: { name: "causal", description: "Causal inference operations" },
  subCommands: { causes, effects, chain, discover },
});
