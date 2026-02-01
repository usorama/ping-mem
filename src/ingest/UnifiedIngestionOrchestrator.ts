/**
 * UnifiedIngestionOrchestrator: Handles both code and document ingestion
 *
 * Supports two project types:
 * 1. Code projects: Uses CodeChunker + GitHistory
 * 2. Document projects: Uses DocumentParser for structured entities
 *
 * Both produce deterministic, content-addressed entities stored in Neo4j + Qdrant.
 */

import { ProjectScanner } from "./ProjectScanner.js";
import { ManifestStore } from "./ManifestStore.js";
import { CodeChunker } from "./CodeChunker.js";
import { GitHistoryReader } from "./GitHistoryReader.js";
import { DocumentParser, type DocumentEntity } from "./DocumentParser.js";
import type { ProjectManifest } from "./types.js";
import * as path from "path";

export type ProjectType = "code" | "documents" | "mixed";

export interface UnifiedIngestionOptions {
  projectType?: ProjectType; // Auto-detect if not specified
  forceReingest?: boolean; // Force re-ingestion even if no changes detected
  includeGitHistory?: boolean; // Default: true for code, false for documents
  includeCodeFiles?: string[]; // Extensions for code (default: .ts, .js, .py)
  includeDocFiles?: string[]; // Extensions for documents (default: .md, .json, .yaml, .txt)
}

export interface UnifiedIngestionResult {
  projectId: string;
  projectType: ProjectType;
  projectManifest: ProjectManifest;
  codeFiles?: Array<{
    filePath: string;
    sha256: string;
    chunks: Array<{
      chunkId: string;
      type: "code" | "comment" | "docstring";
      start: number;
      end: number;
      content: string;
    }>;
  }>;
  documentFiles?: Array<{
    filePath: string;
    sha256: string;
    documentType: string;
    entities: DocumentEntity[];
    metadata: Record<string, unknown>;
  }>;
  gitHistory?: {
    commits: Array<{
      hash: string;
      message: string;
      authorDate: string;
    }>;
  };
  ingestedAt: string;
}

export class UnifiedIngestionOrchestrator {
  private readonly scanner: ProjectScanner;
  private readonly manifestStore: ManifestStore;
  private readonly codeChunker: CodeChunker;
  private readonly gitReader: GitHistoryReader;
  private readonly docParser: DocumentParser;

  constructor() {
    this.scanner = new ProjectScanner();
    this.manifestStore = new ManifestStore();
    this.codeChunker = new CodeChunker();
    this.gitReader = new GitHistoryReader();
    this.docParser = new DocumentParser();
  }

  /**
   * Ingest a project (code or documents).
   */
  async ingest(
    projectDir: string,
    options: UnifiedIngestionOptions = {}
  ): Promise<UnifiedIngestionResult | null> {
    const projectPath = path.resolve(projectDir);

    // Step 1: Scan project
    const previousManifest = this.manifestStore.load(projectPath);
    const scanResult = this.scanner.scanProject(projectPath, previousManifest ?? undefined);

    if (!scanResult.hasChanges && !options.forceReingest) {
      return null; // No changes
    }

    // Step 2: Detect project type
    const projectType = options.projectType ?? this.detectProjectType(scanResult.manifest);

    // Step 3: Process files based on type
    let codeFiles: UnifiedIngestionResult["codeFiles"];
    let documentFiles: UnifiedIngestionResult["documentFiles"];
    let gitHistory: UnifiedIngestionResult["gitHistory"];

    if (projectType === "code" || projectType === "mixed") {
      const codeExtensions = new Set(options.includeCodeFiles ?? [".ts", ".tsx", ".js", ".jsx", ".py"]);
      const codeEntries = scanResult.manifest.files.filter((f) =>
        codeExtensions.has(path.extname(f.path))
      );

      codeFiles = this.processCodeFiles(projectPath, codeEntries);

      if (options.includeGitHistory !== false) {
        const gitHistoryResult = await this.gitReader.readHistory(projectPath);
        gitHistory = {
          commits: gitHistoryResult.commits.map((c) => ({
            hash: c.hash,
            message: c.message,
            authorDate: c.authorDate,
          })),
        };
      }
    }

    if (projectType === "documents" || projectType === "mixed") {
      const docExtensions = new Set(options.includeDocFiles ?? [".md", ".json", ".yaml", ".yml", ".txt"]);
      const docEntries = scanResult.manifest.files.filter((f) =>
        docExtensions.has(path.extname(f.path))
      );

      documentFiles = this.processDocumentFiles(projectPath, docEntries);
    }

    // Step 4: Save manifest
    this.manifestStore.save(projectPath, scanResult.manifest);

    const result: UnifiedIngestionResult = {
      projectId: scanResult.manifest.projectId,
      projectType,
      projectManifest: scanResult.manifest,
      ingestedAt: new Date().toISOString(),
    };

    if (codeFiles !== undefined) {
      result.codeFiles = codeFiles;
    }
    if (documentFiles !== undefined) {
      result.documentFiles = documentFiles;
    }
    if (gitHistory !== undefined) {
      result.gitHistory = gitHistory;
    }

    return result;
  }

  /**
   * Detect project type from file extensions.
   */
  private detectProjectType(manifest: ProjectManifest): ProjectType {
    const codeExts = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".rs"]);
    const docExts = new Set([".md", ".json", ".yaml", ".yml", ".txt"]);

    let hasCode = false;
    let hasDocs = false;

    for (const file of manifest.files) {
      const ext = path.extname(file.path);
      if (codeExts.has(ext)) hasCode = true;
      if (docExts.has(ext)) hasDocs = true;
    }

    if (hasCode && hasDocs) return "mixed";
    if (hasCode) return "code";
    return "documents";
  }

  /**
   * Process code files.
   */
  private processCodeFiles(
    projectRoot: string,
    fileEntries: Array<{ path: string; sha256: string }>
  ) {
    const results = [];

    for (const entry of fileEntries) {
      const fullPath = path.join(projectRoot, entry.path);
      const content = require("fs").readFileSync(fullPath, "utf-8");
      const rawChunks = this.codeChunker.chunkFile(entry.path, content);

      const chunks = rawChunks.map((chunk) => {
        const hash = require("crypto").createHash("sha256");
        hash.update(entry.path);
        hash.update("\n");
        hash.update(entry.sha256);
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
          content: chunk.content,
        };
      });

      results.push({
        filePath: entry.path,
        sha256: entry.sha256,
        chunks,
      });
    }

    return results;
  }

  /**
   * Process document files.
   */
  private processDocumentFiles(
    projectRoot: string,
    fileEntries: Array<{ path: string; sha256: string }>
  ) {
    const results = [];

    for (const entry of fileEntries) {
      const fullPath = path.join(projectRoot, entry.path);
      const parseResult = this.docParser.parseDocument(fullPath, projectRoot);

      results.push({
        filePath: entry.path,
        sha256: entry.sha256,
        documentType: parseResult.documentType,
        entities: parseResult.entities,
        metadata: parseResult.metadata,
      });
    }

    return results;
  }
}
