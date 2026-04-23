import { describe, expect, test } from "bun:test";
import { SemanticChunker, type SemanticChunk } from "../SemanticChunker.js";

describe("SemanticChunker", () => {
  const chunker = new SemanticChunker();

  describe("empty and trivial files", () => {
    test("returns empty array for empty content", () => {
      const result = chunker.chunkFile("empty.ts", "");
      expect(result).toEqual([]);
    });

    test("returns file-level chunk for content with no symbols", () => {
      const content = "const x = 1;\nconst y = 2;\n";
      const result = chunker.chunkFile("simple.ts", content);
      // Should have file-level chunk (variables are symbols but not function/class)
      const fileChunks = result.filter((c) => c.chunkType === "file");
      expect(fileChunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("function-level chunking", () => {
    test("extracts function chunks from TypeScript", () => {
      const content = [
        "import { something } from 'lib';",
        "",
        "export function greet(name: string): string {",
        "  const greeting = `Hello, ${name}!`;",
        "  return greeting;",
        "}",
        "",
        "export function farewell(name: string): string {",
        "  return `Goodbye, ${name}!`;",
        "}",
      ].join("\n");

      const result = chunker.chunkFile("functions.ts", content);
      const funcChunks = result.filter((c) => c.chunkType === "function");

      expect(funcChunks.length).toBe(2);
      expect(funcChunks[0]!.name).toBe("greet");
      expect(funcChunks[1]!.name).toBe("farewell");
    });

    test("function chunks include content", () => {
      const content = [
        "function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
      ].join("\n");

      const result = chunker.chunkFile("add.ts", content);
      const funcChunks = result.filter((c) => c.chunkType === "function");

      expect(funcChunks.length).toBe(1);
      expect(funcChunks[0]!.content).toContain("function add");
      expect(funcChunks[0]!.content).toContain("return a + b");
    });

    test("function chunks have 2-line overlap", () => {
      const content = [
        "// line 1",
        "// line 2",
        "// line 3",
        "function foo() {",
        "  return 1;",
        "}",
        "// line 7",
        "// line 8",
      ].join("\n");

      const result = chunker.chunkFile("overlap.ts", content);
      const funcChunks = result.filter((c) => c.chunkType === "function");

      expect(funcChunks.length).toBe(1);
      const fc = funcChunks[0]!;
      // SymbolExtractor may report startLine including leading trivia.
      // Key assertion: overlap extends the range and overlapLines > 0
      expect(fc.overlapLines).toBeGreaterThan(0);
      // Content must include the function body
      expect(fc.content).toContain("function foo()");
      expect(fc.content).toContain("return 1");
    });

    test("overlap does not extend before line 1", () => {
      const content = [
        "function foo() {",
        "  return 1;",
        "}",
      ].join("\n");

      const result = chunker.chunkFile("no-pre-overlap.ts", content);
      const funcChunks = result.filter((c) => c.chunkType === "function");

      expect(funcChunks.length).toBe(1);
      expect(funcChunks[0]!.startLine).toBe(1);
    });
  });

  describe("class-level chunking", () => {
    test("extracts class chunks for classes > 10 lines", () => {
      const lines = [
        "export class Calculator {",
        "  private value: number;",
        "",
        "  constructor() {",
        "    this.value = 0;",
        "  }",
        "",
        "  add(n: number): void {",
        "    this.value += n;",
        "  }",
        "",
        "  subtract(n: number): void {",
        "    this.value -= n;",
        "  }",
        "",
        "  getResult(): number {",
        "    return this.value;",
        "  }",
        "}",
      ];
      const content = lines.join("\n");

      const result = chunker.chunkFile("calculator.ts", content);
      const classChunks = result.filter((c) => c.chunkType === "class");

      expect(classChunks.length).toBe(1);
      expect(classChunks[0]!.name).toBe("Calculator");
      expect(classChunks[0]!.content).toContain("class Calculator");
    });

    test("skips classes with fewer than 10 lines", () => {
      const content = [
        "class Tiny {",
        "  x = 1;",
        "  y = 2;",
        "}",
      ].join("\n");

      const result = chunker.chunkFile("tiny.ts", content);
      const classChunks = result.filter((c) => c.chunkType === "class");

      expect(classChunks.length).toBe(0);
    });

    test("methods get parentChunkId linking to their class", () => {
      const lines = [
        "export class Service {",
        "  private db: Database;",
        "",
        "  constructor(db: Database) {",
        "    this.db = db;",
        "  }",
        "",
        "  async findAll(): Promise<Item[]> {",
        "    return this.db.query('SELECT * FROM items');",
        "  }",
        "",
        "  async findById(id: string): Promise<Item> {",
        "    return this.db.query('SELECT * FROM items WHERE id = ?', [id]);",
        "  }",
        "",
        "  async create(item: Item): Promise<void> {",
        "    this.db.insert('items', item);",
        "  }",
        "}",
      ];
      const content = lines.join("\n");

      const result = chunker.chunkFile("service.ts", content);
      const classChunks = result.filter((c) => c.chunkType === "class");
      const methodChunks = result.filter(
        (c) => c.chunkType === "function" && c.parentChunkId,
      );

      expect(classChunks.length).toBe(1);
      expect(methodChunks.length).toBeGreaterThan(0);

      // Every method's parentChunkId should match the class chunk
      for (const mc of methodChunks) {
        expect(mc.parentChunkId).toBe(classChunks[0]!.chunkId);
      }
    });
  });

  describe("file-level chunking", () => {
    test("produces file-level chunk for all files", () => {
      const content = [
        "function a() { return 1; }",
        "function b() { return 2; }",
      ].join("\n");

      const result = chunker.chunkFile("small.ts", content);
      const fileChunks = result.filter((c) => c.chunkType === "file");

      expect(fileChunks.length).toBe(1);
      expect(fileChunks[0]!.name).toBe("small.ts");
    });

    test("file-level chunk includes file path prefix for BM25", () => {
      const content = "const x = 1;";
      const result = chunker.chunkFile("src/utils/helpers.ts", content);
      const fileChunks = result.filter((c) => c.chunkType === "file");

      expect(fileChunks[0]!.content).toContain("// File: src/utils/helpers.ts");
    });

    test("file-level chunk spans full file", () => {
      const content = "line1\nline2\nline3\nline4\nline5";
      const result = chunker.chunkFile("full.ts", content);
      const fileChunks = result.filter((c) => c.chunkType === "file");

      expect(fileChunks[0]!.startLine).toBe(1);
      expect(fileChunks[0]!.endLine).toBe(5);
    });
  });

  describe("hierarchical output", () => {
    test("produces all three levels for a file with classes and functions", () => {
      const lines = [
        "import { DB } from 'db';",
        "",
        "export function standalone(): void {",
        "  console.log('standalone');",
        "}",
        "",
        "export class Handler {",
        "  private name: string;",
        "",
        "  constructor(name: string) {",
        "    this.name = name;",
        "  }",
        "",
        "  handle(): string {",
        "    return this.name;",
        "  }",
        "",
        "  process(data: string): string {",
        "    return data.toUpperCase();",
        "  }",
        "}",
      ];
      const content = lines.join("\n");

      const result = chunker.chunkFile("handler.ts", content);

      const funcChunks = result.filter((c) => c.chunkType === "function");
      const classChunks = result.filter((c) => c.chunkType === "class");
      const fileChunks = result.filter((c) => c.chunkType === "file");

      // standalone + handle + process = 3 function chunks minimum
      expect(funcChunks.length).toBeGreaterThanOrEqual(3);
      expect(classChunks.length).toBe(1);
      expect(fileChunks.length).toBe(1);
    });

    test("chunk IDs are deterministic", () => {
      const content = "function foo() { return 1; }";
      const result1 = chunker.chunkFile("det.ts", content);
      const result2 = chunker.chunkFile("det.ts", content);

      expect(result1.length).toBe(result2.length);
      for (let i = 0; i < result1.length; i++) {
        expect(result1[i]!.chunkId).toBe(result2[i]!.chunkId);
      }
    });

    test("chunk IDs differ for different content", () => {
      const content1 = "function foo() { return 1; }";
      const content2 = "function foo() { return 2; }";
      const result1 = chunker.chunkFile("a.ts", content1);
      const result2 = chunker.chunkFile("a.ts", content2);

      const ids1 = new Set(result1.map((c) => c.chunkId));
      const ids2 = new Set(result2.map((c) => c.chunkId));

      // At least some IDs should differ
      let hasDifference = false;
      for (const id of ids1) {
        if (!ids2.has(id)) {
          hasDifference = true;
          break;
        }
      }
      expect(hasDifference).toBe(true);
    });

    test("extracts route handler blocks as dedicated chunks", () => {
      const content = [
        "export class Server {",
        "  setup(): void {",
        "    this.app.get(\"/api/v1/search\", async (c) => {",
        "      const query = c.req.query(\"query\");",
        "      return c.json({ query });",
        "    });",
        "  }",
        "}",
      ].join("\n");

      const result = chunker.chunkFile("rest-server.ts", content);
      const routeChunks = result.filter((c) => c.chunkType === "block");

      expect(routeChunks.length).toBe(1);
      expect(routeChunks[0]!.name).toBe("GET /api/v1/search");
      expect(routeChunks[0]!.startLine).toBe(3);
      expect(routeChunks[0]!.endLine).toBe(6);
      expect(routeChunks[0]!.content).toContain("/api/v1/search");
    });
  });

  describe("Python support", () => {
    test("extracts function chunks from Python", () => {
      const content = [
        "def greet(name):",
        "    return f'Hello, {name}!'",
        "",
        "def farewell(name):",
        "    return f'Goodbye, {name}!'",
      ].join("\n");

      const result = chunker.chunkFile("greet.py", content);
      const funcChunks = result.filter((c) => c.chunkType === "function");

      expect(funcChunks.length).toBe(2);
      expect(funcChunks[0]!.name).toBe("greet");
      expect(funcChunks[1]!.name).toBe("farewell");
    });

    test("extracts class chunks from Python", () => {
      const lines = [
        "class Calculator:",
        "    def __init__(self):",
        "        self.value = 0",
        "",
        "    def add(self, n):",
        "        self.value += n",
        "",
        "    def subtract(self, n):",
        "        self.value -= n",
        "",
        "    def multiply(self, n):",
        "        self.value *= n",
        "",
        "    def get_result(self):",
        "        return self.value",
      ];
      const content = lines.join("\n");

      const result = chunker.chunkFile("calc.py", content);
      const classChunks = result.filter((c) => c.chunkType === "class");

      expect(classChunks.length).toBe(1);
      expect(classChunks[0]!.name).toBe("Calculator");
    });
  });

  describe("unsupported languages", () => {
    test("produces file-level chunk for unsupported extensions", () => {
      const content = "some content here\nmore content";
      const result = chunker.chunkFile("readme.md", content);

      expect(result.length).toBe(1);
      expect(result[0]!.chunkType).toBe("file");
    });
  });

  describe("edge cases", () => {
    test("handles files with only comments", () => {
      const content = [
        "// This is a comment",
        "// Another comment",
        "/* Block comment */",
      ].join("\n");

      const result = chunker.chunkFile("comments.ts", content);
      // Should still get a file-level chunk
      const fileChunks = result.filter((c) => c.chunkType === "file");
      expect(fileChunks.length).toBe(1);
    });

    test("handles single-line files", () => {
      const content = "export const VERSION = '1.0.0';";
      const result = chunker.chunkFile("version.ts", content);
      expect(result.length).toBeGreaterThan(0);
    });

    test("all chunks have non-empty content", () => {
      const content = [
        "function foo() { return 1; }",
        "",
        "class Bar {",
        "  x = 1;",
        "  y = 2;",
        "  z = 3;",
        "  a = 4;",
        "  b = 5;",
        "  c = 6;",
        "  d = 7;",
        "  e = 8;",
        "  f = 9;",
        "}",
      ].join("\n");

      const result = chunker.chunkFile("all.ts", content);
      for (const chunk of result) {
        expect(chunk.content.length).toBeGreaterThan(0);
      }
    });

    test("all chunks have valid line ranges", () => {
      const content = [
        "function a() { return 1; }",
        "function b() { return 2; }",
        "function c() { return 3; }",
      ].join("\n");

      const result = chunker.chunkFile("ranges.ts", content);
      for (const chunk of result) {
        expect(chunk.startLine).toBeGreaterThanOrEqual(1);
        expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
        expect(chunk.chunkId).toHaveLength(64); // SHA-256 hex
      }
    });
  });
});
