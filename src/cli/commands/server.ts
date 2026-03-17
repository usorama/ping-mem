/**
 * Server commands: status, start
 */

import { defineCommand } from "citty";
import { createClient } from "../client.js";
import { printOutput, resolveFormat } from "../output.js";
import { outputArgs, serverArgs } from "../shared.js";

const status = defineCommand({
  meta: { name: "status", description: "Check server health" },
  args: {
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const client = createClient({ serverUrl: args.server });
    try {
      const result = await client.get("/health");
      printOutput(result, resolveFormat(args));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Server unreachable: ${msg}`);
      process.exit(1);
    }
  },
});

export default defineCommand({
  meta: { name: "server", description: "Server management" },
  subCommands: {
    status,
  },
});
