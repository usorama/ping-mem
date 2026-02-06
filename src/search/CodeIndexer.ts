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
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
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
            // Don't store full content in Qdrant to avoid oversized payloads
            // Content is stored in Neo4j and can be retrieved from files
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
   * Creates a valid UUID v5 (namespace-based) using SHA-256 hash.
   */
  private hexToUuid(hex: string): string {
    // SHA-256 produces 64 hex chars. We need 32 hex chars for UUID.
    // Use first 32 chars and format as UUID v5 (name-based)
    // UUID v5 format: xxxxxxxx-xxxx-5xxx-yxxx-xxxxxxxxxxxx
    // where x is random and y is one of 8, 9, a, b (version 5, variant 1)

    // Take first 32 hex chars from SHA-256
    const h = hex.substring(0, 32);

    // Set version to 5 (name-based UUID with SHA-256)
    // The 13th character (index 12) should be 5 for version 5
    // The 17th character (index 16) should be one of 8, 9, a, b (variant 1)
    const chars = h.split('');

    // Set version bits (13th char = '5' for UUID v5)
    chars[12] = '5';

    // Set variant bits (17th char = one of '8', '9', 'a', 'b')
    const variantByte = chars[16] ?? '0';
    const variantChar =
      variantByte <= '7' ? '8' :
      variantByte <= '9' ? '9' :
      variantByte <= 'b' ? 'a' : 'b';
    chars[16] = variantChar;

    const modified = chars.join('');
    return `${modified.substring(0, 8)}-${modified.substring(8, 12)}-${modified.substring(12, 16)}-${modified.substring(16, 20)}-${modified.substring(20, 32)}`;
  }
}
