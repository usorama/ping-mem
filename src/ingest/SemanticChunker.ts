/**
 * SemanticChunker: 3-level hierarchical code chunking
 *
 * Produces semantic chunks at three granularity levels:
 *   Level 1: Function/method bodies (most specific)
 *   Level 2: Class bodies (medium specificity, classes > 10 lines)
 *   Level 3: File-level (broadest context)
 *
 * Each adjacent chunk pair gets 2-line overlap for context continuity.
 * Uses SymbolExtractor to find function/class boundaries via TypeScript Compiler API.
 *
 * Deterministic: same source -> same chunks -> same IDs.
 */

import * as crypto from "crypto";
import ts from "typescript";
import { SymbolExtractor, type ExtractedSymbol } from "./SymbolExtractor.js";

export interface SemanticChunk {
  chunkId: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  chunkType: "function" | "class" | "file" | "block";
  name: string;
  parentChunkId?: string;
  overlapLines: number;
}

/** Maximum chunk size in characters (~8K tokens for Gemini embedding context) */
const MAX_CHUNK_CHARS = 32_000;

/** Minimum class size to get its own chunk (lines) */
const MIN_CLASS_LINES = 10;

/** Overlap lines between adjacent chunks */
const OVERLAP_LINES = 2;

export class SemanticChunker {
  private readonly symbolExtractor: SymbolExtractor;

  constructor(symbolExtractor?: SymbolExtractor) {
    this.symbolExtractor = symbolExtractor ?? new SymbolExtractor();
  }

  /**
   * Chunk a file into semantic units.
   * For supported languages (TS/JS/Python), produces hierarchical chunks.
   * For unsupported languages, falls back to a single file-level chunk.
   */
  chunkFile(filePath: string, content: string): SemanticChunk[] {
    if (content.length === 0) {
      return [];
    }

    const lines = content.split("\n");
    const symbols = this.symbolExtractor.extractFromFile(filePath, content);

    const chunks: SemanticChunk[] = [];

    const routeChunks = this.createRouteChunks(filePath, content, lines);
    chunks.push(...routeChunks);

    if (symbols.length === 0) {
      chunks.push(...this.createFileLevelChunks(filePath, content, lines));
      return chunks;
    }

    // Level 2: Class-level chunks (need these first for parentChunkId)
    const classChunks = this.createClassChunks(filePath, lines, symbols);
    chunks.push(...classChunks);

    // Build class lookup for parent assignment
    const classLookup = new Map<string, SemanticChunk>();
    for (const cc of classChunks) {
      classLookup.set(cc.name, cc);
    }

    // Level 1: Function/method-level chunks
    const functionChunks = this.createFunctionChunks(
      filePath,
      lines,
      symbols,
      classLookup,
    );
    chunks.push(...functionChunks);

    // Level 3: File-level chunks
    const fileChunks = this.createFileLevelChunks(filePath, content, lines);
    chunks.push(...fileChunks);

    return chunks;
  }

  private createRouteChunks(
    filePath: string,
    content: string,
    lines: string[],
  ): SemanticChunk[] {
    if (!/\.(ts|tsx|js|jsx)$/.test(filePath)) {
      return [];
    }

    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
    );

    const routeChunks: SemanticChunk[] = [];
    const seen = new Set<string>();

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const route = this.extractRouteCall(sourceFile, node, filePath, lines);
        if (route && !seen.has(route.chunkId)) {
          seen.add(route.chunkId);
          routeChunks.push(route);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return routeChunks;
  }

  private extractRouteCall(
    sourceFile: ts.SourceFile,
    node: ts.CallExpression,
    filePath: string,
    lines: string[],
  ): SemanticChunk | null {
    if (!ts.isPropertyAccessExpression(node.expression)) {
      return null;
    }

    const methodName = node.expression.name.text;
    if (!["get", "post", "put", "delete", "patch", "head", "options"].includes(methodName)) {
      return null;
    }

    const calleeText = node.expression.expression.getText(sourceFile);
    if (calleeText !== "this.app" && calleeText !== "app") {
      return null;
    }

    const routeArg = node.arguments[0];
    const handlerArg = node.arguments[1];
    const routePath = this.readRouteLiteral(routeArg);
    if (!routePath || !handlerArg || (!ts.isArrowFunction(handlerArg) && !ts.isFunctionExpression(handlerArg))) {
      return null;
    }

    const { line: startLineRaw } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
    const { line: endLineRaw } = ts.getLineAndCharacterOfPosition(sourceFile, node.end);
    const startLine = startLineRaw + 1;
    const endLine = endLineRaw + 1;
    const chunkContent = lines.slice(startLine - 1, endLine).join("\n");
    const chunkId = this.computeChunkId(filePath, "block", startLine, endLine, chunkContent);

    return {
      chunkId,
      filePath,
      content: chunkContent,
      startLine,
      endLine,
      chunkType: "block",
      name: `${methodName.toUpperCase()} ${routePath}`,
      overlapLines: 0,
    };
  }

  private readRouteLiteral(node: ts.Expression | undefined): string | null {
    if (!node) {
      return null;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text.startsWith("/") ? node.text : null;
    }
    return null;
  }

