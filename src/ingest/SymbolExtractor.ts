/**
 * SymbolExtractor: Extract symbols (functions, classes, etc.) from source code
 *
 * Supports:
 * - TypeScript/JavaScript via TypeScript Compiler API
 * - Python via regex-based extraction
 *
 * Deterministic: Same source -> same symbols -> same symbolIds
 */

import ts from "typescript";
import * as crypto from "crypto";
import * as path from "path";

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "variable"
  | "constant"
  | "enum"
  | "type_alias"
  | "method"
  | "property";

export interface ExtractedSymbol {
  symbolId: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  startLine: number;
  endLine: number;
  signature?: string | undefined;
}

export class SymbolExtractor {
  extractFromFile(filePath: string, content: string): ExtractedSymbol[] {
    const ext = this.getExtension(filePath);
    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
      return this.extractTypeScript(filePath, content);
    }
    if (ext === ".py") {
      return this.extractPython(filePath, content);
    }
    return [];
  }

  private extractTypeScript(filePath: string, content: string): ExtractedSymbol[] {
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    const symbols: ExtractedSymbol[] = [];

    const visit = (node: ts.Node) => {
      let symbol: Omit<ExtractedSymbol, "symbolId"> | null = null;

      if (ts.isFunctionDeclaration(node) && node.name) {
        const { line: startLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);
        const { line: endLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.end);
        
        symbol = {
          name: node.name.text,
          kind: "function",
          filePath,
          startLine: startLine + 1,
          endLine: endLine + 1,
          signature: node.getText(sourceFile).split('\n')[0]?.trim(),
        };
      } else if (ts.isClassDeclaration(node) && node.name) {
        const { line: startLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);
        const { line: endLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.end);
        
        symbol = {
          name: node.name.text,
          kind: "class",
          filePath,
          startLine: startLine + 1,
          endLine: endLine + 1,
          signature: `class ${node.name.text}`,
        };
      } else if (ts.isInterfaceDeclaration(node)) {
        const { line: startLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);
        const { line: endLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.end);
        
        symbol = {
          name: node.name.text,
          kind: "interface",
          filePath,
          startLine: startLine + 1,
          endLine: endLine + 1,
          signature: `interface ${node.name.text}`,
        };
      } else if (ts.isEnumDeclaration(node)) {
        const { line: startLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);
        const { line: endLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.end);
        
        symbol = {
          name: node.name.text,
          kind: "enum",
          filePath,
          startLine: startLine + 1,
          endLine: endLine + 1,
          signature: `enum ${node.name.text}`,
        };
      } else if (ts.isTypeAliasDeclaration(node)) {
        const { line: startLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);
        const { line: endLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.end);
        
        symbol = {
          name: node.name.text,
          kind: "type_alias",
          filePath,
          startLine: startLine + 1,
          endLine: endLine + 1,
          signature: node.getText(sourceFile).split('\n')[0]?.trim(),
        };
      } else if (ts.isVariableStatement(node)) {
        // Extract variable declarations
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            const { line: startLine } = ts.getLineAndCharacterOfPosition(sourceFile, declaration.pos);
            const { line: endLine } = ts.getLineAndCharacterOfPosition(sourceFile, declaration.end);
            
            const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
            
            const varSymbol: ExtractedSymbol = {
              symbolId: "", // Will be computed below
              name: declaration.name.text,
              kind: isConst ? "constant" : "variable",
              filePath,
              startLine: startLine + 1,
              endLine: endLine + 1,
              signature: declaration.getText(sourceFile).split('\n')[0]?.trim(),
            };
            
            varSymbol.symbolId = this.computeSymbolId(varSymbol);
            symbols.push(varSymbol);
          }
        }
      } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        const { line: startLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);
        const { line: endLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.end);
        
        symbol = {
          name: node.name.text,
          kind: "method",
          filePath,
          startLine: startLine + 1,
          endLine: endLine + 1,
          signature: node.getText(sourceFile).split('\n')[0]?.trim(),
        };
      } else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
        const { line: startLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);
        const { line: endLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.end);
        
        symbol = {
          name: node.name.text,
          kind: "property",
          filePath,
          startLine: startLine + 1,
          endLine: endLine + 1,
          signature: node.getText(sourceFile).split('\n')[0]?.trim(),
        };
      }

      if (symbol) {
        const fullSymbol: ExtractedSymbol = {
          ...symbol,
          symbolId: this.computeSymbolId(symbol),
        };
        symbols.push(fullSymbol);
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return symbols;
  }

  private extractPython(filePath: string, content: string): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    const lines = content.split("\n");

    // Regex patterns for Python
    const functionPattern = /^\s*def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/;
    const classPattern = /^\s*class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[:\(]/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const lineNum = i + 1;

      // Check for function
      const funcMatch = line.match(functionPattern);
      if (funcMatch) {
        const name = funcMatch[1]!;
        // Find end of function (next def/class at same or lower indentation)
        const indent = line.match(/^\s*/)?.[0]?.length ?? 0;
        let endLine = lineNum;
        
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j] ?? "";
          const nextIndent = nextLine.match(/^\s*/)?.[0]?.length ?? 0;
          
          if (nextLine.trim() && nextIndent <= indent && 
              (nextLine.match(functionPattern) || nextLine.match(classPattern))) {
            endLine = j;
            break;
          }
          endLine = j + 1;
        }

        const symbol: Omit<ExtractedSymbol, "symbolId"> = {
          name,
          kind: "function",
          filePath,
          startLine: lineNum,
          endLine,
          signature: line.trim(),
        };

        symbols.push({
          ...symbol,
          symbolId: this.computeSymbolId(symbol),
        });
      }

      // Check for class
      const classMatch = line.match(classPattern);
      if (classMatch) {
        const name = classMatch[1]!;
        // Find end of class
        const indent = line.match(/^\s*/)?.[0]?.length ?? 0;
        let endLine = lineNum;
        
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j] ?? "";
          const nextIndent = nextLine.match(/^\s*/)?.[0]?.length ?? 0;
          
          if (nextLine.trim() && nextIndent <= indent && nextLine.match(classPattern)) {
            endLine = j;
            break;
          }
          endLine = j + 1;
        }

        const symbol: Omit<ExtractedSymbol, "symbolId"> = {
          name,
          kind: "class",
          filePath,
          startLine: lineNum,
          endLine,
          signature: line.trim(),
        };

        symbols.push({
          ...symbol,
          symbolId: this.computeSymbolId(symbol),
        });
      }
    }

    return symbols;
  }

  private computeSymbolId(symbol: Omit<ExtractedSymbol, "symbolId">): string {
    const hash = crypto.createHash("sha256");
    hash.update(symbol.filePath);
    hash.update("\n");
    hash.update(symbol.name);
    hash.update("\n");
    hash.update(symbol.kind);
    hash.update("\n");
    hash.update(String(symbol.startLine));
    return hash.digest("hex");
  }

  private getExtension(filePath: string): string {
    const idx = filePath.lastIndexOf(".");
    if (idx === -1) return "";
    return filePath.slice(idx).toLowerCase();
  }
}
