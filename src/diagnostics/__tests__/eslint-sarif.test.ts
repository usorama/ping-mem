import { describe, test, expect } from "bun:test";
import { parseSarif } from "../sarif.js";

describe("ESLint SARIF Generator", () => {
  const sampleESLintSarif = {
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "eslint",
            version: "8.56.0",
          },
        },
        results: [
          {
            ruleId: "no-unused-vars",
            level: "warning",
            message: {
              text: "'foo' is defined but never used.",
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: "src/index.ts",
                  },
                  region: {
                    startLine: 5,
                    startColumn: 7,
                    endLine: 5,
                    endColumn: 10,
                  },
                },
              },
            ],
          },
          {
            ruleId: "semi",
            level: "error",
            message: {
              text: "Missing semicolon.",
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: "src/utils.ts",
                  },
                  region: {
                    startLine: 12,
                    startColumn: 20,
                    endLine: 12,
                    endColumn: 20,
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };

  test("Parse ESLint SARIF correctly", () => {
    const result = parseSarif(sampleESLintSarif);

    expect(result.toolName).toBe("eslint");
    expect(result.toolVersion).toBe("8.56.0");
    expect(result.findings).toHaveLength(2);

    expect(result.findings[0]).toMatchObject({
      ruleId: "no-unused-vars",
      severity: "warning",
      message: "'foo' is defined but never used.",
      filePath: "src/index.ts",
      startLine: 5,
      startColumn: 7,
      endLine: 5,
      endColumn: 10,
    });

    expect(result.findings[1]).toMatchObject({
      ruleId: "semi",
      severity: "error",
      message: "Missing semicolon.",
      filePath: "src/utils.ts",
      startLine: 12,
      startColumn: 20,
    });
  });

  test("ESLint SARIF parsing is deterministic", () => {
    const result1 = parseSarif(sampleESLintSarif);
    const result2 = parseSarif(JSON.parse(JSON.stringify(sampleESLintSarif)));

    expect(result1.toolName).toBe(result2.toolName);
    expect(result1.toolVersion).toBe(result2.toolVersion);
    expect(result1.findings).toEqual(result2.findings);
  });
});
