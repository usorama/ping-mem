#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

interface Args {
  output?: string | undefined;
  config?: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--output") {
      args.output = argv[i + 1];
      i += 1;
    } else if (token === "--config") {
      args.config = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function getSarifLevel(severity: number): "error" | "warning" | "note" | "info" {
  // ESLint severity: 0 = off, 1 = warn, 2 = error
  switch (severity) {
    case 2:
      return "error";
    case 1:
      return "warning";
    case 0:
    default:
      return "info";
  }
}

/** Typed SARIF physical location for safe property access in sort comparisons */
interface SarifPhysicalLocation {
  artifactLocation?: { uri?: string };
  region?: { startLine?: number; startColumn?: number; endLine?: number; endColumn?: number };
}

interface SarifLocation {
  physicalLocation?: SarifPhysicalLocation;
}

interface SarifResultEntry {
  ruleId?: string;
  level?: string;
  message?: { text: string };
  locations?: SarifLocation[];
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getEslintVersion(): string {
  try {
    const output = execSync("npx eslint --version", {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    // Output format: "v8.56.0" or "8.56.0"
    return output.replace(/^v/, "");
  } catch {
    return "unknown";
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const outputPath = args.output ?? "diagnostics/eslint.sarif";
  const configPath = args.config;

  // Build ESLint command
  const eslintCmd = [
    "npx",
    "eslint",
    ".",
    "--format",
    "json",
  ];
  
  if (configPath) {
    eslintCmd.push("--config", configPath);
  }

  // Run ESLint with JSON formatter
  let eslintOutput: string;
  try {
    eslintOutput = execSync(eslintCmd.join(" "), {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    }).toString();
  } catch (error: unknown) {
    // ESLint exits with non-zero when it finds issues
    // But still outputs JSON to stdout
    const execError = error as { stdout?: Buffer | string };
    eslintOutput = execError.stdout?.toString() ?? "[]";
  }

  const eslintResults = JSON.parse(eslintOutput) as Array<{
    filePath: string;
    messages: Array<{
      ruleId: string | null;
      severity: number;
      message: string;
      line?: number;
      column?: number;
      endLine?: number;
      endColumn?: number;
    }>;
  }>;

  // Convert ESLint JSON to SARIF 2.1.0
  const results: SarifResultEntry[] = [];

  for (const file of eslintResults) {
    for (const msg of file.messages) {
      const ruleId = msg.ruleId ?? "unknown";
      const level = getSarifLevel(msg.severity);

      const result: SarifResultEntry = {
        ruleId,
        level,
        message: { text: msg.message },
      };

      if (msg.line !== undefined) {
        const region: Record<string, number> = {
          startLine: msg.line,
        };

        if (msg.column !== undefined) {
          region.startColumn = msg.column;
        }
        if (msg.endLine !== undefined) {
          region.endLine = msg.endLine;
        } else {
          region.endLine = msg.line;
        }
        if (msg.endColumn !== undefined) {
          region.endColumn = msg.endColumn;
        } else if (msg.column !== undefined) {
          region.endColumn = msg.column + 1;
        }

        result.locations = [
          {
            physicalLocation: {
              artifactLocation: {
                uri: normalizePath(path.relative(process.cwd(), file.filePath)),
              },
              region,
            },
          },
        ];
      }

      results.push(result);
    }
  }

  // Sort results deterministically (file > line > column > rule)
  results.sort((a, b) => {
    const locA = a.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? "";
    const locB = b.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? "";
    if (locA !== locB) return locA.localeCompare(locB);

    const lineA = a.locations?.[0]?.physicalLocation?.region?.startLine ?? 0;
    const lineB = b.locations?.[0]?.physicalLocation?.region?.startLine ?? 0;
    if (lineA !== lineB) return lineA - lineB;

    const colA = a.locations?.[0]?.physicalLocation?.region?.startColumn ?? 0;
    const colB = b.locations?.[0]?.physicalLocation?.region?.startColumn ?? 0;
    if (colA !== colB) return colA - colB;

    const ruleA = a.ruleId ?? "";
    const ruleB = b.ruleId ?? "";
    return ruleA.localeCompare(ruleB);
  });

  const sarif = {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "eslint",
            version: getEslintVersion(),
          },
        },
        results,
      },
    ],
  };

  ensureDir(outputPath);
  fs.writeFileSync(outputPath, JSON.stringify(sarif, null, 2));
  console.log(`SARIF written to ${outputPath}`);
}

main();
