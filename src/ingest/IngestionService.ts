/**
 * IngestionService: High-level service orchestrating full ingestion pipeline
 *
 * Responsibilities:
 * 1. Deterministic project scan + hashing
 * 2. Code chunking + git history ingestion
 * 3. Persist to Neo4j (temporal code graph)
 * 4. Index vectors in Qdrant
 * 5. Verify integrity
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { IngestionOrchestrator, type IngestionResult } from "./IngestionOrchestrator.js";
import { resolveDefaultMaxCommits, resolveDefaultMaxCommitAgeDays } from "./GitHistoryReader.js";
import { normalizeIngestionIdentity } from "./identity.js";
import { filterProjectsToRegisteredRoots, loadRegisteredProjectRoots, type ProjectInventoryScope } from "./registered-projects.js";
import { TemporalCodeGraph } from "../graph/TemporalCodeGraph.js";
import { StructuralAnalyzer } from "../graph/StructuralAnalyzer.js";
import { CodeIndexer } from "../search/CodeIndexer.js";
import { Neo4jClient } from "../graph/Neo4jClient.js";
import { QdrantClientWrapper } from "../search/QdrantClient.js";
import type { ProjectInfo } from "./types.js";
import { createLogger } from "../util/logger.js";
import type { EventStore } from "../storage/EventStore.js";
import type { SessionId, IngestionEventData, WorklogEventData } from "../types/index.js";
import { IngestionEventEmitter } from "./IngestionEventEmitter.js";
import { sanitizeHealthError } from "../observability/health-probes.js";
import type { HealthMonitor } from "../observability/HealthMonitor.js";

const log = createLogger("IngestionService");

/** System session ID for ingestion events (EVAL G-04 fix) */
const SYSTEM_SESSION_ID = "system-ingestion" as SessionId;

export interface IngestionServiceOptions {
  neo4jClient: Neo4jClient;
  qdrantClient: QdrantClientWrapper;
  eventStore?: EventStore;
  healthMonitor?: HealthMonitor;
  /** BM25Scorer instance for primary ranking. Passed to CodeIndexer. */
  bm25Scorer?: import("../search/BM25Scorer.js").BM25Scorer;
}

export interface IngestProjectOptions {
  projectDir: string;
  forceReingest?: boolean;
  /**
   * Max git commits to ingest.
   * Default: unbounded (env override: PING_MEM_MAX_COMMITS).
   * Use 0 to ingest the full commit history explicitly.
   */
  maxCommits?: number;
  /**
   * Only include commits from last N days. Default: unbounded (env override:
   * PING_MEM_MAX_COMMIT_AGE_DAYS). Use 0 to disable the age filter explicitly.
   */
  maxCommitAgeDays?: number;
}

export interface IngestProjectResult {
  projectId: string;
  treeHash: string;
  filesIndexed: number;
  chunksIndexed: number;
  commitsIndexed: number;
  ingestedAt: string;
  hadChanges: boolean;
}

export interface VerifyProjectResult {
  projectId: string;
  valid: boolean;
  manifestTreeHash: string | null;
  currentTreeHash: string | null;
  message: string;
}

export interface QueryTimelineOptions {
  projectId: string;
  filePath?: string;
  limit?: number;
}

export interface TimelineEvent {
  commitHash: string;
  date: string;
  authorName: string;
  message: string;
  changeType?: string;
  why: string; // Explicit-only: from commit message or references
}

export class IngestionService {
  private readonly orchestrator: IngestionOrchestrator;
  private readonly codeGraph: TemporalCodeGraph;
  private readonly structuralAnalyzer: StructuralAnalyzer;
  private readonly codeIndexer: CodeIndexer;
  private readonly eventStore: EventStore | null;
  private readonly healthMonitor: HealthMonitor | null;
  readonly ingestionEmitter: IngestionEventEmitter;

  constructor(options: IngestionServiceOptions) {
    this.orchestrator = new IngestionOrchestrator();
    this.codeGraph = new TemporalCodeGraph({
      neo4jClient: options.neo4jClient,
    });
    this.structuralAnalyzer = new StructuralAnalyzer();
    this.codeIndexer = new CodeIndexer({
      qdrantClient: options.qdrantClient,
      ...(options.bm25Scorer ? { bm25Scorer: options.bm25Scorer } : {}),
    });
    this.eventStore = options.eventStore ?? null;
    this.healthMonitor = options.healthMonitor ?? null;
    this.ingestionEmitter = new IngestionEventEmitter();
  }

