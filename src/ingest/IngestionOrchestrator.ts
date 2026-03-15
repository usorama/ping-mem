/**
 * IngestionOrchestrator: Deterministic, reproducible ingestion pipeline
 *
 * Coordinates:
 * 1. Project scan + Merkle tree hashing
 * 2. Code chunking (code vs comments/docstrings)
 * 3. Git history ingestion (commits + diffs + hunks)
 * 4. Manifest storage + versioning
 *
 * Guarantees: Same repo state → same IDs, same chunks, same graph.
 */

import { ProjectScanner, ProjectScanOptions } from "./ProjectScanner.js";
import { ManifestStore } from "./ManifestStore.js";
import { CodeChunker, TextChunk } from "./CodeChunker.js";
import { SemanticChunker, type SemanticChunk } from "./SemanticChunker.js";
import { GitHistoryReader, GitHistoryResult } from "./GitHistoryReader.js";
import { SymbolExtractor, ExtractedSymbol } from "./SymbolExtractor.js";
import type { ProjectManifest, FileHashEntry } from "./types.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { createLogger } from "../util/logger.js";

const log = createLogger("IngestionOrchestrator");

export interface CodeFileResult {
  filePath: string; // Relative to project root
  sha256: string; // File content hash
  chunks: ChunkWithId[];
  symbols: ExtractedSymbol[];
}

export interface ChunkWithId {
  chunkId: string; // Deterministic: hash(filePath + chunkType + startOffset + content)
  type: "code" | "comment" | "docstring" | "function" | "class" | "file" | "block";
  start: number;
  end: number;
  lineStart: number;
  lineEnd: number;
  content: string;
  /** Parent chunk ID for hierarchical chunks (e.g., method -> class) */
  parentChunkId?: string;
  /** Number of overlap lines with adjacent chunks */
  overlapLines?: number;
  /** Symbol/file name for semantic chunks */
  chunkName?: string;
}

export interface IngestionResult {
  projectId: string;
  projectManifest: ProjectManifest;
  codeFiles: CodeFileResult[];
  gitHistory: GitHistoryResult;
  ingestedAt: string; // ISO 8601
}

export interface IngestionOptions {
  scanOptions?: ProjectScanOptions;
  forceReingest?: boolean; // Ignore cached manifest
  maxCommits?: number; // Max git commits to ingest (default 200)
  maxCommitAgeDays?: number; // Only include commits from last N days
  skipManifestSave?: boolean; // Defer manifest save to caller (Phase 2 manifest fix)
}

export class IngestionOrchestrator {
  private readonly scanner: ProjectScanner;
  private readonly manifestStore: ManifestStore;
  private readonly chunker: CodeChunker;
  private readonly semanticChunker: SemanticChunker;
  private readonly gitReader: GitHistoryReader;
  private readonly symbolExtractor: SymbolExtractor;

  constructor() {
    this.scanner = new ProjectScanner();
    this.manifestStore = new ManifestStore();
    this.chunker = new CodeChunker();
    this.symbolExtractor = new SymbolExtractor();
    this.semanticChunker = new SemanticChunker(this.symbolExtractor);
    this.gitReader = new GitHistoryReader();
  }

  /**
   * Ingest a project directory.
   * Returns null if no changes detected (unless forceReingest=true).
   */
  async ingest(
    projectDir: string,
    options: IngestionOptions = {}
  ): Promise<IngestionResult | null> {
    const projectPath = path.resolve(projectDir);

    // Step 1: Scan project + compute Merkle tree
    const previousManifest = options.forceReingest
      ? null
      : this.manifestStore.load(projectPath);

    const scanResult = await this.scanner.scanProject(projectPath, previousManifest ?? undefined);

    // If no changes and not forcing, return null
    if (!scanResult.hasChanges && !options.forceReingest) {
      return null;
    }

    // Step 2: Chunk code files
    const codeFiles = this.chunkCodeFiles(projectPath, scanResult.manifest.files);

    // Step 3: Read git history
    const gitHistoryOptions: { maxCommits?: number; maxCommitAgeDays?: number } = {};
    if (options.maxCommits !== undefined) {
      gitHistoryOptions.maxCommits = options.maxCommits;
    }
    if (options.maxCommitAgeDays !== undefined) {
      gitHistoryOptions.maxCommitAgeDays = options.maxCommitAgeDays;
    }
    const gitHistory = await this.gitReader.readHistory(
      projectPath,
      Object.keys(gitHistoryOptions).length > 0 ? gitHistoryOptions : undefined
    );

    // Step 4: Save manifest (unless caller defers it)
    if (!options.skipManifestSave) {
      this.manifestStore.save(projectPath, scanResult.manifest);
    }

    return {
      projectId: scanResult.manifest.projectId,
      projectManifest: scanResult.manifest,
      codeFiles,
      gitHistory,
      ingestedAt: new Date().toISOString(),
    };
  }

