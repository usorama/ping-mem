import { describe, test, expect } from "bun:test";
import { parseSarif } from "../sarif.js";

describe("Prettier SARIF Generator", () => {
  const samplePrettierSarif = {
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "prettier",
            version: "3.1.1",
          },
        },
        results: [
          {
            ruleId: "prettier/prettier",
            level: "warning",
            message: {
              text: "File is not formatted according to Prettier rules",
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: "src/index.ts",
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
          },
          {
            ruleId: "prettier/prettier",
            level: "warning",
            message: {
              text: "File is not formatted according to Prettier rules",
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: "src/utils.ts",
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
          },
        ],
      },
    ],
  };

  test("Parse Prettier SARIF correctly", () => {
    const result = parseSarif(samplePrettierSarif);

    expect(result.toolName).toBe("prettier");
    expect(result.toolVersion).toBe("3.1.1");
    expect(result.findings).toHaveLength(2);

    expect(result.findings[0]).toMatchObject({
      ruleId: "prettier/prettier",
      severity: "warning",
      message: "File is not formatted according to Prettier rules",
      filePath: "src/index.ts",
      startLine: 1,
    });

    expect(result.findings[1]).toMatchObject({
      ruleId: "prettier/prettier",
      severity: "warning",
      filePath: "src/utils.ts",
    });
  });

  test("Prettier SARIF parsing is deterministic", () => {
    const result1 = parseSarif(samplePrettierSarif);
    const result2 = parseSarif(JSON.parse(JSON.stringify(samplePrettierSarif)));

    expect(result1.toolName).toBe(result2.toolName);
    expect(result1.toolVersion).toBe(result2.toolVersion);
    expect(result1.findings).toEqual(result2.findings);
  });
});
