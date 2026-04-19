#!/usr/bin/env node
/**
 * ping-mem CLI — thin REST client for all ping-mem operations.
 *
 * Usage: ping-mem <command> [subcommand] [options]
 */

import { defineCommand, runMain } from "citty";
import * as fs from "node:fs";
import * as path from "node:path";

import sessionCmd from "./commands/session.js";
import contextCmd from "./commands/context.js";
import graphCmd from "./commands/graph.js";
import worklogCmd from "./commands/worklog.js";
import diagnosticsCmd from "./commands/diagnostics.js";
import codebaseCmd from "./commands/codebase.js";
import memoryCmd from "./commands/memory.js";
import causalCmd from "./commands/causal.js";
import knowledgeCmd from "./commands/knowledge.js";
import agentCmd from "./commands/agent.js";
import toolsCmd from "./commands/tools.js";
import serverCmd from "./commands/server.js";
import authCmd from "./commands/auth.js";
import configCmd from "./commands/config.js";
import shellHookCmd from "./commands/shell-hook.js";
import daemonCmd from "./commands/daemon.js";
import doctorCmd from "./commands/doctor.js";

function readVersion(): string {
  try {
    const pkgPath = path.resolve(import.meta.dirname ?? __dirname, "../../package.json");
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const main = defineCommand({
  meta: {
    name: "ping-mem",
    version: readVersion(),
    description: "Universal Memory Layer for AI agents — CLI",
  },
  subCommands: {
    session: sessionCmd,
    context: contextCmd,
    graph: graphCmd,
    worklog: worklogCmd,
    diagnostics: diagnosticsCmd,
    codebase: codebaseCmd,
    memory: memoryCmd,
    causal: causalCmd,
    knowledge: knowledgeCmd,
    agent: agentCmd,
    tools: toolsCmd,
    server: serverCmd,
    auth: authCmd,
    config: configCmd,
    "shell-hook": shellHookCmd,
    daemon: daemonCmd,
    doctor: doctorCmd,
  },
});

runMain(main);
