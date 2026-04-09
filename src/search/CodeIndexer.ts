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
import { BM25Scorer } from "./BM25Scorer.js";
import type { CodeChunkStore } from "./CodeChunkStore.js";
import { createLogger } from "../util/logger.js";
import { sanitizeHealthError } from "../observability/health-probes.js";
import type { IngestionResult, CodeFileResult, ChunkWithId } from "../ingest/index.js";

const log = createLogger("CodeIndexer");

/** Hybrid mode weights: BM25 * 0.6 + dense * 0.4 */
const BM25_WEIGHT = 0.6;
const DENSE_WEIGHT = 0.4;

/** RRF constant (k parameter) — used for RRF fallback and Qdrant-only mode */
const RRF_K = 60;

export interface CodeIndexerOptions {
  qdrantClient: QdrantClientWrapper;
  vectorizer?: DeterministicVectorizer;
  codeChunkStore?: CodeChunkStore;
  /** BM25Scorer instance for primary ranking. */
  bm25Scorer?: BM25Scorer;
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
  private readonly codeChunkStore: CodeChunkStore | undefined;
  private readonly bm25Scorer: BM25Scorer | undefined;

  constructor(options: CodeIndexerOptions) {
    this.qdrant = options.qdrantClient;
    this.vectorizer = options.vectorizer ?? new DeterministicVectorizer();
    this.codeChunkStore = options.codeChunkStore;
    this.bm25Scorer = options.bm25Scorer;
  }

