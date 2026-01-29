/**
 * DocumentParser: Extract structured entities from various document types
 *
 * Supports:
 * - Markdown (.md): extract frontmatter + sections
 * - JSON (.json): structured data with schema detection
 * - Plain text (.txt): paragraph-based chunking
 * - YAML (.yaml/.yml): structured data
 *
 * For each document, extracts:
 * 1. Metadata (frontmatter, schema, etc.)
 * 2. Entities (key-value pairs, sections, structured data)
 * 3. Relationships (references between entities)
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export type DocumentType = "markdown" | "json" | "yaml" | "text" | "unknown";

export interface DocumentEntity {
  entityId: string; // Deterministic: SHA-256(documentPath + entityType + key + value)
  entityType: string; // e.g., "resume", "job_application", "decision", "note"
  key: string; // e.g., "experience.google", "application.meta.2024-01"
  value: string; // The actual content/data
  metadata: Record<string, unknown>; // Additional structured metadata
  sourceFile: string; // Relative path to source document
  sourceHash: string; // SHA-256 of source file content
  lineStart?: number; // Optional: line number in source
  lineEnd?: number;
}

export interface DocumentParseResult {
  documentPath: string;
  documentType: DocumentType;
  documentHash: string;
  entities: DocumentEntity[];
  metadata: Record<string, unknown>;
}

export class DocumentParser {
  /**
   * Parse a document and extract entities.
   */
  parseDocument(filePath: string, projectRoot: string): DocumentParseResult {
    const content = fs.readFileSync(filePath, "utf-8");
    const documentHash = crypto.createHash("sha256").update(content).digest("hex");
    const relativePath = this.normalizePath(path.relative(projectRoot, filePath));
    const ext = path.extname(filePath).toLowerCase();

    let documentType: DocumentType = "unknown";
    let entities: DocumentEntity[] = [];
    let metadata: Record<string, unknown> = {};

    if (ext === ".md") {
      documentType = "markdown";
      ({ entities, metadata } = this.parseMarkdown(relativePath, content, documentHash));
    } else if (ext === ".json") {
      documentType = "json";
      ({ entities, metadata } = this.parseJSON(relativePath, content, documentHash));
    } else if (ext === ".yaml" || ext === ".yml") {
      documentType = "yaml";
      ({ entities, metadata } = this.parseYAML(relativePath, content, documentHash));
    } else if (ext === ".txt") {
      documentType = "text";
      ({ entities, metadata } = this.parseText(relativePath, content, documentHash));
    }

    return {
      documentPath: relativePath,
      documentType,
      documentHash,
      entities,
      metadata,
    };
  }

  /**
   * Parse Markdown: extract frontmatter + sections as entities.
   */
  private parseMarkdown(
    filePath: string,
    content: string,
    fileHash: string
  ): { entities: DocumentEntity[]; metadata: Record<string, unknown> } {
    const entities: DocumentEntity[] = [];
    let metadata: Record<string, unknown> = {};

    // Extract frontmatter (YAML between --- delimiters)
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      try {
        metadata = this.parseYAMLString(frontmatterMatch[1]!);
      } catch {
        // Ignore invalid frontmatter
      }
    }

    // Extract sections (## headings)
    const lines = content.split("\n");
    let currentSection: string | null = null;
    let sectionContent: string[] = [];
    let sectionStartLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch) {
        // Save previous section
        if (currentSection && sectionContent.length > 0) {
          const value = sectionContent.join("\n").trim();
          if (value) {
            entities.push(
              this.createEntity(
                filePath,
                fileHash,
                "markdown_section",
                currentSection,
                value,
                { heading: currentSection },
                sectionStartLine,
                i - 1
              )
            );
          }
        }

        // Start new section
        currentSection = headingMatch[2]!.trim();
        sectionContent = [];
        sectionStartLine = i + 1;
      } else {
        sectionContent.push(line);
      }
    }

    // Save last section
    if (currentSection && sectionContent.length > 0) {
      const value = sectionContent.join("\n").trim();
      if (value) {
        entities.push(
          this.createEntity(
            filePath,
            fileHash,
            "markdown_section",
            currentSection,
            value,
            { heading: currentSection },
            sectionStartLine,
            lines.length - 1
          )
        );
      }
    }

    return { entities, metadata };
  }

  /**
   * Parse JSON: extract nested key-value pairs as entities.
   */
  private parseJSON(
    filePath: string,
    content: string,
    fileHash: string
  ): { entities: DocumentEntity[]; metadata: Record<string, unknown> } {
    const entities: DocumentEntity[] = [];
    let metadata: Record<string, unknown> = {};

    try {
      const data = JSON.parse(content);
      metadata = { schema: this.detectSchema(data) };

      // Flatten nested structure into entities
      this.extractJSONEntities(filePath, fileHash, data, "", entities);
    } catch (error) {
      // Invalid JSON, skip
    }

    return { entities, metadata };
  }

  /**
   * Parse YAML: similar to JSON.
   */
  private parseYAML(
    filePath: string,
    content: string,
    fileHash: string
  ): { entities: DocumentEntity[]; metadata: Record<string, unknown> } {
    const entities: DocumentEntity[] = [];
    let metadata: Record<string, unknown> = {};

    try {
      const data = this.parseYAMLString(content);
      metadata = { schema: this.detectSchema(data) };

      this.extractJSONEntities(filePath, fileHash, data, "", entities);
    } catch (error) {
      // Invalid YAML, skip
    }

    return { entities, metadata };
  }

  /**
   * Parse plain text: extract paragraphs as entities.
   */
  private parseText(
    filePath: string,
    content: string,
    fileHash: string
  ): { entities: DocumentEntity[]; metadata: Record<string, unknown> } {
    const entities: DocumentEntity[] = [];
    const paragraphs = content.split(/\n\n+/);

    let lineOffset = 0;
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (trimmed) {
        const lineCount = para.split("\n").length;
        entities.push(
          this.createEntity(
            filePath,
            fileHash,
            "text_paragraph",
            `paragraph_${lineOffset}`,
            trimmed,
            {},
            lineOffset,
            lineOffset + lineCount - 1
          )
        );
        lineOffset += lineCount + 1; // +1 for blank line
      }
    }

    return { entities, metadata: {} };
  }

  /**
   * Recursively extract entities from nested JSON/YAML objects.
   */
  private extractJSONEntities(
    filePath: string,
    fileHash: string,
    obj: unknown,
    prefix: string,
    entities: DocumentEntity[]
  ): void {
    if (obj === null || obj === undefined) {
      return;
    }

    if (typeof obj === "object" && !Array.isArray(obj)) {
      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;

        if (typeof value === "object" && value !== null) {
          // Recurse into nested objects
          this.extractJSONEntities(filePath, fileHash, value, fullKey, entities);
        } else {
          // Leaf value
          const strValue = String(value);
          entities.push(
            this.createEntity(
              filePath,
              fileHash,
              "structured_field",
              fullKey,
              strValue,
              { fieldType: typeof value }
            )
          );
        }
      }
    } else if (Array.isArray(obj)) {
      // Handle arrays
      obj.forEach((item, idx) => {
        const fullKey = `${prefix}[${idx}]`;
        if (typeof item === "object" && item !== null) {
          this.extractJSONEntities(filePath, fileHash, item, fullKey, entities);
        } else {
          const strValue = String(item);
          entities.push(
            this.createEntity(
              filePath,
              fileHash,
              "structured_field",
              fullKey,
              strValue,
              { arrayIndex: idx }
            )
          );
        }
      });
    }
  }

  /**
   * Create a deterministic entity.
   */
  private createEntity(
    filePath: string,
    fileHash: string,
    entityType: string,
    key: string,
    value: string,
    metadata: Record<string, unknown>,
    lineStart?: number,
    lineEnd?: number
  ): DocumentEntity {
    const hash = crypto.createHash("sha256");
    hash.update(filePath);
    hash.update("\n");
    hash.update(entityType);
    hash.update("\n");
    hash.update(key);
    hash.update("\n");
    hash.update(value);

    const entity: DocumentEntity = {
      entityId: hash.digest("hex"),
      entityType,
      key,
      value,
      metadata,
      sourceFile: filePath,
      sourceHash: fileHash,
    };

    if (lineStart !== undefined) {
      entity.lineStart = lineStart;
    }
    if (lineEnd !== undefined) {
      entity.lineEnd = lineEnd;
    }

    return entity;
  }

  /**
   * Simple YAML parser (subset: key-value pairs only).
   */
  private parseYAMLString(yaml: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = yaml.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const colonIdx = trimmed.indexOf(":");
      if (colonIdx > 0) {
        const key = trimmed.substring(0, colonIdx).trim();
        const value = trimmed.substring(colonIdx + 1).trim();

        // Remove quotes
        const cleanValue = value.replace(/^["']|["']$/g, "");
        result[key] = cleanValue;
      }
    }

    return result;
  }

  /**
   * Detect schema from JSON/YAML object.
   */
  private detectSchema(obj: unknown): string {
    if (typeof obj !== "object" || obj === null) {
      return "unknown";
    }

    const keys = Object.keys(obj);
    if (keys.includes("name") && keys.includes("experience")) {
      return "resume";
    }
    if (keys.includes("company") && keys.includes("position") && keys.includes("status")) {
      return "job_application";
    }
    if (keys.includes("decision") && keys.includes("rationale")) {
      return "decision_log";
    }

    return "generic";
  }

  private normalizePath(filePath: string): string {
    return filePath.split(path.sep).join(path.posix.sep);
  }
}
