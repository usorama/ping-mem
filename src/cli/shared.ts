/**
 * Shared CLI argument definitions for --json and --quiet flags.
 */

import type { ArgsDef } from "citty";

export const outputArgs = {
  json: {
    type: "boolean" as const,
    description: "Output as JSON",
    default: false,
  },
  quiet: {
    type: "boolean" as const,
    description: "Suppress output (exit code only)",
    default: false,
  },
} satisfies ArgsDef;

export const serverArgs = {
  server: {
    type: "string" as const,
    description: "Server URL (overrides config)",
  },
} satisfies ArgsDef;
