import { describe, test, expect } from "bun:test";
import { SymbolExtractor } from "../SymbolExtractor.js";

describe("SymbolExtractor", () => {
  const extractor = new SymbolExtractor();

  describe("TypeScript extraction", () => {
    test("Extract function declarations", () => {
      const content = `
export function greet(name: string): string {
  return "Hello, " + name;
}

function helper() {
  return 42;
}
      `.trim();

      const symbols = extractor.extractFromFile("test.ts", content);

      expect(symbols).toHaveLength(2);
      expect(symbols[0]).toMatchObject({
        name: "greet",
        kind: "function",
        filePath: "test.ts",
        startLine: 1,
      });
      expect(symbols[0].symbolId).toBeTruthy();

      expect(symbols[1]).toMatchObject({
        name: "helper",
        kind: "function",
        filePath: "test.ts",
      });
    });

    test("Extract class declarations", () => {
      const content = `
export class User {
  name: string;
  
  constructor(name: string) {
    this.name = name;
  }
  
  greet() {
    return "Hello";
  }
}
      `.trim();

      const symbols = extractor.extractFromFile("test.ts", content);

      const classes = symbols.filter(s => s.kind === "class");
      const methods = symbols.filter(s => s.kind === "method");
      const properties = symbols.filter(s => s.kind === "property");

      expect(classes).toHaveLength(1);
      expect(classes[0]).toMatchObject({
        name: "User",
        kind: "class",
      });

      expect(methods).toHaveLength(1);
      expect(methods[0]).toMatchObject({
        name: "greet",
        kind: "method",
      });

      expect(properties).toHaveLength(1);
      expect(properties[0]).toMatchObject({
        name: "name",
        kind: "property",
      });
    });

    test("Extract interfaces and type aliases", () => {
      const content = `
interface Person {
  name: string;
  age: number;
}

type UserId = string;

enum Status {
  Active,
  Inactive
}
      `.trim();

      const symbols = extractor.extractFromFile("test.ts", content);

      expect(symbols).toHaveLength(3);
      
      const iface = symbols.find(s => s.kind === "interface");
      expect(iface).toMatchObject({
        name: "Person",
        kind: "interface",
      });

      const typeAlias = symbols.find(s => s.kind === "type_alias");
      expect(typeAlias).toMatchObject({
        name: "UserId",
        kind: "type_alias",
      });

      const enumSym = symbols.find(s => s.kind === "enum");
      expect(enumSym).toMatchObject({
        name: "Status",
        kind: "enum",
      });
    });

    test("Extract variables and constants", () => {
      const content = `
const API_KEY = "secret";
let counter = 0;
var legacy = true;
      `.trim();

      const symbols = extractor.extractFromFile("test.ts", content);

      expect(symbols).toHaveLength(3);
      
      const constant = symbols.find(s => s.name === "API_KEY");
      expect(constant?.kind).toBe("constant");

      const variable1 = symbols.find(s => s.name === "counter");
      expect(variable1?.kind).toBe("variable");

      const variable2 = symbols.find(s => s.name === "legacy");
      expect(variable2?.kind).toBe("variable");
    });
  });

  describe("Python extraction", () => {
    test("Extract function definitions", () => {
      const content = `
def greet(name):
    return f"Hello, {name}"

def helper():
    return 42
      `.trim();

      const symbols = extractor.extractFromFile("test.py", content);

      expect(symbols).toHaveLength(2);
      expect(symbols[0]).toMatchObject({
        name: "greet",
        kind: "function",
        filePath: "test.py",
        startLine: 1,
      });

      expect(symbols[1]).toMatchObject({
        name: "helper",
        kind: "function",
        filePath: "test.py",
      });
    });

    test("Extract class definitions", () => {
      const content = `
class User:
    def __init__(self, name):
        self.name = name
    
    def greet(self):
        return "Hello"

class Admin(User):
    pass
      `.trim();

      const symbols = extractor.extractFromFile("test.py", content);

      const classes = symbols.filter(s => s.kind === "class");
      expect(classes).toHaveLength(2);
      expect(classes[0]).toMatchObject({
        name: "User",
        kind: "class",
      });
      expect(classes[1]).toMatchObject({
        name: "Admin",
        kind: "class",
      });
    });
  });

  describe("Determinism", () => {
    test("Same source produces same symbolIds", () => {
      const content = `
export function test() {
  return 42;
}
      `.trim();

      const symbols1 = extractor.extractFromFile("test.ts", content);
      const symbols2 = extractor.extractFromFile("test.ts", content);

      expect(symbols1[0].symbolId).toBe(symbols2[0].symbolId);
    });

    test("Different files produce different symbolIds", () => {
      const content = `
export function test() {
  return 42;
}
      `.trim();

      const symbols1 = extractor.extractFromFile("file1.ts", content);
      const symbols2 = extractor.extractFromFile("file2.ts", content);

      expect(symbols1[0].symbolId).not.toBe(symbols2[0].symbolId);
    });
  });
});
