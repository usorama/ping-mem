/**
 * Agent commands: trust-spine status/proof plus register, quotas, deregister.
 */

import { defineCommand } from "citty";
import {
  buildAgentCodebaseProjects,
  buildAgentCodebaseVerify,
  buildAgentGraphAnswer,
  buildAgentSessionStart,
  buildAgentStatus,
  buildCodebaseGroundingProof,
  buildMemoryLifecycleProof,
  normalizeFailureSimulation,
} from "../agent-trust.js";
import { createClient } from "../client.js";
import { printOutput, resolveFormat } from "../output.js";
import { outputArgs, serverArgs } from "../shared.js";

const status = defineCommand({
  meta: { name: "status", description: "Read-only agent trust-spine status" },
  args: {
    "read-only": { type: "boolean", description: "Assert that the status command must not repair or mutate runtime state", default: false },
    "timeout-ms": { type: "string", description: "Runtime timeout in milliseconds", default: "30000" },
    "evidence-dir": { type: "string", description: "Evidence output directory" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const result = await buildAgentStatus({
      serverUrl: args.server,
      timeoutMs: parseInt(args["timeout-ms"], 10),
      evidenceDir: args["evidence-dir"],
    });
    printOutput(result, resolveFormat(args));
    if (!result.ok) process.exitCode = 2;
  },
});

const memoryLifecycle = defineCommand({
  meta: { name: "memory-lifecycle", description: "Dry-run memory lifecycle proof plan" },
  args: {
    agent: { type: "string", description: "Approved agent ID" },
    project: { type: "string", description: "Project directory" },
    "dry-run": { type: "boolean", description: "Plan only; do not mutate runtime", default: false },
    simulate: { type: "string", description: "Simulate a negative scenario (unauthorized, dependency-down, stale, missing-data, timeout)" },
    "timeout-ms": { type: "string", description: "Runtime timeout in milliseconds", default: "30000" },
    "evidence-dir": { type: "string", description: "Evidence output directory" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const result = await buildMemoryLifecycleProof({
      agentId: args.agent,
      projectDir: args.project,
      dryRun: Boolean(args["dry-run"]),
      simulate: normalizeFailureSimulation(args.simulate),
      serverUrl: args.server,
      timeoutMs: parseInt(args["timeout-ms"], 10),
      evidenceDir: args["evidence-dir"],
    });
    printOutput(result, resolveFormat(args));
    if (!result.ok) process.exitCode = 2;
  },
});

const codebaseGrounding = defineCommand({
  meta: { name: "codebase-grounding", description: "Operational codebase grounding proof bundle" },
  args: {
    agent: { type: "string", description: "Approved agent ID" },
    project: { type: "string", description: "Project directory" },
    simulate: { type: "string", description: "Simulate a negative scenario (unauthorized, dependency-down, stale, missing-data, timeout)" },
    "timeout-ms": { type: "string", description: "Runtime timeout in milliseconds", default: "300000" },
    "evidence-dir": { type: "string", description: "Evidence output directory" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const result = await buildCodebaseGroundingProof({
      agentId: args.agent,
      projectDir: args.project,
      simulate: normalizeFailureSimulation(args.simulate),
      serverUrl: args.server,
      timeoutMs: parseInt(args["timeout-ms"], 10),
      evidenceDir: args["evidence-dir"],
    });
    printOutput(result, resolveFormat(args));
    if (!result.ok) process.exitCode = 2;
  },
});

const proof = defineCommand({
  meta: { name: "proof", description: "Agent trust proof commands" },
  subCommands: { "memory-lifecycle": memoryLifecycle, "codebase-grounding": codebaseGrounding },
});

const sessionStart = defineCommand({
  meta: { name: "start", description: "Start an approved agent session" },
  args: {
    agent: { type: "string", description: "Approved agent ID" },
    project: { type: "string", description: "Project directory" },
    "timeout-ms": { type: "string", description: "Runtime timeout in milliseconds", default: "5000" },
    "evidence-dir": { type: "string", description: "Evidence output directory" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const result = await buildAgentSessionStart({
      agentId: args.agent,
      projectDir: args.project,
      serverUrl: args.server,
      timeoutMs: parseInt(args["timeout-ms"], 10),
      evidenceDir: args["evidence-dir"],
    });
    printOutput(result, resolveFormat(args));
    if (!result.ok) process.exitCode = 2;
  },
});

const session = defineCommand({
  meta: { name: "session", description: "Approved agent session commands" },
  subCommands: { start: sessionStart },
});

const codebaseVerify = defineCommand({
  meta: { name: "verify", description: "Verify a project through the approved agent path" },
  args: {
    agent: { type: "string", description: "Approved agent ID" },
    project: { type: "string", description: "Project directory" },
    "timeout-ms": { type: "string", description: "Runtime timeout in milliseconds", default: "5000" },
    "evidence-dir": { type: "string", description: "Evidence output directory" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const result = await buildAgentCodebaseVerify({
      agentId: args.agent,
      projectDir: args.project,
      serverUrl: args.server,
      timeoutMs: parseInt(args["timeout-ms"], 10),
      evidenceDir: args["evidence-dir"],
    });
    printOutput(result, resolveFormat(args));
    if (!result.ok) process.exitCode = 2;
  },
});

const codebaseProjects = defineCommand({
  meta: { name: "projects", description: "List projects through the approved runtime registry path" },
  args: {
    scope: { type: "string", description: "Project inventory scope (registered or all)", default: "registered" },
    limit: { type: "string", description: "Maximum projects to return", default: "1000" },
    "timeout-ms": { type: "string", description: "Runtime timeout in milliseconds", default: "5000" },
    "evidence-dir": { type: "string", description: "Evidence output directory" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const result = await buildAgentCodebaseProjects({
      scope: args.scope === "all" ? "all" : "registered",
      limit: parseInt(args.limit, 10),
      serverUrl: args.server,
      timeoutMs: parseInt(args["timeout-ms"], 10),
      evidenceDir: args["evidence-dir"],
    });
    printOutput(result, resolveFormat(args));
    if (!result.ok) process.exitCode = 2;
  },
});

const codebase = defineCommand({
  meta: { name: "codebase", description: "Approved agent codebase commands" },
  subCommands: { verify: codebaseVerify, projects: codebaseProjects },
});

const graphAnswer = defineCommand({
  meta: { name: "answer", description: "Answer a structured graph question through the approved agent path" },
  args: {
    agent: { type: "string", description: "Approved agent ID" },
    project: { type: "string", description: "Project directory" },
    mode: { type: "string", description: "Answer mode: complete_graph or semantic_neighborhood", default: "semantic_neighborhood" },
    query: { type: "string", description: "Graph question or search prompt" },
    "expected-corpus-hash": { type: "string", description: "Require a specific corpus hash" },
    "require-freshness": { type: "boolean", description: "Require current corpus freshness", default: true },
    limit: { type: "string", description: "Maximum semantic-neighborhood anchors", default: "3" },
    "timeout-ms": { type: "string", description: "Runtime timeout in milliseconds", default: "30000" },
    "evidence-dir": { type: "string", description: "Evidence output directory" },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const mode = args.mode === "complete_graph" ? "complete_graph" : "semantic_neighborhood";
    const result = await buildAgentGraphAnswer({
      agentId: args.agent,
      projectDir: args.project,
      mode,
      query: args.query,
      expectedCorpusHash: args["expected-corpus-hash"],
      requireFreshness: Boolean(args["require-freshness"]),
      limit: parseInt(args.limit, 10),
      serverUrl: args.server,
      timeoutMs: parseInt(args["timeout-ms"], 10),
      evidenceDir: args["evidence-dir"],
    });
    printOutput(result, resolveFormat(args));
    if (!result.ok) process.exitCode = 2;
  },
});

const graph = defineCommand({
  meta: { name: "graph", description: "Approved agent graph commands" },
  subCommands: { answer: graphAnswer },
});

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
  meta: { name: "agent", description: "Agent trust spine and registration" },
  subCommands: { status, proof, session, codebase, graph, register, quotas, deregister },
});
