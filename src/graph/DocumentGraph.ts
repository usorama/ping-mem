/**
 * DocumentGraph: Persist document entities to Neo4j
 *
 * Node types:
 * - Project { projectId, type: code|documents|mixed }
 * - Document { documentId, path, type, sha256 }
 * - Entity { entityId, entityType, key, value }
 *
 * Relationships:
 * - (Project)-[:HAS_DOCUMENT]->(Document)
 * - (Document)-[:CONTAINS_ENTITY]->(Entity)
 * - (Entity)-[:REFERENCES]->(Entity) [for cross-references]
 */

import { Neo4jClient } from "./Neo4jClient.js";
import type { DocumentEntity } from "../ingest/DocumentParser.js";
import * as crypto from "crypto";

export interface DocumentGraphOptions {
  neo4jClient: Neo4jClient;
}

export class DocumentGraph {
  private readonly neo4j: Neo4jClient;

  constructor(options: DocumentGraphOptions) {
    this.neo4j = options.neo4jClient;
  }

  /**
   * Persist document entities to Neo4j.
   */
  async persistDocuments(
    projectId: string,
    documents: Array<{
      filePath: string;
      sha256: string;
      documentType: string;
      entities: DocumentEntity[];
      metadata: Record<string, unknown>;
    }>,
    ingestedAt: string
  ): Promise<void> {
    const session = this.neo4j.getSession();
    try {
      // Create or update Project node
      await session.run(
        `
        MERGE (p:Project { projectId: $projectId })
        SET p.lastIngestedAt = $ingestedAt
        `,
        { projectId, ingestedAt }
      );

      // Persist each document
      for (const doc of documents) {
        await this.persistDocument(projectId, doc, ingestedAt);
      }
    } finally {
      await session.close();
    }
  }

  /**
   * Query entities by type.
   */
  async queryEntitiesByType(
    projectId: string,
    entityType: string
  ): Promise<DocumentEntity[]> {
    const session = this.neo4j.getSession();
    try {
      const result = await session.run(
        `
        MATCH (p:Project { projectId: $projectId })-[:HAS_DOCUMENT]->(d:Document)-[:CONTAINS_ENTITY]->(e:Entity { entityType: $entityType })
        RETURN e.entityId AS entityId,
               e.entityType AS entityType,
               e.key AS key,
               e.value AS value,
               e.sourceFile AS sourceFile,
               e.sourceHash AS sourceHash,
               e.metadata AS metadata
        ORDER BY e.key
        `,
        { projectId, entityType }
      );

      return result.records.map((r) => ({
        entityId: r.get("entityId") as string,
        entityType: r.get("entityType") as string,
        key: r.get("key") as string,
        value: r.get("value") as string,
        sourceFile: r.get("sourceFile") as string,
        sourceHash: r.get("sourceHash") as string,
        metadata: (r.get("metadata") as Record<string, unknown>) ?? {},
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Query entity by key pattern (e.g., "experience.*").
   */
  async queryEntitiesByKeyPattern(
    projectId: string,
    keyPattern: string
  ): Promise<DocumentEntity[]> {
    const session = this.neo4j.getSession();
    try {
      const result = await session.run(
        `
        MATCH (p:Project { projectId: $projectId })-[:HAS_DOCUMENT]->(d:Document)-[:CONTAINS_ENTITY]->(e:Entity)
        WHERE e.key =~ $pattern
        RETURN e.entityId AS entityId,
               e.entityType AS entityType,
               e.key AS key,
               e.value AS value,
               e.sourceFile AS sourceFile,
               e.sourceHash AS sourceHash,
               e.metadata AS metadata
        ORDER BY e.key
        `,
        { projectId, pattern: keyPattern.replace("*", ".*") }
      );

      return result.records.map((r) => ({
        entityId: r.get("entityId") as string,
        entityType: r.get("entityType") as string,
        key: r.get("key") as string,
        value: r.get("value") as string,
        sourceFile: r.get("sourceFile") as string,
        sourceHash: r.get("sourceHash") as string,
        metadata: (r.get("metadata") as Record<string, unknown>) ?? {},
      }));
    } finally {
      await session.close();
    }
  }

  private async persistDocument(
    projectId: string,
    doc: {
      filePath: string;
      sha256: string;
      documentType: string;
      entities: DocumentEntity[];
      metadata: Record<string, unknown>;
    },
    ingestedAt: string
  ): Promise<void> {
    const session = this.neo4j.getSession();
    try {
      const documentId = this.computeDocumentId(doc.filePath);

      // Create or update Document node
      await session.run(
        `
        MATCH (p:Project { projectId: $projectId })
        MERGE (d:Document { documentId: $documentId })
        SET d.path = $path,
            d.type = $documentType,
            d.sha256 = $sha256,
            d.metadataJson = $metadataJson,
            d.lastIngestedAt = $ingestedAt
        MERGE (p)-[:HAS_DOCUMENT { ingestedAt: $ingestedAt }]->(d)
        `,
        {
          projectId,
          documentId,
          path: doc.filePath,
          documentType: doc.documentType,
          sha256: doc.sha256,
          metadataJson: JSON.stringify(doc.metadata),
          ingestedAt,
        }
      );

      // Persist entities
      for (const entity of doc.entities) {
        await session.run(
          `
          MATCH (d:Document { documentId: $documentId })
          MERGE (e:Entity { entityId: $entityId })
          SET e.entityType = $entityType,
              e.key = $key,
              e.value = $value,
              e.sourceFile = $sourceFile,
              e.sourceHash = $sourceHash,
              e.metadataJson = $metadataJson,
              e.lastIngestedAt = $ingestedAt
          MERGE (d)-[:CONTAINS_ENTITY { ingestedAt: $ingestedAt }]->(e)
          `,
          {
            documentId,
            entityId: entity.entityId,
            entityType: entity.entityType,
            key: entity.key,
            value: entity.value,
            sourceFile: entity.sourceFile,
            sourceHash: entity.sourceHash,
            metadataJson: JSON.stringify(entity.metadata),
            ingestedAt,
          }
        );
      }
    } finally {
      await session.close();
    }
  }

  private computeDocumentId(filePath: string): string {
    return crypto.createHash("sha256").update(filePath).digest("hex");
  }
}
