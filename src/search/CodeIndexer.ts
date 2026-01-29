/**
 * CodeIndexer: Index code chunks into Qdrant with full provenance
 *
 * Stores deterministic vectors + metadata payload:
 * - projectId: Which project
 * - filePath: Relative file path
 * - chunkId: Content-addressable chunk ID
 * - sha256: File content hash
 * - type: code | comment | docstring
 * - content: Full chunk text
 */

import { QdrantClientWrapper } from "./QdrantClient.js";
import { DeterministicVectorizer } from "./DeterministicVectorizer.js";
import type { IngestionResult, CodeFileResult, ChunkWithId } from "../ingest/index.js";

export interface CodeIndexerOptions {
  qdrantClient: QdrantClientWrapper;
  vectorizer?: DeterministicVectorizer;
}

export interface ChunkSearchResult {
  chunkId: string;
  projectId: string;
  filePath: string;
  type: "code" | "comment" | "docstring";
  content: string;
  lineStart?: number;
  lineEnd?: number;
  score: number;
}

export class CodeIndexer {
  private readonly qdrant: QdrantClientWrapper;
  private readonly vectorizer: DeterministicVectorizer;

  constructor(options: CodeIndexerOptions) {
    this.qdrant = options.qdrantClient;
    this.vectorizer = options.vectorizer ?? new DeterministicVectorizer();
  }

  /**
   * Index all chunks from an ingestion result.
   * Idempotent: can be called multiple times for the same chunkId.
   */
  async indexIngestion(result: IngestionResult): Promise<void> {
    const points = this.buildIndexPoints(result);

    // Batch upsert to Qdrant using the Qdrant SDK's native upsert
    if (points.length > 0) {
      const qdrantClient = this.qdrant.getClient();
      const collectionName = this.qdrant["config"]["collectionName"]; // Access via bracket notation

      await qdrantClient.upsert(collectionName, {
        wait: true,
        points: points.map((p) => ({
          id: p.id,
          vector: p.vector,
          payload: p.payload,
        })),
      });
    }
  }

  /**
   * Search for chunks by semantic/keyword similarity.
   */
  async search(
    query: string,
    options: {
      projectId?: string;
      filePath?: string;
      type?: "code" | "comment" | "docstring";
      limit?: number;
    } = {}
  ): Promise<ChunkSearchResult[]> {
    const queryVector = this.vectorizer.vectorize(query);
    const qdrantClient = this.qdrant.getClient();
    const collectionName = this.qdrant["config"]["collectionName"];

    // Build filter conditions
    const mustConditions: Array<{ key: string; match: { value: string } }> = [];
    if (options.projectId) {
      mustConditions.push({
        key: "projectId",
        match: { value: options.projectId },
      });
    }
    if (options.filePath) {
      mustConditions.push({
        key: "filePath",
        match: { value: options.filePath },
      });
    }
    if (options.type) {
      mustConditions.push({
        key: "type",
        match: { value: options.type },
      });
    }

    const searchParams: {
      vector: number[];
      limit: number;
      with_payload: boolean;
      filter?: { must: Array<{ key: string; match: { value: string } }> };
    } = {
      vector: queryVector,
      limit: options.limit ?? 10,
      with_payload: true,
    };

    if (mustConditions.length > 0) {
      searchParams.filter = { must: mustConditions };
    }

    const results = await qdrantClient.search(collectionName, searchParams);

    return results.map((r) => {
      const payload = r.payload as Record<string, unknown> | null;
      return {
        chunkId: (payload?.chunkId as string) ?? "",
        projectId: (payload?.projectId as string) ?? "",
        filePath: (payload?.filePath as string) ?? "",
        type: (payload?.type as "code" | "comment" | "docstring") ?? "code",
        content: (payload?.content as string) ?? "",
        lineStart: payload?.lineStart as number | undefined,
        lineEnd: payload?.lineEnd as number | undefined,
        score: r.score,
      };
    });
  }

  /**
   * Delete all indexed chunks for a project.
   */
  async deleteProject(projectId: string): Promise<void> {
    const qdrantClient = this.qdrant.getClient();
    const collectionName = this.qdrant["config"]["collectionName"];

    await qdrantClient.delete(collectionName, {
      wait: true,
      filter: {
        must: [
          {
            key: "projectId",
            match: { value: projectId },
          },
        ],
      },
    });
  }

  private buildIndexPoints(result: IngestionResult) {
    const points: Array<{
      id: string;
      vector: number[];
      payload: Record<string, unknown>;
    }> = [];

    for (const fileResult of result.codeFiles) {
      for (const chunk of fileResult.chunks) {
        const vector = this.vectorizer.vectorize(chunk.content);

        // Convert SHA-256 hex to UUID format for Qdrant compatibility
        const uuidId = this.hexToUuid(chunk.chunkId);

        points.push({
          id: uuidId,
          vector,
          payload: {
            projectId: result.projectId,
            filePath: fileResult.filePath,
            chunkId: chunk.chunkId,
            sha256: fileResult.sha256,
            type: chunk.type,
            content: chunk.content,
            start: chunk.start,
            end: chunk.end,
            lineStart: chunk.lineStart,
            lineEnd: chunk.lineEnd,
            ingestedAt: result.ingestedAt,
          },
        });
      }
    }

    return points;
  }

  /**
   * Convert SHA-256 hex string to UUID format for Qdrant point IDs.
   * Takes first 32 hex chars and formats as UUID.
   */
  private hexToUuid(hex: string): string {
    const h = hex.substring(0, 32);
    return `${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20, 32)}`;
  }
}