  /**
   * Ensure Neo4j constraints are set up (idempotent).
   * Should be called once at startup or before first ingestion.
   */
  async ensureConstraints(): Promise<void> {
    await this.codeGraph.ensureConstraints();
  }

  /**
   * Ingest a project: scan, chunk, index graph + vectors.
   * Returns null if no changes detected (unless forceReingest=true).
   */
  async ingestProject(
    options: IngestProjectOptions
  ): Promise<IngestProjectResult | null> {
    const ingestOptions: import("./IngestionOrchestrator.js").IngestionOptions = {};
    if (options.forceReingest !== undefined) {
      ingestOptions.forceReingest = options.forceReingest;
    }
    // Phase 2: Resolve defaults from env vars if caller didn't specify.
    // Always pass explicit values through to the orchestrator so GitHistoryReader
    // sees the *effective* value (behaviorally-unified default).
    const effectiveMaxCommits = options.maxCommits ?? resolveDefaultMaxCommits();
    const effectiveMaxCommitAgeDays =
      options.maxCommitAgeDays ?? resolveDefaultMaxCommitAgeDays();
    ingestOptions.maxCommits = effectiveMaxCommits;
    ingestOptions.maxCommitAgeDays = effectiveMaxCommitAgeDays;
    if (options.maxCommitAgeDays === undefined) {
      log.info(
        effectiveMaxCommitAgeDays > 0
          ? `maxCommitAgeDays not specified — defaulting to ${effectiveMaxCommitAgeDays} days ` +
              `(env: PING_MEM_MAX_COMMIT_AGE_DAYS; 0 disables the filter)`
          : "maxCommitAgeDays not specified — ingesting full history (no age filter)",
      );
    }

    // Phase 2: skipManifestSave — defer manifest until after Neo4j + Qdrant succeed
    ingestOptions.skipManifestSave = true;

    const startTime = Date.now();
    const runId = crypto.randomUUID();
    let currentPhase = "scanning";
    let activeProjectId: string | null = null;

    // Phase 3: Emit ingestion started event
    await this.emitIngestionEvent("CODEBASE_INGESTION_STARTED", {
      runId,
      projectDir: options.projectDir,
    });

    try {
      const rawIngestionResult = await this.orchestrator.ingest(options.projectDir, ingestOptions);

      if (!rawIngestionResult) {
        return null; // No changes
      }

      const ingestionResult = normalizeIngestionIdentity(rawIngestionResult);

      // Suppress HealthMonitor drift alerts during Neo4j+Qdrant writes (EVAL G-06 fix)
      activeProjectId = ingestionResult.projectId;
      this.healthMonitor?.suppressDuringIngestion(activeProjectId);

      // Persist to Neo4j
      currentPhase = "persisting_neo4j";
      try {
        await this.codeGraph.persistIngestion(ingestionResult);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("ingestProject: Neo4j persist failed", {
          projectId: ingestionResult.projectId,
          error: message,
        });
        throw new Error(
          `Ingestion failed for project "${ingestionResult.projectId}": ` +
          `Neo4j persist failed: ${message}`
        );
      }

      // Index vectors in Qdrant
      currentPhase = "indexing_qdrant";
      try {
        await this.codeIndexer.indexIngestion(ingestionResult);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("ingestProject: Qdrant indexing failed after Neo4j persist succeeded", {
          projectId: ingestionResult.projectId,
          error: message,
        });
        throw new Error(
          `Ingestion partially failed for project "${ingestionResult.projectId}": ` +
          `Neo4j persist succeeded but Qdrant indexing failed. ` +
          `Run force reingest to recover: ${message}`
        );
      }

      // Structural analysis: extract import/call/export edges and persist to Neo4j
      currentPhase = "structural_analysis";
      try {
        await this.runStructuralAnalysis(options.projectDir, ingestionResult);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn("ingestProject: structural analysis failed (non-fatal)", {
          projectId: ingestionResult.projectId,
          error: message,
        });
      }

      // Resume HealthMonitor drift checking after both Neo4j+Qdrant succeed
      this.healthMonitor?.resumeAfterIngestion(ingestionResult.projectId);

      // Phase 2: Save manifest ONLY after both Neo4j and Qdrant succeed
      this.orchestrator.saveManifest(options.projectDir, ingestionResult.projectManifest);

      const result: IngestProjectResult = {
        projectId: ingestionResult.projectId,
        treeHash: ingestionResult.projectManifest.treeHash,
        filesIndexed: ingestionResult.codeFiles.length,
        chunksIndexed: ingestionResult.codeFiles.reduce(
          (sum, f) => sum + f.chunks.length,
          0
        ),
        commitsIndexed: ingestionResult.gitHistory.commits.length,
        ingestedAt: ingestionResult.ingestedAt,
        hadChanges: true,
      };

      const durationMs = Date.now() - startTime;

      // Phase 3: Emit ingestion completed event
      await this.emitIngestionEvent("CODEBASE_INGESTION_COMPLETED", {
        runId,
        projectDir: options.projectDir,
        projectId: result.projectId,
        filesIndexed: result.filesIndexed,
        chunksIndexed: result.chunksIndexed,
        commitsIndexed: result.commitsIndexed,
        durationMs,
      });

      // Phase 3: Record worklog entry (EVAL G-09: sessionId required)
      await this.recordWorklog(options.projectDir, result, durationMs);

      return result;
    } catch (error) {
      // Resume HealthMonitor if suppressed (even on failure)
      if (activeProjectId) {
        this.healthMonitor?.resumeAfterIngestion(activeProjectId);
      }
      const durationMs = Date.now() - startTime;
      // Phase 3: Emit ingestion failed event
      await this.emitIngestionEvent("CODEBASE_INGESTION_FAILED", {
        runId,
        projectDir: options.projectDir,
        phase: currentPhase,
        error: sanitizeHealthError(error),
        durationMs,
      });
      throw error;
    }
  }

