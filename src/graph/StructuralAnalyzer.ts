/**
 * StructuralAnalyzer: Extract import/export/call relationships from TypeScript/JavaScript AST.
 *
 * Leverages the TypeScript Compiler API (already used by SymbolExtractor) to parse:
 * - Import declarations → IMPORTS_FROM edges
 * - Export declarations → EXPORTS edges
 * - Function/method calls → CALLS edges
 *
 * Deterministic: Same source → same edges.
 * Zero new runtime dependencies (uses existing `typescript` package).
 *
 * @module graph/StructuralAnalyzer
 */

import ts from "typescript";
import * as crypto from "crypto";
import * as path from "path";
import { createLogger } from "../util/logger.js";

const log = createLogger("StructuralAnalyzer");

// ============================================================================
// Types
// ============================================================================

export type StructuralEdgeKind = "IMPORTS_FROM" | "CALLS" | "EXPORTS";

export interface StructuralEdge {
  /** Deterministic ID: sha256(sourceFile + kind + target + name) */
  edgeId: string;
  kind: StructuralEdgeKind;
  /** File path (relative to project root) that contains this reference */
  sourceFile: string;
  /** Resolved target file path (relative to project root), or module specifier if external */
  targetFile: string;
  /** The imported/exported/called symbol name (e.g., "Neo4jClient", "createLogger") */
  symbolName: string;
  /** Line number where the reference occurs (1-based) */
  line: number;
  /** Whether the target is an external (node_modules) or project-internal module */
  isExternal: boolean;
}

export interface StructuralAnalysisResult {
  /** All edges found in one file */
  edges: StructuralEdge[];
  /** File that was analyzed */
  filePath: string;
}

export interface ProjectStructuralResult {
  /** All edges across the project */
  edges: StructuralEdge[];
  /** Number of files analyzed */
  filesAnalyzed: number;
}

// ============================================================================
// StructuralAnalyzer
// ============================================================================

