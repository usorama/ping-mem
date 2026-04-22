import * as crypto from "crypto";
import type { CodeFileResult, IngestionResult } from "./IngestionOrchestrator.js";

export function createProjectScopedId(projectId: string, localId: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(projectId);
  hash.update("\n");
  hash.update(localId);
  return hash.digest("hex");
}

export function normalizeIngestionIdentity(result: IngestionResult): IngestionResult {
  const codeFiles = result.codeFiles.map((fileResult) =>
    normalizeCodeFileIdentity(result.projectId, fileResult),
  );

  return {
    ...result,
    codeFiles,
  };
}

function normalizeCodeFileIdentity(
  projectId: string,
  fileResult: CodeFileResult,
): CodeFileResult {
  const chunkIdMap = new Map<string, string>();
  for (const chunk of fileResult.chunks) {
    chunkIdMap.set(chunk.chunkId, createProjectScopedId(projectId, chunk.chunkId));
  }

  return {
    ...fileResult,
    chunks: fileResult.chunks.map((chunk) => ({
      ...chunk,
      chunkId: chunkIdMap.get(chunk.chunkId)!,
      ...(chunk.parentChunkId !== undefined
        ? {
            parentChunkId:
              chunkIdMap.get(chunk.parentChunkId) ??
              createProjectScopedId(projectId, chunk.parentChunkId),
          }
        : {}),
    })),
    symbols: fileResult.symbols.map((symbol) => ({
      ...symbol,
      symbolId: createProjectScopedId(projectId, symbol.symbolId),
    })),
  };
}
