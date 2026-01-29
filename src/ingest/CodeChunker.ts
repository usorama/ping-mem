export type ChunkType = "code" | "comment" | "docstring";

export interface TextChunk {
  type: ChunkType;
  start: number;
  end: number;
  content: string;
}

export class CodeChunker {
  chunkFile(filePath: string, content: string): TextChunk[] {
    const ext = this.getExtension(filePath);
    if (ext === ".py") {
      return this.chunkPython(content);
    }
    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
      return this.chunkTypeScript(content);
    }
    return [{ type: "code", start: 0, end: content.length, content }];
  }

  private chunkTypeScript(content: string): TextChunk[] {
    const chunks: TextChunk[] = [];
    let i = 0;
    while (i < content.length) {
      const commentStart = this.findNextCommentStart(content, i);
      if (commentStart === -1) {
        chunks.push({
          type: "code",
          start: i,
          end: content.length,
          content: content.slice(i),
        });
        break;
      }
      if (commentStart > i) {
        chunks.push({
          type: "code",
          start: i,
          end: commentStart,
          content: content.slice(i, commentStart),
        });
      }
      if (commentStart > i) {
        chunks.push({
          type: "code",
          start: i,
          end: commentStart,
          content: content.slice(i, commentStart),
        });
      }
      const { end, isBlock } = this.consumeComment(content, commentStart);
      chunks.push({
        type: isBlock ? "comment" : "comment",
        start: commentStart,
        end,
        content: content.slice(commentStart, end),
      });
      i = end;
    }
    return this.mergeAdjacent(chunks);
  }

  private chunkPython(content: string): TextChunk[] {
    const chunks: TextChunk[] = [];
    let i = 0;
    while (i < content.length) {
      const next = this.findNextPythonCommentOrDocstring(content, i);
      if (!next) {
        chunks.push({ type: "code", start: i, end: content.length, content: content.slice(i) });
        break;
      }
      if (next.start > i) {
        chunks.push({ type: "code", start: i, end: next.start, content: content.slice(i, next.start) });
      }
      chunks.push({
        type: next.type,
        start: next.start,
        end: next.end,
        content: content.slice(next.start, next.end),
      });
      i = next.end;
    }
    return this.mergeAdjacent(chunks);
  }

  private findNextCommentStart(content: string, start: number): number {
    let i = start;
    while (i < content.length - 1) {
      const ch = content[i];
      const next = content[i + 1];
      if (ch === "/" && next === "/") {
        return i;
      }
      if (ch === "/" && next === "*") {
        return i;
      }
      i++;
    }
    return -1;
  }

  private consumeComment(content: string, start: number): { end: number; isBlock: boolean } {
    if (content[start] === "/" && content[start + 1] === "/") {
      const end = content.indexOf("\n", start);
      return { end: end === -1 ? content.length : end, isBlock: false };
    }
    if (content[start] === "/" && content[start + 1] === "*") {
      const end = content.indexOf("*/", start + 2);
      return { end: end === -1 ? content.length : end + 2, isBlock: true };
    }
    return { end: start + 1, isBlock: false };
  }

  private findNextPythonCommentOrDocstring(
    content: string,
    start: number
  ): { start: number; end: number; type: ChunkType } | null {
    const commentIdx = content.indexOf("#", start);
    const tripleQuoteIdx = this.findNextTripleQuote(content, start);
    let nextIdx = -1;
    let type: ChunkType = "comment";
    if (commentIdx !== -1 && (tripleQuoteIdx === -1 || commentIdx < tripleQuoteIdx)) {
      nextIdx = commentIdx;
      type = "comment";
    } else if (tripleQuoteIdx !== -1) {
      nextIdx = tripleQuoteIdx;
      type = "docstring";
    }
    if (nextIdx === -1) {
      return null;
    }
    if (type === "comment") {
      const end = content.indexOf("\n", nextIdx);
      return { start: nextIdx, end: end === -1 ? content.length : end, type };
    }
    const quote = content.startsWith("'''", nextIdx) ? "'''" : "\"\"\"";
    const endQuote = content.indexOf(quote, nextIdx + 3);
    const end = endQuote === -1 ? content.length : endQuote + 3;
    return { start: nextIdx, end, type };
  }

  private findNextTripleQuote(content: string, start: number): number {
    const idxSingle = content.indexOf("'''", start);
    const idxDouble = content.indexOf("\"\"\"", start);
    if (idxSingle === -1) return idxDouble;
    if (idxDouble === -1) return idxSingle;
    return Math.min(idxSingle, idxDouble);
  }

  private mergeAdjacent(chunks: TextChunk[]): TextChunk[] {
    if (chunks.length === 0) return chunks;
    const merged: TextChunk[] = [];
    let current = chunks[0]!;
    for (let i = 1; i < chunks.length; i++) {
      const next = chunks[i]!;
      if (current.type === next.type && current.end === next.start) {
        current = {
          type: current.type,
          start: current.start,
          end: next.end,
          content: current.content + next.content,
        };
      } else {
        merged.push(current);
        current = next;
      }
    }
    merged.push(current);
    return merged;
  }

  private getExtension(filePath: string): string {
    const idx = filePath.lastIndexOf(".");
    if (idx === -1) return "";
    return filePath.slice(idx).toLowerCase();
  }
}
