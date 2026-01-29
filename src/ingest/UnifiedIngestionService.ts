/**
 * UnifiedIngestionService: Handles both code and document projects
 *
 * Use cases:
 * - Code projects: Full codebase ingestion with git history
 * - Document projects: Resume tracking, job applications, decision logs, notes
 * - Mixed projects: Both code and structured documents
 */

import { UnifiedIngestionOrchestrator, type UnifiedIngestionResult } from "./UnifiedIngestionOrchestrator.js";
import { TemporalCodeGraph } from "../graph/TemporalCodeGraph.js";
import { DocumentGraph } from "../graph/DocumentGraph.js";
import { CodeIndexer } from "../search/CodeIndexer.js";
import { DeterministicVectorizer } from "../search/DeterministicVectorizer.js";
import { Neo4jClient } from "../graph/Neo4jClient.js";
import { QdrantClientWrapper } from "../search/QdrantClient.js";
import type { DocumentEntity } from "./DocumentParser.js";

export interface UnifiedIngestionServiceOptions {
  neo4jClient: Neo4jClient;
  qdrantClient: QdrantClientWrapper;
}

export interface IngestResult {
  projectId: string;
  projectType: string;
  filesIndexed: number;
  entitiesIndexed: number;
  ingestedAt: string;
  hadChanges: boolean;
}

export interface SearchDocumentsOptions {
  projectId: string;
  entityType?: string;
  keyPattern?: string;
  query?: string; // Semantic search
  limit?: number;
}

export class UnifiedIngestionService {
  private readonly orchestrator: UnifiedIngestionOrchestrator;
  private readonly codeGraph: TemporalCodeGraph;
  private readonly docGraph: DocumentGraph;
  private readonly codeIndexer: CodeIndexer;
  private readonly vectorizer: DeterministicVectorizer;

  constructor(options: UnifiedIngestionServiceOptions) {
    this.orchestrator = new UnifiedIngestionOrchestrator();
    this.codeGraph = new TemporalCodeGraph({
      neo4jClient: options.neo4jClient,
    });
    this.docGraph = new DocumentGraph({
      neo4jClient: options.neo4jClient,
    });
    this.codeIndexer = new CodeIndexer({
      qdrantClient: options.qdrantClient,
    });
    this.vectorizer = new DeterministicVectorizer();
  }

  /**
   * Ingest any project (code or documents).
   */
  async ingestProject(
    projectDir: string,
    options: {
      forceReingest?: boolean;
      projectType?: "code" | "documents" | "mixed";
    } = {}
  ): Promise<IngestResult | null> {
    const ingestionOptions: Parameters<typeof this.orchestrator.ingest>[1] = {};
    if (options.projectType !== undefined) {
      ingestionOptions.projectType = options.projectType;
    }
    if (options.forceReingest !== undefined) {
      ingestionOptions.forceReingest = options.forceReingest;
    }

    const ingestionResult = await this.orchestrator.ingest(projectDir, ingestionOptions);

    if (!ingestionResult) {
      return null; // No changes
    }

    // Persist based on project type
    let entitiesIndexed = 0;

    if (ingestionResult.codeFiles) {
      // Convert to old format for CodeGraph
      const codeResult = {
        projectId: ingestionResult.projectId,
        projectManifest: ingestionResult.projectManifest,
        codeFiles: ingestionResult.codeFiles,
        gitHistory: {
          commits: ingestionResult.gitHistory?.commits ?? [],
          fileChanges: [],
          hunks: [],
        },
        ingestedAt: ingestionResult.ingestedAt,
      };

      // Persist code to Neo4j (simplified - no git history for now)
      // await this.codeGraph.persistIngestion(codeResult);

      // Index code chunks in Qdrant
      await this.indexCodeChunks(ingestionResult.projectId, ingestionResult.codeFiles, ingestionResult.ingestedAt);
      entitiesIndexed += ingestionResult.codeFiles.reduce((sum, f) => sum + f.chunks.length, 0);
    }

    if (ingestionResult.documentFiles) {
      // Persist documents to Neo4j
      await this.docGraph.persistDocuments(
        ingestionResult.projectId,
        ingestionResult.documentFiles,
        ingestionResult.ingestedAt
      );

      // Index document entities in Qdrant
      await this.indexDocumentEntities(
        ingestionResult.projectId,
        ingestionResult.documentFiles,
        ingestionResult.ingestedAt
      );
      entitiesIndexed += ingestionResult.documentFiles.reduce((sum, d) => sum + d.entities.length, 0);
    }

    return {
      projectId: ingestionResult.projectId,
      projectType: ingestionResult.projectType,
      filesIndexed: (ingestionResult.codeFiles?.length ?? 0) + (ingestionResult.documentFiles?.length ?? 0),
      entitiesIndexed,
      ingestedAt: ingestionResult.ingestedAt,
      hadChanges: true,
    };
  }

