#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import ts from "typescript";

interface Args {
  output?: string | undefined;
  project?: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--output") {
      args.output = argv[i + 1];
      i += 1;
    } else if (token === "--project") {
      args.project = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function getSarifLevel(category: ts.DiagnosticCategory): "error" | "warning" | "note" | "info" {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "note";
    case ts.DiagnosticCategory.Message:
    default:
      return "info";
  }
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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const outputPath = args.output ?? "diagnostics/tsc.sarif";
  const projectPath = args.project ?? "tsconfig.json";

  const configFile = ts.readConfigFile(projectPath, ts.sys.readFile);
  if (configFile.error) {
    const message = ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n");
    throw new Error(message);
  }

  const config = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(projectPath)
  );

  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: config.options,
  });

  const diagnostics = ts.getPreEmitDiagnostics(program);
  const results = diagnostics
    .map((diag) => {
      const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
      const ruleId = `TS${diag.code}`;
      const level = getSarifLevel(diag.category);
      const result: Record<string, unknown> = {
        ruleId,
        level,
        message: { text: message },
      };

      if (diag.file && typeof diag.start === "number") {
        const { line, character } = ts.getLineAndCharacterOfPosition(diag.file, diag.start);
        const end = diag.length ? diag.start + diag.length : diag.start;
        const { line: endLine, character: endChar } = ts.getLineAndCharacterOfPosition(
          diag.file,
          end
        );
        result.locations = [
          {
            physicalLocation: {
              artifactLocation: {
                uri: normalizePath(diag.file.fileName),
              },
              region: {
                startLine: line + 1,
                startColumn: character + 1,
                endLine: endLine + 1,
                endColumn: endChar + 1,
              },
            },
          },
        ];
      }

      return result;
    })
    .sort((a, b) => {
      const locA = ((a.locations as any)?.[0]?.physicalLocation?.artifactLocation?.uri ?? "") as string;
      const locB = ((b.locations as any)?.[0]?.physicalLocation?.artifactLocation?.uri ?? "") as string;
      if (locA !== locB) return locA.localeCompare(locB);
      const lineA = ((a.locations as any)?.[0]?.physicalLocation?.region?.startLine ?? 0) as number;
      const lineB = ((b.locations as any)?.[0]?.physicalLocation?.region?.startLine ?? 0) as number;
      if (lineA !== lineB) return lineA - lineB;
      const ruleA = (a.ruleId as string) ?? "";
      const ruleB = (b.ruleId as string) ?? "";
      return ruleA.localeCompare(ruleB);
    });

  const sarif = {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "tsc",
            version: ts.version,
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
