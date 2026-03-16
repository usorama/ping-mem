/**
 * Structural intelligence tool handlers — impact analysis, blast radius, dependency map.
 *
 * Tools: codebase_impact, codebase_blast_radius, codebase_dependency_map
 *
 * @module mcp/handlers/StructuralToolModule
 */

import type { ToolDefinition, ToolModule } from "../types.js";
import type { SessionState } from "./shared.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("StructuralToolModule");

// ============================================================================
// Tool Schemas
// ============================================================================

export const STRUCTURAL_TOOLS: ToolDefinition[] = [
  {
    name: "codebase_impact",
    description:
      "Impact analysis: find all files that would be affected by changing the given file. " +
      "Traverses the reverse import graph to find upstream dependents. " +
      "Returns files sorted by distance (closest dependents first).",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description: "Project ID (from codebase_list_projects)",
        },
        filePath: {
          type: "string",
          description: "File path (relative to project root) to analyze impact for",
        },
        maxDepth: {
          type: "number",
          description: "Maximum traversal depth (default: 5, max: 10)",
        },
      },
      required: ["projectId", "filePath"],
    },
  },
  {
    name: "codebase_blast_radius",
    description:
      "Blast radius: find all files that are transitively depended upon by the given file. " +
      "Traverses the forward import graph to find all downstream dependencies.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description: "Project ID (from codebase_list_projects)",
        },
        filePath: {
          type: "string",
          description: "File path (relative to project root) to analyze",
        },
        maxDepth: {
          type: "number",
          description: "Maximum traversal depth (default: 5, max: 10)",
        },
      },
      required: ["projectId", "filePath"],
    },
  },
  {
    name: "codebase_dependency_map",
    description:
      "Full dependency map: return the import graph for a project as an adjacency list. " +
      "Shows which files import which other files, with symbol names.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description: "Project ID (from codebase_list_projects)",
        },
        includeExternal: {
          type: "boolean",
          description: "Include external (node_modules) dependencies (default: false)",
        },
      },
      required: ["projectId"],
    },
  },
];

// ============================================================================
// Module
// ============================================================================

export class StructuralToolModule implements ToolModule {
  readonly tools: ToolDefinition[] = STRUCTURAL_TOOLS;
  private readonly state: SessionState;

  constructor(state: SessionState) {
    this.state = state;
  }

  handle(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> | undefined {
    switch (name) {
      case "codebase_impact":
        return this.handleCodebaseImpact(args);
      case "codebase_blast_radius":
        return this.handleCodebaseBlastRadius(args);
      case "codebase_dependency_map":
        return this.handleCodebaseDependencyMap(args);
      default:
        return undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  private async handleCodebaseImpact(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.state.ingestionService) {
      throw new Error(
        "IngestionService not configured. Set NEO4J_URI and QDRANT_URL to enable code ingestion.",
      );
    }

    const projectId = args.projectId as string;
    const filePath = args.filePath as string;
    const maxDepth =
      typeof args.maxDepth === "number"
        ? Math.max(1, Math.min(args.maxDepth, 10))
        : 5;

    if (!projectId || !filePath) {
      throw new Error("projectId and filePath are required");
    }

    const results = await this.state.ingestionService.queryImpact(
      projectId,
      filePath,
      maxDepth,
    );

    return {
      projectId,
      filePath,
      maxDepth,
      affectedFiles: results.length,
      results,
    };
  }

  private async handleCodebaseBlastRadius(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.state.ingestionService) {
      throw new Error(
        "IngestionService not configured. Set NEO4J_URI and QDRANT_URL to enable code ingestion.",
      );
    }

    const projectId = args.projectId as string;
    const filePath = args.filePath as string;
    const maxDepth =
      typeof args.maxDepth === "number"
        ? Math.max(1, Math.min(args.maxDepth, 10))
        : 5;

    if (!projectId || !filePath) {
      throw new Error("projectId and filePath are required");
    }

    const results = await this.state.ingestionService.queryBlastRadius(
      projectId,
      filePath,
      maxDepth,
    );

    return {
      projectId,
      filePath,
      maxDepth,
      dependencyCount: results.length,
      results,
    };
  }

  private async handleCodebaseDependencyMap(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.state.ingestionService) {
      throw new Error(
        "IngestionService not configured. Set NEO4J_URI and QDRANT_URL to enable code ingestion.",
      );
    }

    const projectId = args.projectId as string;
    const includeExternal = args.includeExternal === true;

    if (!projectId) {
      throw new Error("projectId is required");
    }

    const results = await this.state.ingestionService.queryDependencyMap(
      projectId,
      includeExternal,
    );

    // Build adjacency list for readability
    const adjacencyMap: Record<string, string[]> = {};
    for (const edge of results) {
      const list = adjacencyMap[edge.sourceFile];
      if (list) {
        if (!list.includes(edge.targetFile)) {
          list.push(edge.targetFile);
        }
      } else {
        adjacencyMap[edge.sourceFile] = [edge.targetFile];
      }
    }

    return {
      projectId,
      includeExternal,
      edgeCount: results.length,
      uniqueFiles: Object.keys(adjacencyMap).length,
      edges: results,
      adjacencyMap,
    };
  }
}
