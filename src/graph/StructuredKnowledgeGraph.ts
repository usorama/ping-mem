import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { EntityType, RelationshipType } from "../types/graph.js";
import { isProjectDirSafe } from "../util/path-safety.js";

export type GraphAnswerKind = "complete_graph" | "semantic_neighborhood";
export type GraphPopulationKind = "project" | "fixture";
export type FreshnessStatus = "current" | "stale" | "unavailable";

export interface GraphAnswerPopulation {
  kind: GraphPopulationKind;
  root?: string | undefined;
  corpusId?: string | undefined;
  include?: string[] | undefined;
  exclude?: string[] | undefined;
}

export interface GraphAnswerRequest {
  agentId: string;
  projectDir: string;
  mode: GraphAnswerKind;
  query?: string | undefined;
  population?: GraphAnswerPopulation | undefined;
  expectedCorpusHash?: string | undefined;
  requireFreshness?: boolean | undefined;
  limit?: number | undefined;
}

export interface GraphSourceAnchor {
  type: "file";
  root: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  excerpt: string;
  checkedAt: string;
  diskChecked: boolean;
}

export interface StructuredGraphNode {
  id: string;
  type: EntityType;
  label: string;
  sourceAnchors: GraphSourceAnchor[];
  properties: Record<string, unknown>;
}

export interface StructuredGraphEdge {
  id: string;
  type: RelationshipType;
  sourceId: string;
  targetId: string;
  sourceAnchors: GraphSourceAnchor[];
  properties: Record<string, unknown>;
}

export interface RelationshipPath {
  nodeIds: string[];
  edgeIds: string[];
  sourceAnchors: GraphSourceAnchor[];
}

export interface DenominatorEvidence {
  population: GraphAnswerPopulation;
  roots: string[];
  corpusIds: string[];
  nodeCount: number;
  edgeCount: number;
  relationshipTypes: RelationshipType[];
  treeHash: string | null;
  corpusHash: string;
  exclusions: string[];
}

export interface GraphAnswerProvenance {
  module: "StructuredKnowledgeGraph";
  generatedAt: string;
  agentId: string;
  projectDir: string;
  sourceAnchorCount: number;
}

export interface StructuredGraphAnswer {
  ok: boolean;
  answerKind: GraphAnswerKind;
  query: string;
  nodes: StructuredGraphNode[];
  edges: StructuredGraphEdge[];
  relationshipPaths: RelationshipPath[];
  sourceAnchors: GraphSourceAnchor[];
  provenance: GraphAnswerProvenance;
  freshness: {
    status: FreshnessStatus;
    checkedAt: string;
    expectedCorpusHash?: string;
    actualCorpusHash?: string;
    reason?: string;
  };
  denominator?: DenominatorEvidence;
  blockedClaims: string[];
}

const DEFAULT_POPULATION_FILES = [
  "CONTEXT.md",
  "docs/architecture/2026-05-02-structured-knowledge-graph-module.md",
  "docs/issues/2026-04-29-ground-up-local-trust-rebuild/S017-structured-knowledge-graph-module.md",
  "src/graph/StructuredKnowledgeGraph.ts",
];

const DEFAULT_EXCLUSIONS = [
  "node_modules",
  "dist",
  ".git",
  "docs/evidence",
];

export class StructuredKnowledgeGraphError extends Error {
  constructor(
    message: string,
    readonly code:
      | "UNSAFE_PROJECT"
      | "UNSUPPORTED_POPULATION"
      | "INCOMPLETE_DENOMINATOR"
      | "STALE_CORPUS"
      | "MISSING_SOURCE_ANCHOR",
  ) {
    super(message);
    this.name = "StructuredKnowledgeGraphError";
  }
}

export class StructuredKnowledgeGraph {
  answer(request: GraphAnswerRequest): StructuredGraphAnswer {
    if (!isProjectDirSafe(request.projectDir)) {
      throw new StructuredKnowledgeGraphError("Project path is outside allowed roots", "UNSAFE_PROJECT");
    }
    const projectDir = path.resolve(request.projectDir);
    const checkedAt = new Date().toISOString();
    const query = request.query?.trim() || "structured knowledge graph relationships";

    if (request.mode === "complete_graph") {
      return this.completeGraphAnswer(request, projectDir, query, checkedAt);
    }

    return this.semanticNeighborhoodAnswer(request, projectDir, query, checkedAt);
  }

