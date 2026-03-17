/**
 * Output formatting for CLI commands.
 *
 * Supports: json, table (human-readable), quiet (minimal)
 */

export type OutputFormat = "json" | "table" | "quiet";

/**
 * Format data for terminal output.
 */
export function formatOutput(data: unknown, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(data, null, 2);
  }
  if (format === "quiet") {
    return formatQuiet(data);
  }
  return formatTable(data);
}

function formatQuiet(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  if (Array.isArray(data)) return String(data.length);
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    // For common response shapes, extract the key value
    if ("sessionId" in obj) return String(obj.sessionId);
    if ("id" in obj) return String(obj.id);
    if ("count" in obj) return String(obj.count);
    if ("data" in obj) return formatQuiet(obj.data);
    return "";
  }
  return String(data);
}

function formatTable(data: unknown): string {
  if (data === null || data === undefined) return "(empty)";
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);

  // Unwrap { data: ... } envelope
  if (typeof data === "object" && !Array.isArray(data) && data !== null) {
    const obj = data as Record<string, unknown>;
    if ("data" in obj && typeof obj.data === "object" && obj.data !== null) {
      return formatTable(obj.data);
    }
  }

  // Array of objects -> table
  if (Array.isArray(data)) {
    if (data.length === 0) return "(no results)";
    const first = data[0];
    if (typeof first === "object" && first !== null) {
      return formatObjectArray(data as Record<string, unknown>[]);
    }
    return data.map(String).join("\n");
  }

  // Single object -> key-value pairs
  if (typeof data === "object") {
    return formatKeyValue(data as Record<string, unknown>);
  }

  return String(data);
}

function formatKeyValue(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  const maxKeyLen = Math.max(...Object.keys(obj).map((k) => k.length));
  for (const [key, value] of Object.entries(obj)) {
    const displayVal = typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
    lines.push(`${key.padEnd(maxKeyLen)}  ${displayVal}`);
  }
  return lines.join("\n");
}

function formatObjectArray(items: Record<string, unknown>[]): string {
  if (items.length === 0) return "(no results)";
  const firstItem = items[0];
  if (!firstItem) return "(no results)";
  const keys = Object.keys(firstItem);
  // Limit columns for readability
  const displayKeys = keys.slice(0, 6);
  const colWidths = displayKeys.map((k) => {
    const maxVal = Math.max(
      k.length,
      ...items.map((item) => {
        const v = item[k];
        const s = typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
        return Math.min(s.length, 40);
      })
    );
    return maxVal;
  });

  const header = displayKeys.map((k, i) => k.padEnd(colWidths[i] ?? k.length)).join("  ");
  const separator = colWidths.map((w) => "-".repeat(w)).join("  ");
  const rows = items.map((item) =>
    displayKeys
      .map((k, i) => {
        const v = item[k];
        const s = typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
        const truncated = s.length > 40 ? s.slice(0, 37) + "..." : s;
        return truncated.padEnd(colWidths[i] ?? k.length);
      })
      .join("  ")
  );

  return [header, separator, ...rows].join("\n");
}

/**
 * Print output and handle quiet mode (no output).
 */
export function printOutput(data: unknown, format: OutputFormat): void {
  const output = formatOutput(data, format);
  if (output) {
    console.log(output);
  }
}

/**
 * Resolve output format from command args.
 */
export function resolveFormat(args: { json?: boolean; quiet?: boolean }): OutputFormat {
  if (args.json) return "json";
  if (args.quiet) return "quiet";
  return "table";
}