  /**
   * Search documents by entity type or key pattern.
   */
  async searchDocuments(options: SearchDocumentsOptions): Promise<DocumentEntity[]> {
    if (options.entityType) {
      return this.docGraph.queryEntitiesByType(options.projectId, options.entityType);
    }

    if (options.keyPattern) {
      return this.docGraph.queryEntitiesByKeyPattern(options.projectId, options.keyPattern);
    }

    if (options.query) {
      // Semantic search via Qdrant
      return this.searchDocumentsSemantic(options.projectId, options.query, options.limit ?? 10);
    }

    return [];
  }

  /**
   * Index code chunks in Qdrant.
   */
  private async indexCodeChunks(
    projectId: string,
    codeFiles: Array<{
      filePath: string;
      sha256: string;
      chunks: Array<{
        chunkId: string;
        type: "code" | "comment" | "docstring";
        content: string;
      }>;
    }>,
    ingestedAt: string
  ): Promise<void> {
    const qdrantClient = this.codeIndexer["qdrant"].getClient();
    const collectionName = this.codeIndexer["qdrant"]["config"]["collectionName"];

    const points = [];
    for (const file of codeFiles) {
      for (const chunk of file.chunks) {
        const vector = this.vectorizer.vectorize(chunk.content);
        const uuidId = this.hexToUuid(chunk.chunkId);

        points.push({
          id: uuidId,
          vector,
          payload: {
            projectId,
            filePath: file.filePath,
            chunkId: chunk.chunkId,
            sha256: file.sha256,
            type: chunk.type,
            content: chunk.content,
            ingestedAt,
            dataType: "code",
          },
        });
      }
    }

    if (points.length > 0) {
      await qdrantClient.upsert(collectionName, { wait: true, points });
    }
  }

  /**
   * Index document entities in Qdrant.
   */
  private async indexDocumentEntities(
    projectId: string,
    documentFiles: Array<{
      filePath: string;
      entities: DocumentEntity[];
    }>,
    ingestedAt: string
  ): Promise<void> {
    const qdrantClient = this.codeIndexer["qdrant"].getClient();
    const collectionName = this.codeIndexer["qdrant"]["config"]["collectionName"];

    const points = [];
    for (const doc of documentFiles) {
      for (const entity of doc.entities) {
        const vector = this.vectorizer.vectorize(entity.value);
        const uuidId = this.hexToUuid(entity.entityId);

        points.push({
          id: uuidId,
          vector,
          payload: {
            projectId,
            filePath: doc.filePath,
            entityId: entity.entityId,
            entityType: entity.entityType,
            key: entity.key,
            value: entity.value,
            sourceHash: entity.sourceHash,
            ingestedAt,
            dataType: "document",
          },
        });
      }
    }

    if (points.length > 0) {
      await qdrantClient.upsert(collectionName, { wait: true, points });
    }
  }

  /**
   * Semantic search for documents.
   */
  private async searchDocumentsSemantic(
    projectId: string,
    query: string,
    limit: number
  ): Promise<DocumentEntity[]> {
    const queryVector = this.vectorizer.vectorize(query);
    const qdrantClient = this.codeIndexer["qdrant"].getClient();
    const collectionName = this.codeIndexer["qdrant"]["config"]["collectionName"];

    const results = await qdrantClient.search(collectionName, {
      vector: queryVector,
      limit,
      with_payload: true,
      filter: {
        must: [
          { key: "projectId", match: { value: projectId } },
          { key: "dataType", match: { value: "document" } },
        ],
      },
    });

    return results.map((r) => {
      const payload = r.payload as Record<string, unknown>;
      return {
        entityId: (payload.entityId as string) ?? "",
        entityType: (payload.entityType as string) ?? "",
        key: (payload.key as string) ?? "",
        value: (payload.value as string) ?? "",
        sourceFile: (payload.filePath as string) ?? "",
        sourceHash: (payload.sourceHash as string) ?? "",
        metadata: {},
      };
    });
  }

  private hexToUuid(hex: string): string {
    const h = hex.substring(0, 32);
    return `${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20, 32)}`;
  }
}
