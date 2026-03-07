#!/usr/bin/env node
/**
 * CLI entry point for ping-mem MCP server
 *
 * @module mcp/cli
 */

import { main } from "./PingMemServer.js";
import { validateEnv } from "../config/env-validation.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("MCP CLI");

validateEnv();

main().catch((error) => {
  log.error("Fatal error", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
