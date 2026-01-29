/**
 * Ingestion layer exports
 */

export { ProjectScanner } from "./ProjectScanner.js";
export { ManifestStore } from "./ManifestStore.js";
export { CodeChunker } from "./CodeChunker.js";
export { GitHistoryReader } from "./GitHistoryReader.js";
export { IngestionOrchestrator } from "./IngestionOrchestrator.js";

export type {
  FileHashEntry,
  ProjectManifest,
  ProjectScanResult,
} from "./types.js";

export type {
  GitCommit,
  GitDiffHunk,
  GitFileChange,
  GitHistoryResult,
} from "./GitHistoryReader.js";

export type {
  CodeFileResult,
  ChunkWithId,
  IngestionResult,
  IngestionOptions,
} from "./IngestionOrchestrator.js";

export type { ChunkType, TextChunk } from "./CodeChunker.js";