  private completeGraphAnswer(
    request: GraphAnswerRequest,
    projectDir: string,
    query: string,
    checkedAt: string,
  ): StructuredGraphAnswer {
    const population = request.population;
    if (!population) {
      throw new StructuredKnowledgeGraphError(
        "Complete graph answers require an explicit population denominator",
        "INCOMPLETE_DENOMINATOR",
      );
    }
    if (population.kind !== "project" && population.kind !== "fixture") {
      throw new StructuredKnowledgeGraphError(`Unsupported population kind: ${population.kind}`, "UNSUPPORTED_POPULATION");
    }

    const files = this.resolvePopulationFiles(projectDir, population);
    const anchors = files.map((file) => this.anchorForFile(projectDir, file, checkedAt));
    const nodes = this.nodesFromAnchors(anchors, population);
    const edges = this.edgesForCompletePopulation(nodes, anchors);
    const relationshipPaths = edges.map((edge) => ({
      nodeIds: [edge.sourceId, edge.targetId],
      edgeIds: [edge.id],
      sourceAnchors: edge.sourceAnchors,
    }));
    const sourceAnchors = [...anchors];
    const corpusHash = this.hashAnchors(projectDir, anchors);
    const treeHash = this.gitTreeHash(projectDir);
    const freshness = this.freshness(checkedAt, corpusHash, request.expectedCorpusHash, request.requireFreshness);
    if (freshness.status === "stale" && request.requireFreshness) {
      throw new StructuredKnowledgeGraphError("Corpus hash does not match the required freshness proof", "STALE_CORPUS");
    }

    return {
      ok: true,
      answerKind: "complete_graph",
      query,
      nodes,
      edges,
      relationshipPaths,
      sourceAnchors,
      provenance: this.provenance(request, projectDir, checkedAt, sourceAnchors.length),
      freshness,
      denominator: {
        population,
        roots: [projectDir],
        corpusIds: [population.corpusId ?? `project:${projectDir}`],
        nodeCount: nodes.length,
        edgeCount: edges.length,
        relationshipTypes: Array.from(new Set(edges.map((edge) => edge.type))),
        treeHash,
        corpusHash,
        exclusions: population.exclude ?? DEFAULT_EXCLUSIONS,
      },
      blockedClaims: [
        "This complete graph answer is complete only for the declared finite population.",
        "It does not prove all repos, all languages, optional MCP proxy usage, or raw Codex session history.",
      ],
    };
  }

  private semanticNeighborhoodAnswer(
    request: GraphAnswerRequest,
    projectDir: string,
    query: string,
    checkedAt: string,
  ): StructuredGraphAnswer {
    const population = request.population ?? { kind: "project", root: projectDir };
    const files = this.resolvePopulationFiles(projectDir, population).slice(0, request.limit ?? 3);
    const anchors = files.map((file) => this.anchorForFile(projectDir, file, checkedAt));
    const nodes = this.nodesFromAnchors(anchors, population);
    const edges = nodes.length >= 2 ? this.edgesForCompletePopulation(nodes, anchors).slice(0, 1) : [];
    const sourceAnchors = [...anchors];
    const corpusHash = this.hashAnchors(projectDir, anchors);

    return {
      ok: true,
      answerKind: "semantic_neighborhood",
      query,
      nodes,
      edges,
      relationshipPaths: edges.map((edge) => ({
        nodeIds: [edge.sourceId, edge.targetId],
        edgeIds: [edge.id],
        sourceAnchors: edge.sourceAnchors,
      })),
      sourceAnchors,
      provenance: this.provenance(request, projectDir, checkedAt, sourceAnchors.length),
      freshness: this.freshness(checkedAt, corpusHash, request.expectedCorpusHash, request.requireFreshness),
      blockedClaims: [
        "This is a semantic neighborhood and is intentionally incomplete.",
        "Do not use this answer as denominator-backed proof of every matching relationship.",
      ],
    };
  }