export class StructuralAnalyzer {
  private static readonly SUPPORTED_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ]);

  /**
   * Analyze a single file for structural edges (imports, exports, calls).
   *
   * @param filePath - Relative path to file within project
   * @param content - File content
   * @param projectFiles - Set of all project file paths (for resolving internal vs external)
   * @returns StructuralAnalysisResult with all edges
   */
  analyzeFile(
    filePath: string,
    content: string,
    projectFiles: Set<string>,
  ): StructuralAnalysisResult {
    const ext = this.getExtension(filePath);
    if (!StructuralAnalyzer.SUPPORTED_EXTENSIONS.has(ext)) {
      return { edges: [], filePath };
    }

    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
    );

    const edges: StructuralEdge[] = [];

    const visit = (node: ts.Node): void => {
      // Import declarations: import { Foo } from "./bar"
      if (ts.isImportDeclaration(node)) {
        this.extractImportEdges(node, sourceFile, filePath, projectFiles, edges);
      }

      // Export declarations: export { Foo } from "./bar" (re-exports)
      if (ts.isExportDeclaration(node)) {
        this.extractExportEdges(node, sourceFile, filePath, projectFiles, edges);
      }

      // Named export: export function foo() {} / export class Bar {}
      if (this.isNamedExport(node)) {
        this.extractNamedExportEdge(node, sourceFile, filePath, edges);
      }

      // Call expressions: foo(), bar.baz(), new Foo()
      if (ts.isCallExpression(node)) {
        this.extractCallEdge(node, sourceFile, filePath, edges);
      }

      // New expressions: new Foo()
      if (ts.isNewExpression(node)) {
        this.extractNewCallEdge(node, sourceFile, filePath, edges);
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return { edges, filePath };
  }

  /**
   * Analyze all files in a project for structural edges.
   * Designed for incremental use: pass only changed files + full project file set.
   */
  analyzeProject(
    files: Array<{ filePath: string; content: string }>,
    allProjectFiles: Set<string>,
  ): ProjectStructuralResult {
    const allEdges: StructuralEdge[] = [];
    let filesAnalyzed = 0;

    for (const file of files) {
      const result = this.analyzeFile(file.filePath, file.content, allProjectFiles);
      allEdges.push(...result.edges);
      filesAnalyzed++;
    }

    return { edges: allEdges, filesAnalyzed };
  }

  // --------------------------------------------------------------------------
  // Import extraction
  // --------------------------------------------------------------------------

  private extractImportEdges(
    node: ts.ImportDeclaration,
    sourceFile: ts.SourceFile,
    filePath: string,
    projectFiles: Set<string>,
    edges: StructuralEdge[],
  ): void {
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;

    const specifier = node.moduleSpecifier.text;
    const { line } = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);
    const resolved = this.resolveModulePath(specifier, filePath, projectFiles);
    const isExternal = resolved === null;
    const targetFile = resolved ?? specifier;

    // Default import: import Foo from "./bar"
    if (node.importClause?.name) {
      edges.push(this.createEdge("IMPORTS_FROM", filePath, targetFile, node.importClause.name.text, line + 1, isExternal));
    }

    // Named imports: import { Foo, Bar as Baz } from "./bar"
    if (node.importClause?.namedBindings) {
      if (ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) {
          const importedName = (element.propertyName ?? element.name).text;
          edges.push(this.createEdge("IMPORTS_FROM", filePath, targetFile, importedName, line + 1, isExternal));
        }
      }
      // Namespace import: import * as foo from "./bar"
      if (ts.isNamespaceImport(node.importClause.namedBindings)) {
        edges.push(this.createEdge("IMPORTS_FROM", filePath, targetFile, `* as ${node.importClause.namedBindings.name.text}`, line + 1, isExternal));
      }
    }

    // Side-effect import: import "./styles.css"
    if (!node.importClause) {
      edges.push(this.createEdge("IMPORTS_FROM", filePath, targetFile, "<side-effect>", line + 1, isExternal));
    }
  }

  // --------------------------------------------------------------------------
  // Export extraction
  // --------------------------------------------------------------------------

  private extractExportEdges(
    node: ts.ExportDeclaration,
    sourceFile: ts.SourceFile,
    filePath: string,
    projectFiles: Set<string>,
    edges: StructuralEdge[],
  ): void {
    const { line } = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);

    // Re-export: export { Foo } from "./bar"
    if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const resolved = this.resolveModulePath(specifier, filePath, projectFiles);
      const isExternal = resolved === null;
      const targetFile = resolved ?? specifier;

      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const exportedName = element.name.text;
          edges.push(this.createEdge("EXPORTS", filePath, targetFile, exportedName, line + 1, isExternal));
        }
      } else {
        // export * from "./bar"
        edges.push(this.createEdge("EXPORTS", filePath, targetFile, "*", line + 1, isExternal));
      }
    } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      // Named re-export from self: export { Foo }
      for (const element of node.exportClause.elements) {
        const exportedName = element.name.text;
        edges.push(this.createEdge("EXPORTS", filePath, filePath, exportedName, line + 1, false));
      }
    }
  }

  private isNamedExport(node: ts.Node): boolean {
    // Check if node has an export modifier
    if (!ts.canHaveModifiers(node)) return false;
    const modifiers = ts.getModifiers(node);
    if (!modifiers) return false;
    return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  }

  private extractNamedExportEdge(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    filePath: string,
    edges: StructuralEdge[],
  ): void {
    const { line } = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);
    let name: string | null = null;

    if (ts.isFunctionDeclaration(node) && node.name) {
      name = node.name.text;
    } else if (ts.isClassDeclaration(node) && node.name) {
      name = node.name.text;
    } else if (ts.isInterfaceDeclaration(node)) {
      name = node.name.text;
    } else if (ts.isTypeAliasDeclaration(node)) {
      name = node.name.text;
    } else if (ts.isEnumDeclaration(node)) {
      name = node.name.text;
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          edges.push(this.createEdge("EXPORTS", filePath, filePath, decl.name.text, line + 1, false));
        }
      }
      return;
    }

    if (name) {
      edges.push(this.createEdge("EXPORTS", filePath, filePath, name, line + 1, false));
    }
  }

  // --------------------------------------------------------------------------
  // Call graph extraction
  // --------------------------------------------------------------------------

  private extractCallEdge(
    node: ts.CallExpression,
    sourceFile: ts.SourceFile,
    filePath: string,
    edges: StructuralEdge[],
  ): void {
    const { line } = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);
    const calleeName = this.getCallExpressionName(node);
    if (!calleeName) return;

    edges.push(this.createEdge("CALLS", filePath, filePath, calleeName, line + 1, false));
  }

  private extractNewCallEdge(
    node: ts.NewExpression,
    sourceFile: ts.SourceFile,
    filePath: string,
    edges: StructuralEdge[],
  ): void {
    const { line } = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);

    if (ts.isIdentifier(node.expression)) {
      edges.push(this.createEdge("CALLS", filePath, filePath, `new ${node.expression.text}`, line + 1, false));
    } else if (ts.isPropertyAccessExpression(node.expression)) {
      const name = this.getPropertyAccessName(node.expression);
      if (name) {
        edges.push(this.createEdge("CALLS", filePath, filePath, `new ${name}`, line + 1, false));
      }
    }
  }

  private getCallExpressionName(node: ts.CallExpression): string | null {
    // Simple call: foo()
    if (ts.isIdentifier(node.expression)) {
      return node.expression.text;
    }

    // Method call: foo.bar(), this.baz()
    if (ts.isPropertyAccessExpression(node.expression)) {
      return this.getPropertyAccessName(node.expression);
    }

    return null;
  }

  private getPropertyAccessName(node: ts.PropertyAccessExpression): string | null {
    const parts: string[] = [node.name.text];
    let current: ts.Expression = node.expression;

    // Walk up the chain: a.b.c => ["c", "b", "a"]
    let depth = 0;
    while (ts.isPropertyAccessExpression(current) && depth < 5) {
      parts.push(current.name.text);
      current = current.expression;
      depth++;
    }

    if (ts.isIdentifier(current)) {
      parts.push(current.text);
    } else if (current.kind === ts.SyntaxKind.ThisKeyword) {
      parts.push("this");
    }

    parts.reverse();
    return parts.join(".");
  }

  // --------------------------------------------------------------------------
  // Module resolution helpers
  // --------------------------------------------------------------------------

  /**
   * Resolve a module specifier to a project-relative file path.
   * Returns null if the module is external (node_modules).
   */
  private resolveModulePath(
    specifier: string,
    fromFile: string,
    projectFiles: Set<string>,
  ): string | null {
    // External modules: don't start with . or /
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
      return null;
    }

    const fromDir = path.dirname(fromFile);
    let resolved = path.posix.normalize(path.posix.join(fromDir, specifier));

    // Strip .js extension (TypeScript convention: import from "./foo.js" maps to foo.ts)
    if (resolved.endsWith(".js")) {
      resolved = resolved.slice(0, -3);
    }

    // Try common extensions
    const extensions = [".ts", ".tsx", ".js", ".jsx", ""];
    for (const ext of extensions) {
      const candidate = resolved + ext;
      if (projectFiles.has(candidate)) {
        return candidate;
      }
    }

    // Try index files
    for (const ext of extensions) {
      const candidate = path.posix.join(resolved, `index${ext}`);
      if (projectFiles.has(candidate)) {
        return candidate;
      }
    }

    // Couldn't resolve within project — treat as resolved-but-missing
    return resolved;
  }

  // --------------------------------------------------------------------------
  // Edge creation
  // --------------------------------------------------------------------------

  private createEdge(
    kind: StructuralEdgeKind,
    sourceFile: string,
    targetFile: string,
    symbolName: string,
    line: number,
    isExternal: boolean,
  ): StructuralEdge {
    return {
      edgeId: this.computeEdgeId(sourceFile, kind, targetFile, symbolName),
      kind,
      sourceFile,
      targetFile,
      symbolName,
      line,
      isExternal,
    };
  }

  private computeEdgeId(
    sourceFile: string,
    kind: string,
    targetFile: string,
    symbolName: string,
  ): string {
    const hash = crypto.createHash("sha256");
    hash.update(sourceFile);
    hash.update("\n");
    hash.update(kind);
    hash.update("\n");
    hash.update(targetFile);
    hash.update("\n");
    hash.update(symbolName);
    return hash.digest("hex");
  }

  private getExtension(filePath: string): string {
    const idx = filePath.lastIndexOf(".");
    if (idx === -1) return "";
    return filePath.slice(idx).toLowerCase();
  }
}
