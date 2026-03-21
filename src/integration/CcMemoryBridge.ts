/**
 * CcMemoryBridge — Integration layer for cc-memory/cc-connect enrichment
 *
 * Three responsibilities:
 * 1. Write-through enrichment: on context_save with decision/outcome/learning,
 *    extract entities (project, technology, pattern) and create graph relationships
 * 2. Cross-project search: query all ingested project contexts, not just current session
 * 3. Learnings propagation: auto-index tagged learnings so other projects can find them
 *
 * Note: This file does NOT use child_process or any shell commands.
 *
 * @module integration/CcMemoryBridge
 */

import { createLogger } from "../util/logger.js";
import type { KnowledgeStore, KnowledgeSearchResult } from "../knowledge/KnowledgeStore.js";
import type { EventStore } from "../storage/EventStore.js";

const log = createLogger("CcMemoryBridge");

// ============================================================================
// Types
// ============================================================================

/** Categories that trigger write-through enrichment */
const ENRICHMENT_CATEGORIES = new Set([
  "decision",
  "fact",
  "observation",
]);

/** Entity extracted from memory content */
export interface ExtractedEntity {
  name: string;
  type: "project" | "technology" | "pattern" | "concept" | "tool";
  confidence: number;
}

/** Relationship between two entities */
export interface EntityRelationship {
  source: string;
  target: string;
  type: "uses" | "depends_on" | "related_to" | "implements" | "learned_from";
}

/** Result of write-through enrichment */
export interface EnrichmentResult {
  entities: ExtractedEntity[];
  relationships: EntityRelationship[];
  crossProjectMatches: CrossProjectMatch[];
  propagatedTo: string[];
}

/** Cross-project match found during enrichment */
export interface CrossProjectMatch {
  projectId: string;
  title: string;
  relevanceScore: number;
}

/** Propagated learning record */
export interface PropagatedLearning {
  sourceProject: string;
  targetProject: string;
  learning: string;
  tags: string[];
  relevanceScore: number;
  propagatedAt: string;
}

/** Options for cross-project search */
export interface CrossProjectSearchOptions {
  /** Maximum results per project */
  limit?: number;
  /** Minimum relevance score threshold */
  minRelevance?: number;
  /** Filter by tags */
  tags?: string[];
}

// ============================================================================
// Entity Extraction (regex-based, no LLM dependency)
// ============================================================================

/** Technology keywords for extraction */
const TECHNOLOGY_PATTERNS = [
  /\b(TypeScript|JavaScript|Python|Rust|Go|Java|Ruby|Swift|Kotlin)\b/gi,
  /\b(React|Vue|Angular|Svelte|Nuxt|Remix|Astro)\b/gi,
  /\b(Deno|Bun|Hono|Fastify|NestJS)\b/gi,
  /\b(PostgreSQL|MySQL|SQLite|MongoDB|Redis|Qdrant|Neo4j|Supabase)\b/gi,
  /\b(Docker|Kubernetes|AWS|GCP|Azure|Vercel|Cloudflare)\b/gi,
  /\b(GraphQL|REST|gRPC|WebSocket|SSE|MCP)\b/gi,
  /\b(OAuth|JWT|CORS|CSRF|TLS|mTLS)\b/gi,
];

/** Pattern keywords */
const PATTERN_KEYWORDS = [
  /\b(singleton|factory|observer|strategy|adapter|proxy|facade|decorator|builder)\b/gi,
  /\b(circuit.?breaker|retry|backoff|rate.?limit|throttl|cache|queue|pub.?sub)\b/gi,
  /\b(blue.?green|canary|rolling.?update|feature.?flag)\b/gi,
  /\b(event.?sourc|CQRS|saga|outbox|dead.?letter)\b/gi,
];

