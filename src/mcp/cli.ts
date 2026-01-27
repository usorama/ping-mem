#!/usr/bin/env node
/**
 * CLI entry point for ping-mem MCP server
 *
 * @module mcp/cli
 */

import { main } from "./PingMemServer.js";

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