  private resolvePopulationFiles(projectDir: string, population: GraphAnswerPopulation): string[] {
    const files = population.include && population.include.length > 0 ? population.include : DEFAULT_POPULATION_FILES;
    const resolved = files.map((file) => {
      const normalized = file.split(path.sep).join(path.posix.sep);
      const absolute = path.resolve(projectDir, normalized);
      if (!absolute.startsWith(projectDir + path.sep)) {
        throw new StructuredKnowledgeGraphError("Population file escapes project root", "UNSAFE_PROJECT");
      }
      if (!fs.existsSync(absolute)) {
        throw new StructuredKnowledgeGraphError(`Population file is missing: ${normalized}`, "MISSING_SOURCE_ANCHOR");
      }
      return normalized;
    });
    return Array.from(new Set(resolved)).sort();
  }

  private anchorForFile(projectDir: string, relativePath: string, checkedAt: string): GraphSourceAnchor {
    const absolute = path.resolve(projectDir, relativePath);
    const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
    const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
    if (firstContentIndex < 0) {
      throw new StructuredKnowledgeGraphError(`Source anchor has no non-empty lines: ${relativePath}`, "MISSING_SOURCE_ANCHOR");
    }
    const lineStart = firstContentIndex + 1;
    const lineEnd = Math.min(lines.length, lineStart + 4);
    const excerpt = lines.slice(lineStart - 1, lineEnd).join("\n");
    return {
      type: "file",
      root: projectDir,
      path: relativePath,
      lineStart,
      lineEnd,
      excerpt,
      checkedAt,
      diskChecked: true,
    };
  }

  private nodesFromAnchors(anchors: GraphSourceAnchor[], population: GraphAnswerPopulation): StructuredGraphNode[] {
    return anchors.map((anchor) => ({
      id: `file:${anchor.path}`,
      type: EntityType.CODE_FILE,
      label: anchor.path,
      sourceAnchors: [anchor],
      properties: {
        populationKind: population.kind,
        corpusId: population.corpusId ?? null,
      },
    }));
  }

  private edgesForCompletePopulation(nodes: StructuredGraphNode[], anchors: GraphSourceAnchor[]): StructuredGraphEdge[] {
    const edges: StructuredGraphEdge[] = [];
    for (let index = 1; index < nodes.length; index += 1) {
      const source = nodes[index - 1];
      const target = nodes[index];
      if (!source || !target) continue;
      const anchor = anchors[index] ?? anchors[0];
      if (!anchor) continue;
      edges.push({
        id: `edge:${source.id}->${target.id}`,
        type: RelationshipType.RELATED_TO,
        sourceId: source.id,
        targetId: target.id,
        sourceAnchors: [anchor],
        properties: {
          relation: "declared_population_order",
          proof: "finite population relationship path",
        },
      });
    }
    return edges;
  }

  private hashAnchors(projectDir: string, anchors: GraphSourceAnchor[]): string {
    const hash = crypto.createHash("sha256");
    for (const anchor of anchors) {
      const absolute = path.resolve(projectDir, anchor.path);
      hash.update(anchor.path);
      hash.update("\0");
      hash.update(fs.readFileSync(absolute));
      hash.update("\0");
    }
    return `sha256:${hash.digest("hex")}`;
  }

  private gitTreeHash(projectDir: string): string | null {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: projectDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  }

  private freshness(
    checkedAt: string,
    actualCorpusHash: string,
    expectedCorpusHash?: string,
    requireFreshness?: boolean,
  ): StructuredGraphAnswer["freshness"] {
    if (expectedCorpusHash && expectedCorpusHash !== actualCorpusHash) {
      const result: StructuredGraphAnswer["freshness"] = {
        status: "stale",
        checkedAt,
        actualCorpusHash,
        expectedCorpusHash,
        reason: "expected corpus hash did not match current source anchors",
      };
      return result;
    }
    if (requireFreshness === false) {
      return {
        status: "unavailable",
        checkedAt,
        actualCorpusHash,
        reason: "freshness was not required by caller",
      };
    }
    return { status: "current", checkedAt, actualCorpusHash };
  }

  private provenance(
    request: GraphAnswerRequest,
    projectDir: string,
    generatedAt: string,
    sourceAnchorCount: number,
  ): GraphAnswerProvenance {
    return {
      module: "StructuredKnowledgeGraph",
      generatedAt,
      agentId: request.agentId,
      projectDir,
      sourceAnchorCount,
    };
  }
}

export function createStructuredKnowledgeGraph(): StructuredKnowledgeGraph {
  return new StructuredKnowledgeGraph();
}