  /**
   * Index all chunks from an ingestion result.
   * Idempotent: can be called multiple times for the same chunkId.
   */
  async indexIngestion(result: IngestionResult): Promise<void> {
    // Index into BM25Scorer inverted index
    if (this.bm25Scorer) {
      const docs: Array<{ chunkId: string; content: string }> = [];
      for (const fileResult of result.codeFiles) {
        for (const chunk of fileResult.chunks) {
          docs.push({ chunkId: chunk.chunkId, content: chunk.content });
        }
      }
      if (docs.length > 0) {
        this.bm25Scorer.indexDocumentsBatch(docs);
      }
    }

    const points = this.buildIndexPoints(result);

    if (points.length > 0) {
      const qdrantClient = this.qdrant.getClient();
      const collectionName = this.qdrant.getCollectionName();

      // Batch upsert to avoid oversized requests (Qdrant 400 for large payloads)
      // Per-batch retry with 3 attempts (EVAL PERF-3 fix)
      const BATCH_SIZE = 200;
      for (let i = 0; i < points.length; i += BATCH_SIZE) {
        const batch = points.slice(i, i + BATCH_SIZE);
        const batchIndex = Math.floor(i / BATCH_SIZE);
        let lastErr: Error | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await qdrantClient.upsert(collectionName, {
              wait: true,
              points: batch.map((p) => ({
                id: p.id,
                vector: p.vector,
                payload: p.payload,
              })),
            });
            lastErr = undefined;
            break;
          } catch (error: unknown) {
            lastErr = error instanceof Error ? error : new Error(String(error));
            if (attempt < 2) {
              const delay = 2000 * Math.pow(2, attempt) + Math.random() * 1000;
              log.warn(`Qdrant upsert batch ${batchIndex} attempt ${attempt + 1} failed, retrying`, {
                error: sanitizeHealthError(lastErr),
              });
              await new Promise(r => setTimeout(r, delay));
            }
          }
        }
        if (lastErr) {
          throw new Error(
            `Qdrant upsert batch ${batchIndex} failed (points ${i}-${i + batch.length - 1} of ${points.length}): ${lastErr.message}`
          );
        }
      }
    }

    // Index into FTS5 CodeChunkStore if available
    if (this.codeChunkStore) {
      for (const fileResult of result.codeFiles) {
        for (const chunk of fileResult.chunks) {
          // Map chunk type to CodeChunkStore ChunkType
          const storeType = (chunk.type === "function" || chunk.type === "class" || chunk.type === "file" || chunk.type === "block")
            ? chunk.type
            : "block" as const;
          const codeChunk: import("./CodeChunkStore.js").CodeChunk = {
            chunkId: chunk.chunkId,
            projectId: result.projectId,
            filePath: fileResult.filePath,
            content: chunk.content,
            startLine: chunk.lineStart ?? chunk.start,
            endLine: chunk.lineEnd ?? chunk.end,
            chunkType: storeType,
          };
          if (fileResult.filePath.endsWith(".ts")) {
            codeChunk.language = "typescript";
          }
          this.codeChunkStore.addChunk(codeChunk);
        }
      }
    }
  }

  /**
   * Search for chunks by semantic/keyword similarity.
   *
   * When CodeChunkStore is configured, uses Reciprocal Rank Fusion (RRF)
   * to merge BM25 (FTS5) results with Qdrant vector results:
   *   score(d) = 1/(k + rank_bm25(d)) + 1/(k + rank_qdrant(d)), k=60
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
    // Strategy 1: BM25Scorer is the primary ranker
    if (this.bm25Scorer) {
      // BM25-only search (metadata from CodeChunkStore or Qdrant)
      const clampedLimit = Math.max(1, Math.min(Math.floor(options.limit ?? 10), 1000));
      const fetchLimit = Math.min(clampedLimit * 3, 300);
      const bm25Results = this.bm25Scorer.search(query, fetchLimit);
      let qdrantResults: ChunkSearchResult[] = [];
      try { qdrantResults = await this.searchQdrantOnly(query, { ...options, limit: fetchLimit }); } catch {}
      const metaLookup = new Map<string, ChunkSearchResult>();
      for (const r of qdrantResults) metaLookup.set(r.chunkId, r);
      if (this.codeChunkStore) {
        for (const r of this.codeChunkStore.search(query, options.projectId, fetchLimit)) {
          if (!metaLookup.has(r.chunkId)) {
            metaLookup.set(r.chunkId, { chunkId: r.chunkId, projectId: r.projectId, filePath: r.filePath, type: "code", content: r.content, lineStart: r.startLine, lineEnd: r.endLine, score: 0 });
          }
        }
      }
      if (qdrantResults.length > 0) {
        const bm25S = new Map(bm25Results.map(r => [r.chunkId, r.score]));
        const denseS = new Map(qdrantResults.map(r => [r.chunkId, r.score]));
        const bv = [...bm25S.values()]; const bMin = bv.length ? Math.min(...bv) : 0; const bRngRaw = (bv.length ? Math.max(...bv) : 0) - bMin; const bRng = bRngRaw || 1;
        const dv = [...denseS.values()]; const dMin = dv.length ? Math.min(...dv) : 0; const dRngRaw = (dv.length ? Math.max(...dv) : 0) - dMin; const dRng = dRngRaw || 1;
        const allIds = new Set([...bm25S.keys(), ...denseS.keys()]);
        const scored: Array<{ chunkId: string; score: number }> = [];
        for (const id of allIds) {
          const m = metaLookup.get(id); if (!m) continue;
          if (options.projectId && m.projectId !== options.projectId) continue;
          // When range is 0, all candidates tied — give full credit rather than collapsing to 0
          const bn = bm25S.has(id) ? (bRngRaw === 0 ? 1 : (bm25S.get(id)! - bMin) / bRng) : 0;
          const dn = denseS.has(id) ? (dRngRaw === 0 ? 1 : (denseS.get(id)! - dMin) / dRng) : 0;
          scored.push({ chunkId: id, score: bn * BM25_WEIGHT + dn * DENSE_WEIGHT });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, clampedLimit).map(s => ({ ...metaLookup.get(s.chunkId)!, score: s.score }));
      }
      const results: ChunkSearchResult[] = [];
      for (const bm25 of bm25Results) {
        const meta = metaLookup.get(bm25.chunkId); if (!meta) continue;
        if (options.projectId && meta.projectId !== options.projectId) continue;
        results.push({ ...meta, score: bm25.score });
        if (results.length >= clampedLimit) break;
      }
      return results;
    }

    // Strategy 2: CodeChunkStore FTS5 + Qdrant RRF (legacy)
    if (this.codeChunkStore) {
      return this.searchWithRRF(query, options);
    }

    // Strategy 3: Qdrant only (legacy fallback)
    return this.searchQdrantOnly(query, options);
  }

  private async searchWithRRF(
    query: string,
    options: {
      projectId?: string;
      filePath?: string;
      type?: "code" | "comment" | "docstring";
      limit?: number;
    },
  ): Promise<ChunkSearchResult[]> {
    const clampedLimit = Math.max(1, Math.min(Math.floor(options.limit ?? 10), 1000));
    // Fetch more candidates from each source for better fusion
    const fetchLimit = Math.min(clampedLimit * 3, 100);

    // Run BM25 and Qdrant in parallel
    const [bm25Results, qdrantResults] = await Promise.all([
      Promise.resolve(
        this.codeChunkStore!.search(query, options.projectId, fetchLimit),
      ),
      this.searchQdrantOnly(query, { ...options, limit: fetchLimit }).catch((err) => {
        log.warn("Qdrant search failed during RRF, using BM25 only", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [] as ChunkSearchResult[];
      }),
    ]);

    // Build rank maps (chunkId -> rank, 0-indexed)
    const bm25Ranks = new Map<string, number>();
    bm25Results.forEach((r, i) => bm25Ranks.set(r.chunkId, i));

    const qdrantRanks = new Map<string, number>();
    qdrantResults.forEach((r, i) => qdrantRanks.set(r.chunkId, i));

    // Collect all unique chunk IDs
    const allChunkIds = new Set([...bm25Ranks.keys(), ...qdrantRanks.keys()]);

    // Build result lookup
    const resultLookup = new Map<string, ChunkSearchResult>();
    for (const r of bm25Results) {
      resultLookup.set(r.chunkId, {
        chunkId: r.chunkId,
        projectId: r.projectId,
        filePath: r.filePath,
        type: "code",
        content: r.content,
        lineStart: r.startLine,
        lineEnd: r.endLine,
        score: 0,
      });
    }
    for (const r of qdrantResults) {
      if (!resultLookup.has(r.chunkId)) {
        resultLookup.set(r.chunkId, r);
      }
    }

    // RRF scoring
    const rrfScores: Array<{ chunkId: string; score: number }> = [];
    for (const chunkId of allChunkIds) {
      const bm25Rank = bm25Ranks.get(chunkId);
      const qdrantRank = qdrantRanks.get(chunkId);

      let score = 0;
      if (bm25Rank !== undefined) {
        score += 1 / (RRF_K + bm25Rank + 1);
      }
      if (qdrantRank !== undefined) {
        score += 1 / (RRF_K + qdrantRank + 1);
      }

      rrfScores.push({ chunkId, score });
    }

    // Sort by RRF score descending
    rrfScores.sort((a, b) => b.score - a.score);

    return rrfScores.slice(0, clampedLimit).map((s) => {
      const r = resultLookup.get(s.chunkId)!;
      return { ...r, score: s.score };
    });
  }

  private async searchQdrantOnly(
    query: string,
    options: {
      projectId?: string;
      filePath?: string;
      type?: "code" | "comment" | "docstring";
      limit?: number;
    },
  ): Promise<ChunkSearchResult[]> {
    const queryVector = this.vectorizer.vectorize(query);
    const qdrantClient = this.qdrant.getClient();
    const collectionName = this.qdrant.getCollectionName();

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

    const clampedLimit = Math.max(1, Math.min(Math.floor(options.limit ?? 10), 1000));

    const searchParams: {
      vector: number[];
      limit: number;
      with_payload: boolean;
      filter?: { must: Array<{ key: string; match: { value: string } }> };
    } = {
      vector: queryVector,
      limit: clampedLimit,
      with_payload: true,
    };

    if (mustConditions.length > 0) {
      searchParams.filter = { must: mustConditions };
    }

    let results: Awaited<ReturnType<typeof qdrantClient.search>>;
    try {
      results = await qdrantClient.search(collectionName, searchParams);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Qdrant search failed", { error: message, query: query.substring(0, 100) });
      throw new Error(`Code search failed: ${message}`);
    }

    return results
      .filter((r) => {
        // Filter out results with missing critical payload fields
        const payload = r.payload as Record<string, unknown> | null;
        return payload && typeof payload.chunkId === "string" && typeof payload.filePath === "string";
      })
      .map((r) => {
        const payload = r.payload as Record<string, unknown>;
        return {
          chunkId: payload.chunkId as string,
          projectId: (payload.projectId as string) ?? "",
          filePath: payload.filePath as string,
          type: (payload.type as "code" | "comment" | "docstring") ?? "code",
          content: (payload.content as string) ?? "",
          lineStart: payload.lineStart as number | undefined,
          lineEnd: payload.lineEnd as number | undefined,
          score: r.score,
        };
      });
  }

  /**
   * Delete all indexed chunks for a project.
   */
  async deleteProject(projectId: string): Promise<void> {
    const qdrantClient = this.qdrant.getClient();
    const collectionName = this.qdrant.getCollectionName();

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

    // Also clean up CodeChunkStore if available
    if (this.codeChunkStore) {
      this.codeChunkStore.removeProject(projectId);
    }
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
            content: chunk.content.substring(0, 2000),
            contentTruncated: chunk.content.length > 2000,
            contentFullLength: chunk.content.length,
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