  /**
   * Verify that the ingested manifest matches current project state.
   */
  async verifyProject(projectDir: string): Promise<VerifyProjectResult> {
    const manifest = this.orchestrator.getManifest(projectDir);

    if (!manifest) {
      return {
        projectId: "",
        valid: false,
        manifestTreeHash: null,
        currentTreeHash: null,
        message: "No manifest found. Run ingest first.",
      };
    }

    // Scan the project fresh to get the actual current tree hash (not the cached one).
    // This allows callers to see old vs. new hashes when valid=false.
    const currentScan = await this.orchestrator.scan(projectDir);
    const currentTreeHash = currentScan.manifest.treeHash;
    const valid = currentTreeHash === manifest.treeHash && currentScan.manifest.projectId === manifest.projectId;

    return {
      projectId: manifest.projectId,
      valid,
      manifestTreeHash: manifest.treeHash,
      currentTreeHash,
      message: valid
        ? "Project manifest is up-to-date and matches on-disk files."
        : "Project has changed since last ingestion. Re-ingest to update.",
    };
  }

  /**
   * Query timeline for a project or file.
   * Returns explicit-only "why": commit messages, PR refs, ADR links, etc.
   */
  async queryTimeline(
    options: QueryTimelineOptions
  ): Promise<TimelineEvent[]> {
    if (!options.projectId) {
      throw new Error("queryTimeline requires a projectId");
    }

    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 100), 10000));

    if (options.filePath) {
      // File-specific timeline
      const history = await this.codeGraph.queryFileHistory(
        options.projectId,
        options.filePath
      );

      // Fetch enough commits to cover all file history entries
      // (file may have been modified in commits beyond the user's limit)
      const commitFetchLimit = Math.min(Math.max(limit, history.length), 10000);
      const commits = await this.codeGraph.queryCommitHistory(
        options.projectId,
        commitFetchLimit
      );

      const commitMap = new Map(commits.map((c) => [c.hash, c]));

      return history.slice(0, limit).map((h) => {
        const commit = commitMap.get(h.commitHash);
        return {
          commitHash: h.commitHash,
          date: h.date,
          authorName: commit?.authorName ?? "",
          message: commit?.message ?? "",
          changeType: h.changeType,
          why: this.extractExplicitWhy(commit?.message ?? ""),
        };
      });
    } else {
      // Project-wide timeline
      const commits = await this.codeGraph.queryCommitHistory(
        options.projectId,
        limit
      );

      return commits.map((c) => ({
        commitHash: c.hash,
        date: c.authorDate,
        authorName: c.authorName,
        message: c.message,
        why: this.extractExplicitWhy(c.message),
      }));
    }
  }

  /**
   * Search code chunks semantically.
   */
  async searchCode(
    query: string,
    options: {
      projectId?: string;
      filePath?: string;
      type?: "code" | "comment" | "docstring";
      limit?: number;
    } = {}
  ) {
    return this.codeIndexer.search(query, options);
  }

  /**
   * Delete all indexed data for a project.
   * Attempts both Neo4j and Qdrant deletion; reports partial failures.
   */
  async deleteProject(projectId: string): Promise<void> {
    const errors: string[] = [];

    try {
      await this.codeGraph.deleteProject(projectId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("deleteProject: Neo4j deletion failed", { projectId, error: message });
      errors.push(`Neo4j: ${message}`);
    }

    try {
      await this.codeIndexer.deleteProject(projectId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("deleteProject: Qdrant deletion failed", { projectId, error: message });
      errors.push(`Qdrant: ${message}`);
    }

    if (errors.length > 0) {
      throw new Error(`Partial deletion failure for project "${projectId}": ${errors.join("; ")}`);
    }
  }

  /**
   * List all ingested projects with metadata.
   * Returns project info including file/chunk/commit counts.
   */
  async listProjects(options: {
    projectId?: string;
    limit?: number;
    sortBy?: "lastIngestedAt" | "filesCount" | "rootPath";
    scope?: ProjectInventoryScope;
  } = {}): Promise<ProjectInfo[]> {
    try {
      const { scope = "registered", projectId, limit = 100, sortBy } = options;
      const queryOptions: {
        limit: number;
        projectId?: string;
        sortBy?: "lastIngestedAt" | "filesCount" | "rootPath";
      } = {
        limit: projectId || scope === "all" ? limit : Math.max(limit, 5000),
      };
      if (projectId !== undefined) {
        queryOptions.projectId = projectId;
      }
      if (sortBy !== undefined) {
        queryOptions.sortBy = sortBy;
      }

      const projects = await this.codeGraph.listProjects(queryOptions);
      if (projectId || scope === "all") {
        return projects;
      }

      return filterProjectsToRegisteredRoots(projects, loadRegisteredProjectRoots()).slice(0, limit);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Log at service layer with context
      log.error("listProjects failed", {
        error: errorMessage,
        filters: options,
      });

      // Re-throw - let caller decide how to handle
      throw error;
    }
  }

  // Structural intelligence queries
  async queryImpact(
    projectId: string,
    filePath: string,
    maxDepth?: number,
    limit?: number
  ): Promise<{ results: Array<{ file: string; depth: number; via: string[] }>; truncated: boolean; limit: number }> {
    return this.codeGraph.queryImpact(projectId, filePath, maxDepth, limit);
  }
  async queryBlastRadius(
    projectId: string,
    filePath: string,
    maxDepth?: number,
    limit?: number
  ): Promise<{ results: Array<{ file: string; depth: number }>; truncated: boolean; limit: number }> {
    return this.codeGraph.queryBlastRadius(projectId, filePath, maxDepth, limit);
  }
  async queryDependencyMap(projectId: string, includeExternal?: boolean): Promise<Array<{ sourceFile: string; targetFile: string; symbolName: string; isExternal: boolean }>> {
    return this.codeGraph.queryDependencyMap(projectId, includeExternal);
  }
  async queryImportsOf(projectId: string, filePath: string): Promise<Array<{ targetFile: string; symbolName: string; line: number; isExternal: boolean }>> {
    return this.codeGraph.queryImportsOf(projectId, filePath);
  }
  async queryImportedBy(projectId: string, filePath: string): Promise<Array<{ sourceFile: string; symbolName: string; line: number }>> {
    return this.codeGraph.queryImportedBy(projectId, filePath);
  }

  // Structural analysis pipeline
  private async runStructuralAnalysis(projectDir: string, ingestionResult: IngestionResult): Promise<void> {
    const projectPath = path.resolve(projectDir);
    const allProjectFiles = new Set(ingestionResult.codeFiles.map((f) => f.filePath));
    const files: Array<{ filePath: string; content: string }> = [];
    let skippedFiles = 0;
    for (const codeFile of ingestionResult.codeFiles) {
      try {
        const fullPath = path.join(projectPath, codeFile.filePath);
        const content = fs.readFileSync(fullPath, "utf-8");
        files.push({ filePath: codeFile.filePath, content });
      } catch (err) {
        skippedFiles++;
        log.debug("Skipped unreadable file during structural analysis", { file: codeFile.filePath, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (skippedFiles > 0) {
      log.warn("Structural analysis skipped unreadable files", { skippedFiles, totalFiles: ingestionResult.codeFiles.length });
    }
    const structuralResult = this.structuralAnalyzer.analyzeProject(files, allProjectFiles);
    await this.codeGraph.deleteStructuralEdges(ingestionResult.projectId);
    if (structuralResult.edges.length > 0) {
      await this.codeGraph.persistStructuralEdges(
        ingestionResult.projectId, structuralResult.edges, ingestionResult.ingestedAt,
      );
      log.info("Structural analysis complete", {
        projectId: ingestionResult.projectId,
        edgesFound: structuralResult.edges.length,
        filesAnalyzed: structuralResult.filesAnalyzed,
      });
    } else {
      log.info("Structural analysis complete with no edges", {
        projectId: ingestionResult.projectId,
        filesAnalyzed: structuralResult.filesAnalyzed,
      });
    }
  }

  /**
   * Phase 3: Emit an ingestion event to both EventStore and IngestionEventEmitter.
   */
  private async emitIngestionEvent(
    eventType: "CODEBASE_INGESTION_STARTED" | "CODEBASE_INGESTION_COMPLETED" | "CODEBASE_INGESTION_FAILED",
    data: IngestionEventData
  ): Promise<void> {
    // Emit to typed emitter (for SSE streaming)
    this.ingestionEmitter.emitIngestion({ ...data, eventType });

    // Persist to EventStore (if available)
    try {
      await this.eventStore?.createEvent(SYSTEM_SESSION_ID, eventType, data as unknown as Record<string, unknown>);
    } catch (err) {
      const level = eventType === "CODEBASE_INGESTION_FAILED" ? "error" : "warn";
      log[level]("Failed to persist ingestion event to EventStore", {
        eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Phase 3: Record a worklog entry for completed ingestion (EVAL G-09).
   */
  private async recordWorklog(
    projectDir: string,
    result: IngestProjectResult,
    durationMs: number
  ): Promise<void> {
    if (!this.eventStore) return;

    const worklogData: WorklogEventData = {
      sessionId: SYSTEM_SESSION_ID,
      kind: "tool",
      title: `Ingested ${path.basename(projectDir)}`,
      toolName: "codebase-ingest",
      projectId: result.projectId,
      treeHash: result.treeHash,
      status: "success",
      durationMs,
    };

    try {
      await this.eventStore.createEvent(SYSTEM_SESSION_ID, "TOOL_RUN_RECORDED", worklogData);
    } catch (err) {
      log.warn("Failed to record ingestion worklog", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Extract explicit "why" from commit message.
   * Never guess or infer—only extract what's explicitly stated.
   */
  private extractExplicitWhy(commitMessage: string): string {
    // Extract lines that look like explicit reasons:
    // - Lines starting with "Why:", "Reason:", "Fixes #", "Closes #", "Refs #"
    // - ADR references: "ADR-XXX"
    // - Issue/PR references

    const lines = commitMessage.split("\n");
    const explicitLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("Why:") ||
        trimmed.startsWith("Reason:") ||
        trimmed.startsWith("Fixes #") ||
        trimmed.startsWith("Closes #") ||
        trimmed.startsWith("Refs #") ||
        trimmed.startsWith("References:") ||
        /ADR-\d+/.test(trimmed) ||
        /\(#\d+\)/.test(trimmed)
      ) {
        explicitLines.push(trimmed);
      }
    }

    if (explicitLines.length > 0) {
      return explicitLines.join("; ");
    }

    // If no explicit markers, return just the first line (summary)
    return lines[0]?.trim() ?? "";
  }
}