/** Project name pattern: looks like "project-name" or "projectName" in context */
const PROJECT_NAME_PATTERN = /\b(?:project|repo|codebase|in)\s+[`"']?([a-z][a-z0-9_-]{2,30})[`"']?\b/gi;

// ============================================================================
// CcMemoryBridge
// ============================================================================

export class CcMemoryBridge {
  private readonly knowledgeStore: KnowledgeStore;
  private readonly eventStore: EventStore;

  constructor(options: {
    knowledgeStore: KnowledgeStore;
    eventStore: EventStore;
  }) {
    this.knowledgeStore = options.knowledgeStore;
    this.eventStore = options.eventStore;
  }

  /**
   * Write-through enrichment hook — called after context_save for enrichable categories.
   * Extracts entities, finds cross-project matches, and propagates learnings.
   */
  enrich(
    key: string,
    value: string,
    category: string | undefined,
    projectId: string,
    tags?: string[],
  ): EnrichmentResult {
    // Only enrich certain categories
    if (category && !ENRICHMENT_CATEGORIES.has(category)) {
      return { entities: [], relationships: [], crossProjectMatches: [], propagatedTo: [] };
    }

    // 1. Extract entities from content
    const entities = this.extractEntities(value);

    // 2. Build relationships between entities
    const relationships = this.buildRelationships(entities, projectId);

    // 3. Find cross-project matches
    const crossProjectMatches = this.findCrossProjectMatches(value, projectId);

    // 4. Propagate learnings if tagged
    const propagatedTo = this.propagateLearning(key, value, projectId, tags ?? []);

    if (entities.length > 0 || crossProjectMatches.length > 0) {
      log.info("Enrichment complete", {
        key,
        entities: entities.length,
        relationships: relationships.length,
        crossProjectMatches: crossProjectMatches.length,
        propagatedTo: propagatedTo.length,
      });
    }

    return { entities, relationships, crossProjectMatches, propagatedTo };
  }

  /**
   * Search across all projects' knowledge entries.
   * Unlike session-scoped search, this queries all ingested project contexts.
   */
  searchAcrossProjects(
    query: string,
    options: CrossProjectSearchOptions = {},
  ): KnowledgeSearchResult[] {
    const limit = options.limit ?? 20;
    const minRelevance = options.minRelevance ?? 0.0;

    const searchOpts: import("../knowledge/KnowledgeStore.js").KnowledgeSearchOptions = {
      query,
      crossProject: true,
      limit,
    };
    if (options.tags !== undefined) {
      searchOpts.tags = options.tags;
    }
    const results = this.knowledgeStore.search(searchOpts);

    // Filter by minimum relevance (rank is negative BM25, lower = more relevant)
    return results.filter((r) => {
      const normalizedScore = Math.abs(r.rank);
      return normalizedScore >= minRelevance;
    });
  }

  /**
   * Get all propagated learnings for a target project.
   */
  getPropagatedLearnings(targetProject: string): PropagatedLearning[] {
    const results = this.knowledgeStore.search({
      query: `propagated-from`,
      projectId: targetProject,
      limit: 50,
    });

    return results
      .filter((r) => {
        const tags = r.entry.tags;
        return tags.some((t) => t.startsWith("propagated-from:"));
      })
      .map((r) => {
        const sourceTag = r.entry.tags.find((t) => t.startsWith("propagated-from:"));
        const sourceProject = sourceTag?.replace("propagated-from:", "") ?? "unknown";
        return {
          sourceProject,
          targetProject,
          learning: r.entry.solution,
          tags: r.entry.tags,
          relevanceScore: Math.abs(r.rank),
          propagatedAt: r.entry.createdAt,
        };
      });
  }

  /**
   * Extract entities from text content using regex patterns.
   */
  extractEntities(content: string): ExtractedEntity[] {
    const entities: ExtractedEntity[] = [];
    const seen = new Set<string>();

    // Extract technologies
    for (const pattern of TECHNOLOGY_PATTERNS) {
      // Reset regex state
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1] ?? match[0];
        const key = `technology:${name.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          entities.push({ name, type: "technology", confidence: 0.9 });
        }
      }
    }

    // Extract patterns
    for (const pattern of PATTERN_KEYWORDS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1] ?? match[0];
        const key = `pattern:${name.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          entities.push({ name, type: "pattern", confidence: 0.8 });
        }
      }
    }

    // Extract project names
    PROJECT_NAME_PATTERN.lastIndex = 0;
    let projMatch: RegExpExecArray | null;
    while ((projMatch = PROJECT_NAME_PATTERN.exec(content)) !== null) {
      const name = projMatch[1]!;
      const key = `project:${name.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        entities.push({ name, type: "project", confidence: 0.7 });
      }
    }

    return entities;
  }

  /**
   * Build relationships between extracted entities and the source project.
   */
  private buildRelationships(
    entities: ExtractedEntity[],
    sourceProject: string,
  ): EntityRelationship[] {
    const relationships: EntityRelationship[] = [];

    for (const entity of entities) {
      if (entity.type === "technology") {
        relationships.push({
          source: sourceProject,
          target: entity.name,
          type: "uses",
        });
      } else if (entity.type === "pattern") {
        relationships.push({
          source: sourceProject,
          target: entity.name,
          type: "implements",
        });
      } else if (entity.type === "project" && entity.name !== sourceProject) {
        relationships.push({
          source: sourceProject,
          target: entity.name,
          type: "related_to",
        });
      }
    }

    return relationships;
  }

  /**
   * Find cross-project knowledge matches for the given content.
   */
  private findCrossProjectMatches(
    content: string,
    excludeProject: string,
  ): CrossProjectMatch[] {
    // Extract a search query from the content (first 200 chars, cleaned)
    const queryText = content
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);

    if (queryText.length < 10) {
      return [];
    }

    const results = this.knowledgeStore.search({
      query: queryText,
      crossProject: true,
      limit: 10,
    });

    return results
      .filter((r) => r.entry.projectId !== excludeProject)
      .map((r) => ({
        projectId: r.entry.projectId,
        title: r.entry.title,
        relevanceScore: Math.abs(r.rank),
      }))
      .slice(0, 5);
  }

  /**
   * Propagate a learning to other projects that might benefit.
   * Creates knowledge entries in target projects tagged with source.
   */
  private propagateLearning(
    key: string,
    value: string,
    sourceProject: string,
    tags: string[],
  ): string[] {
    // Only propagate entries that have tags (indicates structured learning)
    if (tags.length === 0) {
      return [];
    }

    // Search for related projects
    const matches = this.findCrossProjectMatches(value, sourceProject);

    // Only propagate to projects with high relevance
    const propagatedTo: string[] = [];
    for (const match of matches) {
      if (match.relevanceScore < 0.5) {
        continue;
      }

      // Create propagated learning entry in target project
      try {
        this.knowledgeStore.ingest({
          projectId: match.projectId,
          title: `[Propagated] ${key}`,
          solution: value,
          tags: [
            ...tags,
            `propagated-from:${sourceProject}`,
            "cross-project",
          ],
        });
        propagatedTo.push(match.projectId);
      } catch (error) {
        log.warn("Failed to propagate learning", {
          source: sourceProject,
          target: match.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return propagatedTo;
  }

  // ==========================================================================
  // Native Memory Export (Issue #58)
  // ==========================================================================

  /**
   * Export high-relevance memories to Claude Code native memory files.
   * Writes markdown files grouped by category to the specified directory.
   *
   * @returns Number of memories exported
   */
  async exportToNativeMemory(options: {
    topicsDir: string;
    eventStore: EventStore;
    minRelevance?: number;
    limit?: number;
  }): Promise<number> {
    const { topicsDir, eventStore, minRelevance = 0.7, limit = 100 } = options;
    const db = eventStore.getDatabase();

    // Ensure directory exists
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.mkdirSync(topicsDir, { recursive: true });

    // Query high-relevance memories
    type MemoryRow = { memory_id: string; score: number; payload: string };
    const rows = db.prepare(
      `SELECT mr.memory_id, mr.score, e.payload
       FROM memory_relevance mr
       JOIN events e ON e.event_type = 'CONTEXT_SAVED'
         AND json_extract(e.payload, '$.memoryId') = mr.memory_id
       WHERE mr.score >= ?
       ORDER BY mr.score DESC
       LIMIT ?`
    ).all(minRelevance, limit) as MemoryRow[];

    if (rows.length === 0) {
      return 0;
    }

    // Group by category
    const grouped = new Map<string, Array<{ key: string; value: string; score: number }>>();
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        const category = (payload.category as string) ?? "general";
        const key = (payload.key as string) ?? row.memory_id;
        const value = (payload.value as string) ?? "";

        const group = grouped.get(category);
        if (group) {
          group.push({ key, value, score: row.score });
        } else {
          grouped.set(category, [{ key, value, score: row.score }]);
        }
      } catch {
        // Skip unparseable payloads
      }
    }

    // Write one markdown file per category
    let exportedCount = 0;
    const now = new Date().toISOString().split("T")[0];

    for (const [category, memories] of grouped) {
      const fileName = `ping-mem-${category}.md`;
      const filePath = path.join(topicsDir, fileName);

      const lines: string[] = [
        "---",
        `name: ping-mem ${category} memories`,
        `type: ${category}`,
        `exported: ${now}`,
        `count: ${memories.length}`,
        "---",
        "",
      ];

      for (const mem of memories) {
        lines.push(`## ${mem.key}`);
        lines.push("");
        lines.push(mem.value);
        lines.push("");
        lines.push(`_Relevance: ${Math.round(mem.score * 100)}%_`);
        lines.push("");
      }

      fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
      exportedCount += memories.length;
    }

    log.info("Native memory export complete", {
      categories: grouped.size,
      totalExported: exportedCount,
      dir: topicsDir,
    });

    return exportedCount;
  }
}
