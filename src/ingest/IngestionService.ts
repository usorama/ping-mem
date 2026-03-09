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

import { IngestionOrchestrator, type IngestionResult } from "./IngestionOrchestrator.js";
import { TemporalCodeGraph } from "../graph/TemporalCodeGraph.js";
import { CodeIndexer } from "../search/CodeIndexer.js";
import { Neo4jClient } from "../graph/Neo4jClient.js";
import { QdrantClientWrapper } from "../search/QdrantClient.js";
import type { ProjectInfo } from "./types.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("IngestionService");

export interface IngestionServiceOptions {
  neo4jClient: Neo4jClient;
  qdrantClient: QdrantClientWrapper;
}

export interface IngestProjectOptions {
  projectDir: string;
  forceReingest?: boolean;
  maxCommits?: number; // Max git commits to ingest (default 200)
  maxCommitAgeDays?: number; // Only include commits from last N days (default: 30)
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
  private readonly codeIndexer: CodeIndexer;

  constructor(options: IngestionServiceOptions) {
    this.orchestrator = new IngestionOrchestrator();
    this.codeGraph = new TemporalCodeGraph({
      neo4jClient: options.neo4jClient,
    });
    this.codeIndexer = new CodeIndexer({
      qdrantClient: options.qdrantClient,
    });
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
    if (options.maxCommits !== undefined) {
      ingestOptions.maxCommits = options.maxCommits;
    }
    ingestOptions.maxCommitAgeDays = options.maxCommitAgeDays ?? 30;

    const ingestionResult = await this.orchestrator.ingest(options.projectDir, ingestOptions);

    if (!ingestionResult) {
      return null; // No changes
    }

    // Persist to Neo4j
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

    return {
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
  }

  /**
   * Verify that the ingested manifest matches current project state.
   */
  async verifyProject(projectDir: string): Promise<VerifyProjectResult> {
    const valid = await this.orchestrator.verify(projectDir);

    // If valid, also extract current hashes for confirmation
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

    return {
      projectId: manifest.projectId,
      valid,
      manifestTreeHash: manifest.treeHash,
      currentTreeHash: manifest.treeHash, // If valid, they're the same
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
  } = {}): Promise<ProjectInfo[]> {
    try {
      return await this.codeGraph.listProjects(options);
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
