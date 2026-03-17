/**
 * Graph commands: relationships, hybrid-search, lineage, evolution, health
 */

import { defineCommand } from "citty";
import { createClient } from "../client.js";
import { printOutput, resolveFormat } from "../output.js";
import { outputArgs, serverArgs } from "../shared.js";

const relationships = defineCommand({
  meta: { name: "relationships", description: "Query entity relationships" },
  args: {
    entityId: { type: "positional", description: "Entity ID", required: true },
    depth: { type: "string", description: "Traversal depth (default: 1)" },
    direction: { type: "string", description: "Direction: incoming, outgoing, both" },
    types: { type: "string", description: "Comma-separated relationship types" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = { entityId: args.entityId };
    if (args.depth) params.depth = args.depth;
    if (args.direction) params.direction = args.direction;
    if (args.types) params.relationshipTypes = args.types;
    const result = await client.get("/api/v1/graph/relationships", params);
    printOutput(result, resolveFormat(args));
  },
});

const hybridSearch = defineCommand({
  meta: { name: "hybrid-search", description: "Combined semantic + graph search" },
  args: {
    query: { type: "positional", description: "Search query", required: true },
    limit: { type: "string", description: "Max results" },
    sessionId: { type: "string", description: "Session ID" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const body: Record<string, unknown> = { query: args.query };
    if (args.limit) body.limit = parseInt(args.limit, 10);
    if (args.sessionId) body.sessionId = args.sessionId;
    const result = await client.post("/api/v1/graph/hybrid-search", body);
    printOutput(result, resolveFormat(args));
  },
});

const lineage = defineCommand({
  meta: { name: "lineage", description: "Trace entity lineage" },
  args: {
    entity: { type: "positional", description: "Entity ID", required: true },
    direction: { type: "string", description: "Direction: upstream, downstream, both" },
    maxDepth: { type: "string", description: "Max traversal depth" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = {};
    if (args.direction) params.direction = args.direction;
    if (args.maxDepth) params.maxDepth = args.maxDepth;
    const result = await client.get(`/api/v1/graph/lineage/${encodeURIComponent(args.entity)}`, params);
    printOutput(result, resolveFormat(args));
  },
});

const evolution = defineCommand({
  meta: { name: "evolution", description: "Track entity changes over time" },
  args: {
    entityId: { type: "positional", description: "Entity ID", required: true },
    startTime: { type: "string", description: "Start time (ISO)" },
    endTime: { type: "string", description: "End time (ISO)" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const params: Record<string, string> = { entityId: args.entityId };
    if (args.startTime) params.startTime = args.startTime;
    if (args.endTime) params.endTime = args.endTime;
    const result = await client.get("/api/v1/graph/evolution", params);
    printOutput(result, resolveFormat(args));
  },
});

const health = defineCommand({
  meta: { name: "health", description: "System health status" },
  args: {
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    const result = await client.get("/api/v1/graph/health");
    printOutput(result, resolveFormat(args));
  },
});

export default defineCommand({
  meta: { name: "graph", description: "Knowledge graph operations" },
  subCommands: { relationships, "hybrid-search": hybridSearch, lineage, evolution, health },
});
