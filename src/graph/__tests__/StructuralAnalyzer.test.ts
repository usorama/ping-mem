/**
 * Tests for StructuralAnalyzer: import/export/call graph extraction.
 */

import { describe, test, expect } from "bun:test";
import { StructuralAnalyzer } from "../StructuralAnalyzer.js";

describe("StructuralAnalyzer", () => {
  const analyzer = new StructuralAnalyzer();

  const projectFiles = new Set([
    "src/index.ts",
    "src/utils.ts",
    "src/types.ts",
    "src/service/UserService.ts",
    "src/service/AuthService.ts",
    "src/graph/Neo4jClient.ts",
    "backend/rankforge/__init__.py",
    "backend/rankforge/api/main.py",
    "backend/rankforge/api/routers/profile.py",
    "backend/rankforge/api/routers/dashboard.py",
    "backend/rankforge/practice/__init__.py",
    "backend/rankforge/practice/ap_integer.py",
    "backend/rankforge/practice/base.py",
    "backend/rankforge/scoring/__init__.py",
    "backend/rankforge/scoring/predict.py",
    "backend/tests/practice/__init__.py",
    "backend/tests/practice/_helpers.py",
  ]);

  // ===========================================================================
  // Import extraction
  // ===========================================================================

  describe("import extraction", () => {
    test("extracts named imports", () => {
      const content = `import { Neo4jClient, createNeo4jClient } from "./graph/Neo4jClient.js";`;
      const result = analyzer.analyzeFile("src/index.ts", content, projectFiles);

      const imports = result.edges.filter((e) => e.kind === "IMPORTS_FROM");
      expect(imports.length).toBe(2);
      expect(imports[0]?.symbolName).toBe("Neo4jClient");
      expect(imports[1]?.symbolName).toBe("createNeo4jClient");
      expect(imports[0]?.targetFile).toBe("src/graph/Neo4jClient.ts");
      expect(imports[0]?.isExternal).toBe(false);
    });

    test("extracts default import", () => {
      const content = `import Neo4j from "./graph/Neo4jClient.js";`;
      const result = analyzer.analyzeFile("src/index.ts", content, projectFiles);

      const imports = result.edges.filter((e) => e.kind === "IMPORTS_FROM");
      expect(imports.length).toBe(1);
      expect(imports[0]?.symbolName).toBe("Neo4j");
    });

    test("extracts namespace import", () => {
      const content = `import * as utils from "./utils.js";`;
      const result = analyzer.analyzeFile("src/index.ts", content, projectFiles);

      const imports = result.edges.filter((e) => e.kind === "IMPORTS_FROM");
      expect(imports.length).toBe(1);
      expect(imports[0]?.symbolName).toBe("* as utils");
      expect(imports[0]?.targetFile).toBe("src/utils.ts");
    });

    test("extracts side-effect import", () => {
      const content = `import "./styles.css";`;
      const result = analyzer.analyzeFile("src/index.ts", content, projectFiles);

      const imports = result.edges.filter((e) => e.kind === "IMPORTS_FROM");
      expect(imports.length).toBe(1);
      expect(imports[0]?.symbolName).toBe("<side-effect>");
    });

    test("identifies external imports", () => {
      const content = `import neo4j from "neo4j-driver";`;
      const result = analyzer.analyzeFile("src/index.ts", content, projectFiles);

      const imports = result.edges.filter((e) => e.kind === "IMPORTS_FROM");
      expect(imports.length).toBe(1);
      expect(imports[0]?.isExternal).toBe(true);
      expect(imports[0]?.targetFile).toBe("neo4j-driver");
    });

    test("resolves relative imports correctly", () => {
      const content = `import { AuthService } from "./AuthService.js";`;
      const result = analyzer.analyzeFile("src/service/UserService.ts", content, projectFiles);

      const imports = result.edges.filter((e) => e.kind === "IMPORTS_FROM");
      expect(imports.length).toBe(1);
      expect(imports[0]?.targetFile).toBe("src/service/AuthService.ts");
    });

    test("extracts type-only imports", () => {
      const content = `import type { SessionId } from "./types.js";`;
      const result = analyzer.analyzeFile("src/index.ts", content, projectFiles);

      const imports = result.edges.filter((e) => e.kind === "IMPORTS_FROM");
      expect(imports.length).toBe(1);
      expect(imports[0]?.symbolName).toBe("SessionId");
    });

    test("extracts Python package imports from internal modules", () => {
      const content = `
from rankforge.practice.base import Drill, rng_from_seed
from rankforge.scoring import predict
`;
      const result = analyzer.analyzeFile(
        "backend/rankforge/practice/ap_integer.py",
        content,
        projectFiles,
      );

      const imports = result.edges.filter((e) => e.kind === "IMPORTS_FROM");
      expect(imports.length).toBe(3);
      expect(imports[0]?.targetFile).toBe("backend/rankforge/practice/base.py");
      expect(imports[0]?.isExternal).toBe(false);
      expect(imports[1]?.targetFile).toBe("backend/rankforge/practice/base.py");
      expect(imports[2]?.targetFile).toBe("backend/rankforge/scoring/predict.py");
    });

    test("extracts Python relative imports", () => {
      const content = `
from .base import Drill
from ..scoring.predict import predict_board_score
from . import base
`;
      const result = analyzer.analyzeFile(
        "backend/rankforge/practice/ap_integer.py",
        content,
        projectFiles,
      );

      const imports = result.edges.filter((e) => e.kind === "IMPORTS_FROM");
      expect(imports.length).toBe(3);
      expect(imports[0]?.targetFile).toBe("backend/rankforge/practice/base.py");
      expect(imports[1]?.targetFile).toBe("backend/rankforge/scoring/predict.py");
      expect(imports[2]?.targetFile).toBe("backend/rankforge/practice/base.py");
    });

    test("extracts multiline Python imports", () => {
      const content = `
from rankforge.api.routers import (
  profile,
  dashboard as dashboard_router,
)
`;
      const result = analyzer.analyzeFile(
        "backend/rankforge/api/main.py",
        content,
        projectFiles,
      );

      const imports = result.edges.filter((e) => e.kind === "IMPORTS_FROM");
      expect(imports.length).toBe(2);
      expect(imports[0]?.symbolName).toBe("profile");
      expect(imports[0]?.targetFile).toBe("backend/rankforge/api/routers/profile.py");
      expect(imports[1]?.symbolName).toBe("dashboard");
      expect(imports[1]?.targetFile).toBe("backend/rankforge/api/routers/dashboard.py");
    });

    test("treats unresolved Python stdlib imports as external", () => {
      const content = `import json as _json, os`;
      const result = analyzer.analyzeFile(
        "backend/tests/practice/_helpers.py",
        content,
        projectFiles,
      );

      const imports = result.edges.filter((e) => e.kind === "IMPORTS_FROM");
      expect(imports.length).toBe(2);
      expect(imports[0]?.isExternal).toBe(true);
      expect(imports[0]?.targetFile).toBe("json");
      expect(imports[1]?.isExternal).toBe(true);
      expect(imports[1]?.targetFile).toBe("os");
    });
  });

  // ===========================================================================
  // Export extraction
  // ===========================================================================

  describe("export extraction", () => {
    test("extracts named export declarations", () => {
      const content = `
export function createClient() {}
export class UserService {}
export const VERSION = "1.0";
export interface Config {}
export type UserId = string;
export enum Status { Active, Inactive }
`;
      const result = analyzer.analyzeFile("src/index.ts", content, projectFiles);

      const exports = result.edges.filter((e) => e.kind === "EXPORTS");
      const names = exports.map((e) => e.symbolName);
      expect(names).toContain("createClient");
      expect(names).toContain("UserService");
      expect(names).toContain("VERSION");
      expect(names).toContain("Config");
      expect(names).toContain("UserId");
      expect(names).toContain("Status");
    });

    test("extracts re-exports", () => {
      const content = `
export { Neo4jClient } from "./graph/Neo4jClient.js";
export * from "./types.js";
`;
      const result = analyzer.analyzeFile("src/index.ts", content, projectFiles);

      const exports = result.edges.filter((e) => e.kind === "EXPORTS");
      expect(exports.length).toBe(2);
      expect(exports[0]?.symbolName).toBe("Neo4jClient");
      expect(exports[0]?.targetFile).toBe("src/graph/Neo4jClient.ts");
      expect(exports[1]?.symbolName).toBe("*");
      expect(exports[1]?.targetFile).toBe("src/types.ts");
    });

    test("extracts named re-exports from self", () => {
      const content = `
const foo = 1;
const bar = 2;
export { foo, bar };
`;
      const result = analyzer.analyzeFile("src/utils.ts", content, projectFiles);

      const exports = result.edges.filter((e) => e.kind === "EXPORTS");
      expect(exports.length).toBe(2);
      expect(exports[0]?.symbolName).toBe("foo");
      expect(exports[0]?.targetFile).toBe("src/utils.ts");
    });
  });

  // ===========================================================================
  // Call graph extraction
  // ===========================================================================

  describe("call graph extraction", () => {
    test("extracts simple function calls", () => {
      const content = `
const logger = createLogger("test");
doSomething();
`;
      const result = analyzer.analyzeFile("src/index.ts", content, projectFiles);

      const calls = result.edges.filter((e) => e.kind === "CALLS");
      const names = calls.map((e) => e.symbolName);
      expect(names).toContain("createLogger");
      expect(names).toContain("doSomething");
    });

    test("extracts method calls", () => {
      const content = `
const result = client.connect();
this.processData();
foo.bar.baz();
`;
      const result = analyzer.analyzeFile("src/index.ts", content, projectFiles);

      const calls = result.edges.filter((e) => e.kind === "CALLS");
      const names = calls.map((e) => e.symbolName);
      expect(names).toContain("client.connect");
      expect(names).toContain("this.processData");
      expect(names).toContain("foo.bar.baz");
    });

    test("extracts new expressions", () => {
      const content = `
const client = new Neo4jClient({ uri: "bolt://localhost" });
const service = new auth.UserService();
`;
      const result = analyzer.analyzeFile("src/index.ts", content, projectFiles);

      const calls = result.edges.filter((e) => e.kind === "CALLS");
      const names = calls.map((e) => e.symbolName);
      expect(names).toContain("new Neo4jClient");
      expect(names).toContain("new auth.UserService");
    });
  });

  // ===========================================================================
  // Edge ID determinism
  // ===========================================================================

  describe("determinism", () => {
    test("produces identical edge IDs for same input", () => {
      const content = `import { foo } from "./utils.js";`;
      const result1 = analyzer.analyzeFile("src/index.ts", content, projectFiles);
      const result2 = analyzer.analyzeFile("src/index.ts", content, projectFiles);

      expect(result1.edges.length).toBe(result2.edges.length);
      for (let i = 0; i < result1.edges.length; i++) {
        expect(result1.edges[i]?.edgeId).toBe(result2.edges[i]?.edgeId);
      }
    });

    test("produces different edge IDs for different source files", () => {
      const content = `import { foo } from "./utils.js";`;
      const result1 = analyzer.analyzeFile("src/a.ts", content, projectFiles);
      const result2 = analyzer.analyzeFile("src/b.ts", content, projectFiles);

      expect(result1.edges[0]?.edgeId).not.toBe(result2.edges[0]?.edgeId);
    });
  });

  // ===========================================================================
  // Project-level analysis
  // ===========================================================================

  describe("analyzeProject", () => {
    test("analyzes multiple files", () => {
      const files = [
        {
          filePath: "src/index.ts",
          content: `import { UserService } from "./service/UserService.js";\nconst svc = new UserService();`,
        },
        {
          filePath: "src/service/UserService.ts",
          content: `import { AuthService } from "./AuthService.js";\nexport class UserService {}`,
        },
        {
          filePath: "src/service/AuthService.ts",
          content: `export class AuthService {}`,
        },
      ];

      const result = analyzer.analyzeProject(files, projectFiles);

      expect(result.filesAnalyzed).toBe(3);
      expect(result.edges.length).toBeGreaterThan(0);

      const imports = result.edges.filter((e) => e.kind === "IMPORTS_FROM");
      expect(imports.length).toBeGreaterThanOrEqual(2);
    });

    test("skips unsupported file types", () => {
      const files = [
        { filePath: "README.md", content: "# Hello" },
        { filePath: "data.json", content: '{"key": "value"}' },
      ];

      const result = analyzer.analyzeProject(files, projectFiles);
      expect(result.filesAnalyzed).toBe(2);
      expect(result.edges.length).toBe(0);
    });

    test("analyzes Python files in projects", () => {
      const files = [
        {
          filePath: "backend/rankforge/practice/ap_integer.py",
          content: `from rankforge.practice.base import Drill`,
        },
        {
          filePath: "backend/rankforge/practice/base.py",
          content: `class Drill: pass`,
        },
      ];

      const result = analyzer.analyzeProject(files, projectFiles);
      const imports = result.edges.filter((e) => e.kind === "IMPORTS_FROM");

      expect(result.filesAnalyzed).toBe(2);
      expect(imports.length).toBe(1);
      expect(imports[0]?.targetFile).toBe("backend/rankforge/practice/base.py");
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe("edge cases", () => {
    test("handles empty file", () => {
      const result = analyzer.analyzeFile("src/index.ts", "", projectFiles);
      expect(result.edges.length).toBe(0);
    });

    test("handles file with only comments", () => {
      const result = analyzer.analyzeFile("src/index.ts", "// just a comment\n/* block */", projectFiles);
      expect(result.edges.length).toBe(0);
    });

    test("handles dynamic imports gracefully", () => {
      const content = `const mod = await import("./utils.js");`;
      const result = analyzer.analyzeFile("src/index.ts", content, projectFiles);
      // Dynamic imports are call expressions, not import declarations
      const calls = result.edges.filter((e) => e.kind === "CALLS");
      // Should not crash
      expect(result.edges.length).toBeGreaterThanOrEqual(0);
    });
  });
});
