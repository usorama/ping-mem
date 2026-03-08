/**
 * TemporalCodeGraph: Persist Project/File/Chunk/Symbol/Commit graph in Neo4j
 *
 * Bi-temporal model:
 * - `validFrom` / `validTo`: When the entity existed in the codebase (commit time)
 * - `ingestedAt`: When we captured this state (system time)
 *
 * Nodes:
 * - Project { projectId, rootPath, treeHash }
 * - File { fileId (sha256 of path), path, sha256, bytes }
 * - Chunk { chunkId, type: code|comment|docstring, start, end, content }
 * - Symbol { symbolId, name, kind, line }
 * - Commit { hash, authorDate, message, parentHashes[] }
 *
 * Relationships:
 * - (Project)-[:HAS_FILE { validFrom, validTo }]->(File)
 * - (File)-[:HAS_CHUNK { validFrom, validTo }]->(Chunk)
 * - (Chunk)-[:DEFINES_SYMBOL { validFrom, validTo }]->(Symbol)
 * - (Commit)-[:PARENT]->(Commit)
 * - (Commit)-[:MODIFIES { changeType }]->(File)
 * - (Commit)-[:CHANGES { hunkId }]->(Chunk)
 */

import { Neo4jClient } from "./Neo4jClient.js";
import neo4j from "neo4j-driver";
import type {
  IngestionResult,
  CodeFileResult,
  ChunkWithId,
  GitCommit,
  GitFileChange,
  GitDiffHunk,
  ProjectInfo,
} from "../ingest/index.js";
import type { ExtractedSymbol } from "../ingest/SymbolExtractor.js";
import * as crypto from "crypto";
import * as path from "path";
import { createLogger } from "../util/logger.js";

const log = createLogger("TemporalCodeGraph");

export interface TemporalCodeGraphOptions {
  neo4jClient: Neo4jClient;
}

export class TemporalCodeGraph {
  private readonly neo4j: Neo4jClient;

  constructor(options: TemporalCodeGraphOptions) {
    this.neo4j = options.neo4jClient;
  }

  private static readonly BATCH_SIZE = 500;

  /**
   * Persist a full ingestion result to Neo4j.
   * Idempotent: can be called multiple times for the same projectId + treeHash.
   * Uses UNWIND-based batching for performance (10x+ faster than individual queries).
   */
  async persistIngestion(result: IngestionResult): Promise<void> {
    // Validate required fields before touching Neo4j
    if (!result.projectId) {
      throw new Error("persistIngestion: projectId is required");
    }
    if (!result.projectManifest?.rootPath) {
      throw new Error("persistIngestion: rootPath is required");
    }
    if (!result.projectManifest?.treeHash) {
      throw new Error("persistIngestion: treeHash is required");
    }

    const session = this.neo4j.getSession();
    try {
      // 1. Create or merge Project node
      await session.run(
        `
        MERGE (p:Project { projectId: $projectId })
        SET p.name = $name,
            p.rootPath = $rootPath,
            p.treeHash = $treeHash,
            p.lastIngestedAt = $ingestedAt
        `,
        {
          projectId: result.projectId,
          name: path.basename(result.projectManifest.rootPath.replace(/[\\/]+$/, "")) || result.projectId,
          rootPath: result.projectManifest.rootPath,
          treeHash: result.projectManifest.treeHash,
          ingestedAt: result.ingestedAt,
        }
      );

      // 2. Batch persist files
      await this.persistFilesBatch(session, result.projectId, result.ingestedAt, result.codeFiles);

      // 3. Batch persist chunks
      await this.persistChunksBatch(session, result.ingestedAt, result.codeFiles);

      // 4. Batch persist symbols
      await this.persistSymbolsBatch(session, result.ingestedAt, result.codeFiles);

      // 5. Batch persist commits
      await this.persistCommitsBatch(session, result.projectId, result.gitHistory.commits);

      // 6. Batch persist commit parent relationships
      await this.persistParentsBatch(session, result.gitHistory.commits);

      // 7. Batch persist file changes
      await this.persistFileChangesBatch(session, result.gitHistory.fileChanges);

      // 8. Batch persist diff hunks
      await this.persistDiffHunksBatch(session, result.gitHistory.hunks);
    } finally {
      await session.close();
    }
  }

