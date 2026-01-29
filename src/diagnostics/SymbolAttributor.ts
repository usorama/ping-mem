/**
 * SymbolAttributor: Attribute diagnostic findings to symbols
 * 
 * Maps findings to their containing symbols based on line ranges.
 */

import type { ExtractedSymbol } from "../ingest/SymbolExtractor.js";

export interface SymbolAttribution {
  symbolId: string;
  symbolName: string;
  symbolKind: string;
}

export class SymbolAttributor {
  private symbolsByFile: Map<string, ExtractedSymbol[]> = new Map();

  /**
   * Register symbols for a file
   */
  addSymbols(filePath: string, symbols: ExtractedSymbol[]): void {
    this.symbolsByFile.set(filePath, symbols);
  }

  /**
   * Find the symbol containing a specific line in a file
   */
  findSymbolForLocation(
    filePath: string,
    line: number
  ): SymbolAttribution | null {
    const symbols = this.symbolsByFile.get(filePath);
    if (!symbols) {
      return null;
    }

    // Find the most specific symbol (smallest range) containing this line
    let bestMatch: ExtractedSymbol | null = null;
    let bestRange = Infinity;

    for (const symbol of symbols) {
      if (line >= symbol.startLine && line <= symbol.endLine) {
        const range = symbol.endLine - symbol.startLine;
        if (range < bestRange) {
          bestMatch = symbol;
          bestRange = range;
        }
      }
    }

    if (!bestMatch) {
      return null;
    }

    return {
      symbolId: bestMatch.symbolId,
      symbolName: bestMatch.name,
      symbolKind: bestMatch.kind,
    };
  }

  /**
   * Clear all registered symbols
   */
  clear(): void {
    this.symbolsByFile.clear();
  }
}
