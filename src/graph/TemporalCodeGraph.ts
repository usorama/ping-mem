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

export interface TemporalCodeGraphOptions {
  neo4jClient: Neo4jClient;
}

export class TemporalCodeGraph {
  private readonly neo4j: Neo4jClient;

  constructor(options: TemporalCodeGraphOptions) {
    this.neo4j = options.neo4jClient;
  }

  /**
   * Persist a full ingestion result to Neo4j.
   * Idempotent: can be called multiple times for the same projectId + treeHash.
   */
  async persistIngestion(result: IngestionResult): Promise<void> {
    const session = this.neo4j.getSession();
    try {
      // Create or merge Project node
      await session.run(
        `
        MERGE (p:Project { projectId: $projectId })
        SET p.rootPath = $rootPath,
            p.treeHash = $treeHash,
            p.lastIngestedAt = $ingestedAt
        `,
        {
          projectId: result.projectId,
          rootPath: result.projectManifest.rootPath,
          treeHash: result.projectManifest.treeHash,
          ingestedAt: result.ingestedAt,
        }
      );

      // Persist files + chunks
      for (const fileResult of result.codeFiles) {
        await this.persistFile(result.projectId, result.ingestedAt, fileResult);
      }

      // Persist git commits
      for (const commit of result.gitHistory.commits) {
        await this.persistCommit(result.projectId, commit);
      }

      // Persist file changes (Commit)-[:MODIFIES]->(File)
      for (const change of result.gitHistory.fileChanges) {
        await this.persistFileChange(result.projectId, change);
      }

      // Persist diff hunks (Commit)-[:CHANGES]->(Chunk)
      for (const hunk of result.gitHistory.hunks) {
        await this.persistDiffHunk(result.projectId, hunk);
      }
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
    const session = this.neo4j.getSession();
    try {
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

      // Build WHERE clause for optional projectId filter
      const whereClause = projectId
        ? "WHERE p.projectId = $projectId"
        : "";

      // Build ORDER BY clause
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
      console.error(`[TemporalCodeGraph] Failed to list projects:`, {
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

  private async persistFile(
    projectId: string,
    ingestedAt: string,
    fileResult: CodeFileResult
  ): Promise<void> {
    const session = this.neo4j.getSession();
    try {
      const fileId = this.computeFileId(fileResult.filePath);

      // Create or merge File node
      await session.run(
        `
        MATCH (p:Project { projectId: $projectId })
        MERGE (f:File { fileId: $fileId })
        SET f.path = $path,
            f.sha256 = $sha256,
            f.lastIngestedAt = $ingestedAt
        MERGE (p)-[:HAS_FILE { ingestedAt: $ingestedAt }]->(f)
        `,
        {
          projectId,
          fileId,
          path: fileResult.filePath,
          sha256: fileResult.sha256,
          ingestedAt,
        }
      );

      // Persist chunks
      for (const chunk of fileResult.chunks) {
        await session.run(
          `
          MATCH (f:File { fileId: $fileId })
          MERGE (c:Chunk { chunkId: $chunkId })
          SET c.type = $type,
              c.start = $start,
              c.end = $end,
              c.lineStart = $lineStart,
              c.lineEnd = $lineEnd,
              c.content = $content,
              c.lastIngestedAt = $ingestedAt
          MERGE (f)-[:HAS_CHUNK { ingestedAt: $ingestedAt }]->(c)
          `,
          {
            fileId,
            chunkId: chunk.chunkId,
            type: chunk.type,
            start: chunk.start,
            end: chunk.end,
            lineStart: chunk.lineStart,
            lineEnd: chunk.lineEnd,
            content: chunk.content,
            ingestedAt,
          }
        );
      }

      // Persist symbols
      for (const symbol of fileResult.symbols) {
        await this.persistSymbol(fileId, symbol, ingestedAt);
      }
    } finally {
      await session.close();
    }
  }

  private async persistSymbol(
    fileId: string,
    symbol: ExtractedSymbol,
    ingestedAt: string
  ): Promise<void> {
    const session = this.neo4j.getSession();
    try {
      // Create or merge Symbol node
      await session.run(
        `
        MATCH (f:File { fileId: $fileId })
        MERGE (s:Symbol { symbolId: $symbolId })
        SET s.name = $name,
            s.kind = $kind,
            s.startLine = $startLine,
            s.endLine = $endLine,
            s.signature = $signature,
            s.lastIngestedAt = $ingestedAt
        MERGE (f)-[:DEFINES_SYMBOL { ingestedAt: $ingestedAt }]->(s)
        `,
        {
          fileId,
          symbolId: symbol.symbolId,
          name: symbol.name,
          kind: symbol.kind,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          signature: symbol.signature ?? null,
          ingestedAt,
        }
      );

      // Link symbol to chunks that contain it
      await session.run(
        `
        MATCH (s:Symbol { symbolId: $symbolId })
        MATCH (f:File { fileId: $fileId })-[:HAS_CHUNK]->(c:Chunk)
        WHERE c.lineStart <= $symbolEndLine AND c.lineEnd >= $symbolStartLine
        MERGE (c)-[:CONTAINS_SYMBOL { ingestedAt: $ingestedAt }]->(s)
        `,
        {
          fileId,
          symbolId: symbol.symbolId,
          symbolStartLine: symbol.startLine,
          symbolEndLine: symbol.endLine,
          ingestedAt,
        }
      );
    } finally {
      await session.close();
    }
  }

  private async persistCommit(projectId: string, commit: GitCommit): Promise<void> {
    const session = this.neo4j.getSession();
    try {
      // Create or merge Commit node
      await session.run(
        `
        MATCH (p:Project { projectId: $projectId })
        MERGE (c:Commit { hash: $hash })
        SET c.shortHash = $shortHash,
            c.authorName = $authorName,
            c.authorEmail = $authorEmail,
            c.authorDate = $authorDate,
            c.committerName = $committerName,
            c.committerEmail = $committerEmail,
            c.committerDate = $committerDate,
            c.message = $message
        MERGE (p)-[:HAS_COMMIT]->(c)
        `,
        {
          projectId,
          hash: commit.hash,
          shortHash: commit.shortHash,
          authorName: commit.authorName,
          authorEmail: commit.authorEmail,
          authorDate: commit.authorDate,
          committerName: commit.committerName,
          committerEmail: commit.committerEmail,
          committerDate: commit.committerDate,
          message: commit.message,
        }
      );

      // Create parent relationships
      for (const parentHash of commit.parentHashes) {
        await session.run(
          `
          MATCH (c:Commit { hash: $hash })
          MERGE (parent:Commit { hash: $parentHash })
          MERGE (c)-[:PARENT]->(parent)
          `,
          { hash: commit.hash, parentHash }
        );
      }
    } finally {
      await session.close();
    }
  }

  private async persistFileChange(
    projectId: string,
    change: GitFileChange
  ): Promise<void> {
    const session = this.neo4j.getSession();
    try {
      const fileId = this.computeFileId(change.filePath);
      await session.run(
        `
        MATCH (c:Commit { hash: $commitHash })
        MERGE (f:File { fileId: $fileId })
        ON CREATE SET f.path = $filePath
        MERGE (c)-[:MODIFIES { changeType: $changeType }]->(f)
        `,
        {
          commitHash: change.commitHash,
          fileId,
          filePath: change.filePath,
          changeType: change.changeType,
        }
      );
    } finally {
      await session.close();
    }
  }

  private async persistDiffHunk(
    projectId: string,
    hunk: GitDiffHunk
  ): Promise<void> {
    const session = this.neo4j.getSession();
    try {
      const hunkId = this.computeHunkId(hunk);
      const fileId = this.computeFileId(hunk.filePath);

      // Try to find matching chunks and link them
      await session.run(
        `
        MATCH (c:Commit { hash: $commitHash })
        MATCH (f:File { fileId: $fileId })-[:HAS_CHUNK]->(chunk:Chunk)
        WHERE chunk.lineStart <= $newStart AND chunk.lineEnd >= $newStart
        MERGE (c)-[:CHANGES {
          hunkId: $hunkId,
          oldStart: $oldStart,
          oldLines: $oldLines,
          newStart: $newStart,
          newLines: $newLines
        }]->(chunk)
        `,
        {
          commitHash: hunk.commitHash,
          fileId,
          hunkId,
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart,
          newLines: hunk.newLines,
        }
      );
    } finally {
      await session.close();
    }
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
}