  private createFunctionChunks(
    filePath: string,
    lines: string[],
    symbols: ExtractedSymbol[],
    classLookup: Map<string, SemanticChunk>,
  ): SemanticChunk[] {
    const chunks: SemanticChunk[] = [];

    const functionSymbols = symbols.filter(
      (s) => s.kind === "function" || s.kind === "method",
    );

    for (const sym of functionSymbols) {
      // Apply 2-line overlap before and after
      const startLine = Math.max(1, sym.startLine - OVERLAP_LINES);
      const endLine = Math.min(lines.length, sym.endLine + OVERLAP_LINES);
      const overlapBefore = sym.startLine - startLine;
      const overlapAfter = endLine - sym.endLine;
      const overlapLines = overlapBefore + overlapAfter;

      const content = lines.slice(startLine - 1, endLine).join("\n");

      // Find parent class
      let parentChunkId: string | undefined;
      if (sym.kind === "method") {
        // Find the class that contains this method
        for (const [className, classChunk] of classLookup) {
          if (
            sym.startLine >= classChunk.startLine &&
            sym.endLine <= classChunk.endLine
          ) {
            parentChunkId = classChunk.chunkId;
            break;
          }
        }
      }

      const chunkId = this.computeChunkId(
        filePath,
        "function",
        startLine,
        endLine,
        content,
      );

      const chunk: SemanticChunk = {
        chunkId,
        filePath,
        content,
        startLine,
        endLine,
        chunkType: "function",
        name: sym.name,
        overlapLines,
      };

      if (parentChunkId !== undefined) {
        chunk.parentChunkId = parentChunkId;
      }

      chunks.push(chunk);
    }

    return chunks;
  }

  private createClassChunks(
    filePath: string,
    lines: string[],
    symbols: ExtractedSymbol[],
  ): SemanticChunk[] {
    const chunks: SemanticChunk[] = [];

    const classSymbols = symbols.filter((s) => s.kind === "class");

    for (const sym of classSymbols) {
      const classLines = sym.endLine - sym.startLine + 1;
      if (classLines < MIN_CLASS_LINES) {
        continue;
      }

      // Apply 2-line overlap
      const startLine = Math.max(1, sym.startLine - OVERLAP_LINES);
      const endLine = Math.min(lines.length, sym.endLine + OVERLAP_LINES);
      const overlapBefore = sym.startLine - startLine;
      const overlapAfter = endLine - sym.endLine;
      const overlapLines = overlapBefore + overlapAfter;

      const content = lines.slice(startLine - 1, endLine).join("\n");

      const chunkId = this.computeChunkId(
        filePath,
        "class",
        startLine,
        endLine,
        content,
      );

      chunks.push({
        chunkId,
        filePath,
        content,
        startLine,
        endLine,
        chunkType: "class",
        name: sym.name,
        overlapLines,
      });
    }

    return chunks;
  }

  private createFileLevelChunks(
    filePath: string,
    content: string,
    lines: string[],
  ): SemanticChunk[] {
    // Include file path in content for BM25 path matching
    const prefixedContent = `// File: ${filePath}\n${content}`;

    if (prefixedContent.length <= MAX_CHUNK_CHARS) {
      const chunkId = this.computeChunkId(
        filePath,
        "file",
        1,
        lines.length,
        prefixedContent,
      );

      return [
        {
          chunkId,
          filePath,
          content: prefixedContent,
          startLine: 1,
          endLine: lines.length,
          chunkType: "file",
          name: filePath,
          overlapLines: 0,
        },
      ];
    }

    // File exceeds max chunk size — split at boundaries
    return this.splitLargeFile(filePath, lines);
  }

  /**
   * Split a large file into chunks at function/class boundaries.
   * Each chunk is at most MAX_CHUNK_CHARS with 2-line overlap.
   */
  private splitLargeFile(
    filePath: string,
    lines: string[],
  ): SemanticChunk[] {
    const chunks: SemanticChunk[] = [];
    let currentStart = 1;
    let partIndex = 0;

    while (currentStart <= lines.length) {
      // Find how many lines fit in MAX_CHUNK_CHARS
      let currentEnd = currentStart;
      let accumulated = "";

      while (currentEnd <= lines.length) {
        const nextLine = lines[currentEnd - 1] ?? "";
        const candidate = accumulated + (accumulated ? "\n" : "") + nextLine;
        if (candidate.length > MAX_CHUNK_CHARS && currentEnd > currentStart) {
          break;
        }
        accumulated = candidate;
        currentEnd++;
      }
      currentEnd--; // Back to last line that fit

      // Apply overlap (only at end, since start already has overlap from previous chunk)
      const overlapEnd = Math.min(lines.length, currentEnd + OVERLAP_LINES);
      const overlapLines = partIndex > 0 ? OVERLAP_LINES : 0;

      // Rebuild content with overlap
      const startWithOverlap = partIndex > 0
        ? Math.max(1, currentStart - OVERLAP_LINES)
        : currentStart;
      const chunkContent = lines
        .slice(startWithOverlap - 1, overlapEnd)
        .join("\n");

      const prefixed = `// File: ${filePath} (part ${partIndex + 1})\n${chunkContent}`;

      const chunkId = this.computeChunkId(
        filePath,
        "file",
        startWithOverlap,
        overlapEnd,
        prefixed,
      );

      chunks.push({
        chunkId,
        filePath,
        content: prefixed,
        startLine: startWithOverlap,
        endLine: overlapEnd,
        chunkType: "file",
        name: `${filePath}:part${partIndex + 1}`,
        overlapLines,
      });

      currentStart = currentEnd + 1;
      partIndex++;
    }

    return chunks;
  }

  /**
   * Deterministic chunk ID: hash(filePath + chunkType + startLine + endLine + content)
   */
  private computeChunkId(
    filePath: string,
    chunkType: string,
    startLine: number,
    endLine: number,
    content: string,
  ): string {
    const hash = crypto.createHash("sha256");
    hash.update(filePath);
    hash.update("\n");
    hash.update(chunkType);
    hash.update("\n");
    hash.update(String(startLine));
    hash.update("\n");
    hash.update(String(endLine));
    hash.update("\n");
    hash.update(content);
    return hash.digest("hex");
  }
}
