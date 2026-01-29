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
import { GitHistoryReader, GitHistoryResult } from "./GitHistoryReader.js";
import type { ProjectManifest, FileHashEntry } from "./types.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface CodeFileResult {
  filePath: string; // Relative to project root
  sha256: string; // File content hash
  chunks: ChunkWithId[];
}

export interface ChunkWithId {
  chunkId: string; // Deterministic: hash(filePath + chunkType + startOffset + content)
  type: "code" | "comment" | "docstring";
  start: number;
  end: number;
  lineStart: number;
  lineEnd: number;
  content: string;
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
}

export class IngestionOrchestrator {
  private readonly scanner: ProjectScanner;
  private readonly manifestStore: ManifestStore;
  private readonly chunker: CodeChunker;
  private readonly gitReader: GitHistoryReader;

  constructor() {
    this.scanner = new ProjectScanner();
    this.manifestStore = new ManifestStore();
    this.chunker = new CodeChunker();
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

    const scanResult = this.scanner.scanProject(projectPath, previousManifest ?? undefined);

    // If no changes and not forcing, return null
    if (!scanResult.hasChanges && !options.forceReingest) {
      return null;
    }

    // Step 2: Chunk code files
    const codeFiles = this.chunkCodeFiles(projectPath, scanResult.manifest.files);

    // Step 3: Read git history
    const gitHistory = this.gitReader.readHistory(projectPath);

    // Step 4: Save manifest
    this.manifestStore.save(projectPath, scanResult.manifest);

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
  verify(projectDir: string): boolean {
    const projectPath = path.resolve(projectDir);
    const storedManifest = this.manifestStore.load(projectPath);
    if (!storedManifest) {
      return false;
    }

    const currentScan = this.scanner.scanProject(projectPath, storedManifest);
    return currentScan.manifest.treeHash === storedManifest.treeHash;
  }

  private chunkCodeFiles(
    projectRoot: string,
    fileEntries: FileHashEntry[]
  ): CodeFileResult[] {
    const results: CodeFileResult[] = [];

    for (const entry of fileEntries) {
      const fullPath = path.join(projectRoot, entry.path);
      const content = fs.readFileSync(fullPath, "utf-8");
      const rawChunks = this.chunker.chunkFile(entry.path, content);
      const chunksWithIds = rawChunks.map((chunk) =>
        this.buildChunkWithMetadata(entry.path, entry.sha256, content, chunk)
      );

      results.push({
        filePath: entry.path,
        sha256: entry.sha256,
        chunks: chunksWithIds,
      });
    }

    return results;
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
