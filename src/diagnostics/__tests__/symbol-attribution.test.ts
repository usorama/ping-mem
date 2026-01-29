import { describe, test, expect } from "bun:test";
import { SymbolAttributor } from "../SymbolAttributor.js";
import type { ExtractedSymbol } from "../../ingest/SymbolExtractor.js";

describe("SymbolAttributor", () => {
  test("Attribute finding to containing symbol", () => {
    const attributor = new SymbolAttributor();

    const symbols: ExtractedSymbol[] = [
      {
        symbolId: "symbol-1",
        name: "processData",
        kind: "function",
        filePath: "src/utils.ts",
        startLine: 10,
        endLine: 25,
        signature: "function processData(input: string): string",
      },
      {
        symbolId: "symbol-2",
        name: "validateInput",
        kind: "function",
        filePath: "src/utils.ts",
        startLine: 30,
        endLine: 40,
      },
    ];

    attributor.addSymbols("src/utils.ts", symbols);

    // Finding at line 15 should be attributed to processData
    const attr1 = attributor.findSymbolForLocation("src/utils.ts", 15);
    expect(attr1).toMatchObject({
      symbolId: "symbol-1",
      symbolName: "processData",
      symbolKind: "function",
    });

    // Finding at line 35 should be attributed to validateInput
    const attr2 = attributor.findSymbolForLocation("src/utils.ts", 35);
    expect(attr2).toMatchObject({
      symbolId: "symbol-2",
      symbolName: "validateInput",
      symbolKind: "function",
    });

    // Finding at line 5 (before any symbol) should not be attributed
    const attr3 = attributor.findSymbolForLocation("src/utils.ts", 5);
    expect(attr3).toBeNull();

    // Finding in unknown file should not be attributed
    const attr4 = attributor.findSymbolForLocation("src/other.ts", 15);
    expect(attr4).toBeNull();
  });

  test("Choose most specific symbol for nested symbols", () => {
    const attributor = new SymbolAttributor();

    const symbols: ExtractedSymbol[] = [
      {
        symbolId: "class-1",
        name: "MyClass",
        kind: "class",
        filePath: "src/class.ts",
        startLine: 1,
        endLine: 50,
      },
      {
        symbolId: "method-1",
        name: "myMethod",
        kind: "method",
        filePath: "src/class.ts",
        startLine: 10,
        endLine: 20,
      },
    ];

    attributor.addSymbols("src/class.ts", symbols);

    // Finding at line 15 should be attributed to method (more specific)
    const attr = attributor.findSymbolForLocation("src/class.ts", 15);
    expect(attr).toMatchObject({
      symbolId: "method-1",
      symbolName: "myMethod",
      symbolKind: "method",
    });
  });

  test("Clear symbols", () => {
    const attributor = new SymbolAttributor();

    attributor.addSymbols("src/test.ts", [
      {
        symbolId: "symbol-1",
        name: "test",
        kind: "function",
        filePath: "src/test.ts",
        startLine: 1,
        endLine: 10,
      },
    ]);

    expect(attributor.findSymbolForLocation("src/test.ts", 5)).toBeTruthy();

    attributor.clear();

    expect(attributor.findSymbolForLocation("src/test.ts", 5)).toBeNull();
  });
});
