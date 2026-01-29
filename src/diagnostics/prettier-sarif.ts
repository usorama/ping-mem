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

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getPrettierVersion(): string {
  try {
    const output = execSync("npx prettier --version", {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    return output;
  } catch {
    return "unknown";
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const outputPath = args.output ?? "diagnostics/prettier.sarif";
  const configPath = args.config;

  // Build Prettier check command
  const prettierCmd = [
    "npx",
    "prettier",
    ".",
    "--check",
    "--list-different",
  ];
  
  if (configPath) {
    prettierCmd.push("--config", configPath);
  }

  // Run Prettier check
  let prettierOutput: string;
  let hasIssues = false;
  
  try {
    execSync(prettierCmd.join(" "), {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });
    prettierOutput = "";
  } catch (error: any) {
    // Prettier exits with non-zero when files need formatting
    // It outputs the list of files to stderr
    prettierOutput = error.stderr?.toString() ?? error.stdout?.toString() ?? "";
    hasIssues = true;
  }

  const results: Array<Record<string, unknown>> = [];

  if (hasIssues && prettierOutput) {
    // Parse the file list from Prettier output
    const files = prettierOutput
      .split("\n")
      .map(line => line.trim())
      .filter(line => {
        // Filter out non-file lines (headers, empty lines, etc.)
        return line.length > 0 && 
               !line.startsWith("[") && 
               !line.startsWith("Checking") &&
               !line.includes("Code style issues");
      });

    for (const filePath of files) {
      const result: Record<string, unknown> = {
        ruleId: "prettier/prettier",
        level: "warning",
        message: { text: "File is not formatted according to Prettier rules" },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: normalizePath(filePath),
              },
              region: {
                startLine: 1,
                startColumn: 1,
                endLine: 1,
                endColumn: 1,
              },
            },
          },
        ],
      };

      results.push(result);
    }
  }

  // Sort results deterministically (file path)
  results.sort((a, b) => {
    const locA = ((a.locations as any)?.[0]?.physicalLocation?.artifactLocation?.uri ?? "") as string;
    const locB = ((b.locations as any)?.[0]?.physicalLocation?.artifactLocation?.uri ?? "") as string;
    return locA.localeCompare(locB);
  });

  const sarif = {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "prettier",
            version: getPrettierVersion(),
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