  /**
   * Verify that the ingested manifest matches the current project state.
   * Returns true if manifest is up-to-date and matches on-disk files.
   */
  async verify(projectDir: string): Promise<boolean> {
    const projectPath = path.resolve(projectDir);
    const storedManifest = this.manifestStore.load(projectPath);
    if (!storedManifest) {
      return false;
    }

    const currentScan = await this.scanner.scanProject(projectPath, storedManifest);
    return (
      currentScan.manifest.treeHash === storedManifest.treeHash &&
      currentScan.manifest.projectId === storedManifest.projectId
    );
  }

  /**
   * Scan the project and return the current manifest without persisting.
   * Used by IngestionService.verifyProject to expose the actual current tree hash.
   */
  async scan(projectDir: string): Promise<import("./types.js").ProjectScanResult> {
    const projectPath = path.resolve(projectDir);
    const storedManifest = this.manifestStore.load(projectPath);
    return this.scanner.scanProject(projectPath, storedManifest ?? undefined);
  }

  /**
   * Explicitly save a manifest. Used when skipManifestSave=true to defer
   * manifest persistence until after Neo4j + Qdrant succeed (Phase 2).
   */
  saveManifest(projectDir: string, manifest: ProjectManifest): void {
    const projectPath = path.resolve(projectDir);
    this.manifestStore.save(projectPath, manifest);
  }

  /**
   * Load the stored manifest for a project directory.
   * Returns null if no manifest exists.
   */
  getManifest(projectDir: string): import("./types.js").ProjectManifest | null {
    const projectPath = path.resolve(projectDir);
    return this.manifestStore.load(projectPath);
  }

  private chunkCodeFiles(
    projectRoot: string,
    fileEntries: FileHashEntry[]
  ): CodeFileResult[] {
    const results: CodeFileResult[] = [];

    for (const entry of fileEntries) {
      try {
        const fullPath = path.join(projectRoot, entry.path);
        const content = fs.readFileSync(fullPath, "utf-8");

        // Extract symbols from the file
        const symbols = this.symbolExtractor.extractFromFile(entry.path, content);

        // Use semantic chunking — produces hierarchical function/class/file chunks
        const semanticChunks = this.semanticChunker.chunkFile(entry.path, content);
        const chunksWithIds = semanticChunks.map((sc) =>
          this.semanticChunkToChunkWithId(sc, content)
        );

        results.push({
          filePath: entry.path,
          sha256: entry.sha256,
          chunks: chunksWithIds,
          symbols,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn("Failed to chunk file, skipping", { file: entry.path, error: message });
      }
    }

    return results;
  }

  /**
   * Convert a SemanticChunk to ChunkWithId for pipeline compatibility.
   */
  private semanticChunkToChunkWithId(
    sc: SemanticChunk,
    fileContent: string,
  ): ChunkWithId {
    const lines = fileContent.split("\n");
    // Compute byte offsets from line numbers
    const start = this.offsetForLine(lines, sc.startLine);
    const end = this.offsetForLine(lines, sc.endLine + 1);

    const chunk: ChunkWithId = {
      chunkId: sc.chunkId,
      type: sc.chunkType,
      start,
      end: Math.min(end, fileContent.length),
      lineStart: sc.startLine,
      lineEnd: sc.endLine,
      content: sc.content,
      overlapLines: sc.overlapLines,
      chunkName: sc.name,
    };

    if (sc.parentChunkId !== undefined) {
      chunk.parentChunkId = sc.parentChunkId;
    }

    return chunk;
  }

  /**
   * Compute byte offset for a 1-based line number.
   */
  private offsetForLine(lines: string[], lineNumber: number): number {
    let offset = 0;
    for (let i = 0; i < Math.min(lineNumber - 1, lines.length); i++) {
      offset += (lines[i]?.length ?? 0) + 1; // +1 for newline
    }
    return offset;
  }

  private buildChunkWithMetadata(
    filePath: string,
    fileSha256: string,
    fileContent: string,
    chunk: TextChunk
  ): ChunkWithId {
    const hash = crypto.createHash("sha256");
    hash.update(filePath);
    hash.update("\n");
    hash.update(fileSha256);
    hash.update("\n");
    hash.update(chunk.type);
    hash.update("\n");
    hash.update(String(chunk.start));
    hash.update("\n");
    hash.update(String(chunk.end));
    hash.update("\n");
    hash.update(chunk.content);

    return {
      chunkId: hash.digest("hex"),
      type: chunk.type,
      start: chunk.start,
      end: chunk.end,
      lineStart: this.lineNumberForOffset(fileContent, chunk.start),
      lineEnd: this.lineNumberForOffset(
        fileContent,
        Math.max(chunk.end - 1, chunk.start)
      ),
      content: chunk.content,
    };
  }

  private lineNumberForOffset(content: string, offset: number): number {
    const clamped = Math.max(0, Math.min(offset, content.length));
    let line = 1;
    for (let i = 0; i < clamped; i++) {
      if (content[i] === "\n") {
        line += 1;
      }
    }
    return line;
  }
}