  /**
   * Query files in a project at a specific point in time (by commit or tree hash).
   */
  async queryFilesAtTime(
    projectId: string,
    treeHash?: string
  ): Promise<Array<{ path: string; sha256: string }>> {
    const session = this.neo4j.getSession();
    try {
      const result = await session.run(
        `
        MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(f:File)
        WHERE $treeHash IS NULL OR p.treeHash = $treeHash
        RETURN f.path AS path, f.sha256 AS sha256
        ORDER BY f.path
        `,
        { projectId, treeHash: treeHash ?? null }
      );

      return result.records.map((r) => ({
        path: r.get("path") as string,
        sha256: r.get("sha256") as string,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Query chunks for a specific file.
   */
  async queryFileChunks(
    projectId: string,
    filePath: string
  ): Promise<Array<ChunkWithId>> {
    const session = this.neo4j.getSession();
    try {
      const fileId = this.computeFileId(filePath);
      const result = await session.run(
        `
        MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(f:File { fileId: $fileId })-[:HAS_CHUNK]->(c:Chunk)
        RETURN c.chunkId AS chunkId, c.type AS type, c.start AS start, c.end AS end, c.lineStart AS lineStart, c.lineEnd AS lineEnd, c.content AS content
        ORDER BY c.start
        `,
        { projectId, fileId }
      );

      return result.records.map((r) => ({
        chunkId: r.get("chunkId") as string,
        type: r.get("type") as "code" | "comment" | "docstring",
        start: r.get("start").toNumber() as number,
        end: r.get("end").toNumber() as number,
        lineStart: r.get("lineStart")?.toNumber?.() ?? 0,
        lineEnd: r.get("lineEnd")?.toNumber?.() ?? 0,
        content: r.get("content") as string,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Query commit history (DAG).
   */
  async queryCommitHistory(
    projectId: string,
    limit: number = 100
  ): Promise<GitCommit[]> {
    if (!projectId || projectId.trim() === "") {
      throw new Error("queryCommitHistory: projectId is required and must not be empty");
    }

    const session = this.neo4j.getSession();
    try {
      // Check that the project exists before running the main query
      const projectCheck = await session.run(
        "MATCH (p:Project { projectId: $projectId }) RETURN p.name AS name",
        { projectId }
      );
      if (projectCheck.records.length === 0) {
        log.warn("queryCommitHistory: project not found in graph", { projectId });
        return [];
      }

      const result = await session.run(
        `
        MATCH (p:Project { projectId: $projectId })-[:HAS_COMMIT]->(c:Commit)
        OPTIONAL MATCH (c)-[:PARENT]->(parent:Commit)
        WITH c, collect(parent.hash) AS parentHashes
        RETURN c.hash AS hash,
               c.shortHash AS shortHash,
               c.authorName AS authorName,
               c.authorEmail AS authorEmail,
               c.authorDate AS authorDate,
               c.committerName AS committerName,
               c.committerEmail AS committerEmail,
               c.committerDate AS committerDate,
               c.message AS message,
               parentHashes
        ORDER BY c.committerDate DESC
        LIMIT $limit
        `,
        { projectId, limit: neo4j.int(limit) }
      );

      return result.records.map((r) => ({
        hash: r.get("hash") as string,
        shortHash: r.get("shortHash") as string,
        authorName: r.get("authorName") as string,
        authorEmail: r.get("authorEmail") as string,
        authorDate: r.get("authorDate") as string,
        committerName: r.get("committerName") as string,
        committerEmail: r.get("committerEmail") as string,
        committerDate: r.get("committerDate") as string,
        message: r.get("message") as string,
        parentHashes: r.get("parentHashes") as string[],
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Find which commits modified a specific file.
   */
  async queryFileHistory(
    projectId: string,
    filePath: string
  ): Promise<Array<{ commitHash: string; changeType: string; date: string }>> {
    const session = this.neo4j.getSession();
    try {
      const fileId = this.computeFileId(filePath);
      const result = await session.run(
        `
        MATCH (p:Project { projectId: $projectId })-[:HAS_COMMIT]->(c:Commit)-[m:MODIFIES]->(f:File { fileId: $fileId })
        RETURN c.hash AS commitHash, m.changeType AS changeType, c.authorDate AS date
        ORDER BY c.authorDate DESC
        `,
        { projectId, fileId }
      );

      return result.records.map((r) => ({
        commitHash: r.get("commitHash") as string,
        changeType: r.get("changeType") as string,
        date: r.get("date") as string,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Delete all nodes and relationships for a project.
   */
  async deleteProject(projectId: string): Promise<void> {
    const session = this.neo4j.getSession();
    try {
      await session.run(
        `
        MATCH (p:Project { projectId: $projectId })
        OPTIONAL MATCH (p)-[:HAS_FILE]->(f:File)
        OPTIONAL MATCH (f)-[:HAS_CHUNK]->(c:Chunk)
        OPTIONAL MATCH (c)-[:DEFINES_SYMBOL]->(s:Symbol)
        OPTIONAL MATCH (p)-[:HAS_COMMIT]->(commit:Commit)
        DETACH DELETE p, f, c, s, commit
        `,
        { projectId }
      );
    } finally {
      await session.close();
    }
  }

  /**
   * List all projects with metadata (file/chunk/commit counts).
   * Optionally filter by projectId, limit results, and sort by various fields.
   */
  async listProjects(options: {
    projectId?: string;
    limit?: number;
    sortBy?: "lastIngestedAt" | "filesCount" | "rootPath";
  } = {}): Promise<ProjectInfo[]> {
    const session = this.neo4j.getSession();
    try {
      const { projectId, limit = 100, sortBy = "lastIngestedAt" } = options;

      // Validate sortBy to prevent Cypher injection via interpolation
      const ALLOWED_SORT = new Set(["lastIngestedAt", "filesCount", "rootPath"]);
      if (!ALLOWED_SORT.has(sortBy)) {
        throw new Error(`Invalid sortBy value: expected one of ${[...ALLOWED_SORT].join(", ")}`);
      }

      // Build WHERE clause for optional projectId filter
      const whereClause = projectId
        ? "WHERE p.projectId = $projectId"
        : "";

      // Build ORDER BY clause (sortBy validated above)
      const orderByClause =
        sortBy === "lastIngestedAt"
          ? "ORDER BY p.lastIngestedAt DESC"
          : sortBy === "filesCount"
            ? "ORDER BY filesCount DESC"
            : "ORDER BY p.rootPath ASC";

      const result = await session.run(
        `
        MATCH (p:Project)
        ${whereClause}
        OPTIONAL MATCH (p)-[:HAS_FILE]->(f:File)
        OPTIONAL MATCH (f)-[:HAS_CHUNK]->(c:Chunk)
        OPTIONAL MATCH (p)-[:HAS_COMMIT]->(commit:Commit)
        WITH p,
             count(DISTINCT f) AS filesCount,
             count(DISTINCT c) AS chunksCount,
             count(DISTINCT commit) AS commitsCount
        RETURN p.projectId AS projectId,
               p.rootPath AS rootPath,
               p.treeHash AS treeHash,
               p.lastIngestedAt AS lastIngestedAt,
               filesCount,
               chunksCount,
               commitsCount
        ${orderByClause}
        LIMIT $limit
        `,
        {
          projectId: projectId ?? null,
          limit: neo4j.int(limit),
        }
      );

      return result.records.map((r) => ({
        projectId: r.get("projectId") as string,
        rootPath: r.get("rootPath") as string,
        treeHash: r.get("treeHash") as string,
        filesCount: r.get("filesCount").toNumber() as number,
        chunksCount: r.get("chunksCount").toNumber() as number,
        commitsCount: r.get("commitsCount").toNumber() as number,
        lastIngestedAt: r.get("lastIngestedAt") as string,
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Log with context for debugging
      log.error("Failed to list projects", {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        filters: { projectId: options.projectId, limit: options.limit, sortBy: options.sortBy }
      });

      // Re-throw with user-friendly message
      throw new Error(
        `Failed to query project graph database: ${errorMessage}. ` +
        `Check Neo4j connection and logs for details.`
      );
    } finally {
      await session.close();
    }
  }

  // ==========================================================================
  // Batch write methods using UNWIND for 10x+ performance
  // ==========================================================================

  private async runBatched<T>(
    session: import("neo4j-driver").Session,
    items: T[],
    cypher: string,
    buildParams: (batch: T[]) => Record<string, unknown>,
  ): Promise<void> {
    for (let i = 0; i < items.length; i += TemporalCodeGraph.BATCH_SIZE) {
      const batch = items.slice(i, i + TemporalCodeGraph.BATCH_SIZE);
      try {
        await session.run(cypher, buildParams(batch));
      } catch (error) {
        const batchIndex = Math.floor(i / TemporalCodeGraph.BATCH_SIZE);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Neo4j batch ${batchIndex} failed (items ${i}-${i + batch.length - 1} of ${items.length}): ${message}`
        );
      }
    }
  }

  private async persistFilesBatch(
    session: import("neo4j-driver").Session,
    projectId: string,
    ingestedAt: string,
    codeFiles: CodeFileResult[]
  ): Promise<void> {
    const items = codeFiles.map((f) => ({
      fileId: this.computeFileId(f.filePath),
      path: f.filePath,
      sha256: f.sha256,
    }));

    await this.runBatched(session, items,
      `
      UNWIND $items AS item
      MATCH (p:Project { projectId: $projectId })
      MERGE (f:File { fileId: item.fileId })
      SET f.path = item.path,
          f.sha256 = item.sha256,
          f.lastIngestedAt = $ingestedAt
      MERGE (p)-[:HAS_FILE { ingestedAt: $ingestedAt }]->(f)
      `,
      (batch) => ({ items: batch, projectId, ingestedAt })
    );
  }

  private async persistChunksBatch(
    session: import("neo4j-driver").Session,
    ingestedAt: string,
    codeFiles: CodeFileResult[]
  ): Promise<void> {
    const items: Array<{
      fileId: string;
      chunkId: string;
      type: string;
      start: number;
      end: number;
      lineStart: number;
      lineEnd: number;
      content: string;
    }> = [];

    for (const fileResult of codeFiles) {
      const fileId = this.computeFileId(fileResult.filePath);
      for (const chunk of fileResult.chunks) {
        items.push({
          fileId,
          chunkId: chunk.chunkId,
          type: chunk.type,
          start: chunk.start,
          end: chunk.end,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
          content: chunk.content,
        });
      }
    }

    await this.runBatched(session, items,
      `
      UNWIND $items AS item
      MATCH (f:File { fileId: item.fileId })
      MERGE (c:Chunk { chunkId: item.chunkId })
      SET c.type = item.type,
          c.start = item.start,
          c.end = item.end,
          c.lineStart = item.lineStart,
          c.lineEnd = item.lineEnd,
          c.content = item.content,
          c.lastIngestedAt = $ingestedAt
      MERGE (f)-[:HAS_CHUNK { ingestedAt: $ingestedAt }]->(c)
      `,
      (batch) => ({ items: batch, ingestedAt })
    );
  }

  private async persistSymbolsBatch(
    session: import("neo4j-driver").Session,
    ingestedAt: string,
    codeFiles: CodeFileResult[]
  ): Promise<void> {
    const symbolItems: Array<{
      fileId: string;
      symbolId: string;
      name: string;
      kind: string;
      startLine: number;
      endLine: number;
      signature: string | null;
    }> = [];

    for (const fileResult of codeFiles) {
      const fileId = this.computeFileId(fileResult.filePath);
      for (const symbol of fileResult.symbols) {
        symbolItems.push({
          fileId,
          symbolId: symbol.symbolId,
          name: symbol.name,
          kind: symbol.kind,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          signature: symbol.signature ?? null,
        });
      }
    }

    if (symbolItems.length === 0) return;

    // Create/merge symbol nodes and link to files
    await this.runBatched(session, symbolItems,
      `
      UNWIND $items AS item
      MATCH (f:File { fileId: item.fileId })
      MERGE (s:Symbol { symbolId: item.symbolId })
      SET s.name = item.name,
          s.kind = item.kind,
          s.startLine = item.startLine,
          s.endLine = item.endLine,
          s.signature = item.signature,
          s.lastIngestedAt = $ingestedAt
      MERGE (f)-[:DEFINES_SYMBOL { ingestedAt: $ingestedAt }]->(s)
      `,
      (batch) => ({ items: batch, ingestedAt })
    );

    // Link symbols to overlapping chunks
    await this.runBatched(session, symbolItems,
      `
      UNWIND $items AS item
      MATCH (s:Symbol { symbolId: item.symbolId })
      MATCH (f:File { fileId: item.fileId })-[:HAS_CHUNK]->(c:Chunk)
      WHERE c.lineStart <= item.endLine AND c.lineEnd >= item.startLine
      MERGE (c)-[:CONTAINS_SYMBOL { ingestedAt: $ingestedAt }]->(s)
      `,
      (batch) => ({ items: batch, ingestedAt })
    );
  }

  private async persistCommitsBatch(
    session: import("neo4j-driver").Session,
    projectId: string,
    commits: GitCommit[]
  ): Promise<void> {
    const items = commits.map((c) => ({
      hash: c.hash,
      shortHash: c.shortHash,
      authorName: c.authorName,
      authorEmail: c.authorEmail,
      authorDate: c.authorDate,
      committerName: c.committerName,
      committerEmail: c.committerEmail,
      committerDate: c.committerDate,
      message: c.message,
    }));

    await this.runBatched(session, items,
      `
      UNWIND $items AS item
      MATCH (p:Project { projectId: $projectId })
      MERGE (c:Commit { hash: item.hash })
      SET c.shortHash = item.shortHash,
          c.authorName = item.authorName,
          c.authorEmail = item.authorEmail,
          c.authorDate = item.authorDate,
          c.committerName = item.committerName,
          c.committerEmail = item.committerEmail,
          c.committerDate = item.committerDate,
          c.message = item.message
      MERGE (p)-[:HAS_COMMIT]->(c)
      `,
      (batch) => ({ items: batch, projectId })
    );
  }

  private async persistParentsBatch(
    session: import("neo4j-driver").Session,
    commits: GitCommit[]
  ): Promise<void> {
    const parentItems: Array<{ hash: string; parentHash: string }> = [];
    for (const commit of commits) {
      for (const parentHash of commit.parentHashes) {
        parentItems.push({ hash: commit.hash, parentHash });
      }
    }

    if (parentItems.length === 0) return;

    await this.runBatched(session, parentItems,
      `
      UNWIND $items AS item
      MATCH (c:Commit { hash: item.hash })
      MERGE (parent:Commit { hash: item.parentHash })
      MERGE (c)-[:PARENT]->(parent)
      `,
      (batch) => ({ items: batch })
    );
  }

  private async persistFileChangesBatch(
    session: import("neo4j-driver").Session,
    fileChanges: GitFileChange[]
  ): Promise<void> {
    const items = fileChanges.map((change) => ({
      commitHash: change.commitHash,
      fileId: this.computeFileId(change.filePath),
      filePath: change.filePath,
      changeType: change.changeType,
    }));

    await this.runBatched(session, items,
      `
      UNWIND $items AS item
      MATCH (c:Commit { hash: item.commitHash })
      MERGE (f:File { fileId: item.fileId })
      ON CREATE SET f.path = item.filePath
      MERGE (c)-[:MODIFIES { changeType: item.changeType }]->(f)
      `,
      (batch) => ({ items: batch })
    );
  }

  private async persistDiffHunksBatch(
    session: import("neo4j-driver").Session,
    hunks: GitDiffHunk[]
  ): Promise<void> {
    const items = hunks.map((hunk) => ({
      commitHash: hunk.commitHash,
      fileId: this.computeFileId(hunk.filePath),
      hunkId: this.computeHunkId(hunk),
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
    }));

    await this.runBatched(session, items,
      `
      UNWIND $items AS item
      MATCH (c:Commit { hash: item.commitHash })
      MATCH (f:File { fileId: item.fileId })-[:HAS_CHUNK]->(chunk:Chunk)
      WHERE chunk.lineStart <= item.newStart AND chunk.lineEnd >= item.newStart
      MERGE (c)-[:CHANGES {
        hunkId: item.hunkId,
        oldStart: item.oldStart,
        oldLines: item.oldLines,
        newStart: item.newStart,
        newLines: item.newLines
      }]->(chunk)
      `,
      (batch) => ({ items: batch })
    );
  }

  private computeFileId(filePath: string): string {
    return crypto.createHash("sha256").update(filePath).digest("hex");
  }

  private computeHunkId(hunk: GitDiffHunk): string {
    const hash = crypto.createHash("sha256");
    hash.update(hunk.commitHash);
    hash.update("\n");
    hash.update(hunk.filePath);
    hash.update("\n");
    hash.update(String(hunk.newStart));
    hash.update("\n");
    hash.update(String(hunk.newLines));
    return hash.digest("hex");
  }

  /**
   * Ensure Neo4j constraints exist for Project nodes.
   * Idempotent: safe to call multiple times.
   */
  async ensureConstraints(): Promise<void> {
    const session = this.neo4j.getSession();
    try {
      await session.run(
        "CREATE CONSTRAINT project_id_not_null IF NOT EXISTS FOR (p:Project) REQUIRE p.projectId IS NOT NULL"
      );
      await session.run(
        "CREATE CONSTRAINT project_id_unique IF NOT EXISTS FOR (p:Project) REQUIRE p.projectId IS UNIQUE"
      );
      log.info("Neo4j constraints ensured");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Failed to ensure Neo4j constraints", { error: message });
      throw new Error(`Failed to ensure Neo4j constraints: ${message}`);
    } finally {
      await session.close();
    }
  }
}
