/**
 * Codebase tool handlers — ingest, verify, search, timeline, list, delete.
 *
 * Tools: codebase_ingest, codebase_verify, codebase_search,
 * codebase_timeline, codebase_list_projects, project_delete
 *
 * @module mcp/handlers/CodebaseToolModule
 */

import type { ToolDefinition, ToolModule } from "../types.js";
import type { SessionState } from "./shared.js";
import { ProjectScanner } from "../../ingest/ProjectScanner.js";
import { AdminStore } from "../../admin/AdminStore.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("CodebaseToolModule");
import {
  ListProjectsSchema,
  type ListProjectsInput,
  DeleteProjectSchema,
  type DeleteProjectInput,
} from "../../validation/codebase-schemas.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Tool Schemas
// ============================================================================

export const CODEBASE_TOOLS: ToolDefinition[] = [
  {
    name: "codebase_ingest",
    description: "Ingest a project codebase: scan files, extract chunks, index git history, persist to graph+vectors. Deterministic and reproducible.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectDir: { type: "string", description: "Absolute path to project root" },
        forceReingest: { type: "boolean", description: "Force re-ingestion even if no changes detected" },
        maxCommits: { type: "number", description: "Max git commits to ingest (default 200). Lower for cloned repos you don't own." },
      },
      required: ["projectDir"],
    },
  },
  {
    name: "codebase_verify",
    description: "Verify that the ingested manifest matches the current on-disk project state. Returns validation result.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectDir: { type: "string", description: "Absolute path to project root" },
      },
      required: ["projectDir"],
    },
  },
  {
    name: "codebase_search",
    description: "Search code chunks semantically using deterministic vectors. Returns relevant code snippets with provenance.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural language query" },
        projectId: { type: "string", description: "Filter by project ID" },
        filePath: { type: "string", description: "Filter by file path" },
        type: {
          type: "string",
          enum: ["code", "comment", "docstring"],
          description: "Filter by chunk type",
        },
        limit: { type: "number", description: "Maximum results (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "codebase_timeline",
    description: "Query temporal timeline for a project or file. Returns commits with explicit-only 'why' (from commit messages, issue refs, ADRs).",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID" },
        filePath: { type: "string", description: "Optional: filter by specific file" },
        limit: { type: "number", description: "Maximum commits to return (default: 100)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "codebase_list_projects",
    description: "List all ingested projects with metadata (file/chunk/commit counts). Returns project info sorted by lastIngestedAt (default), filesCount, or rootPath.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Optional: filter by specific project ID" },
        limit: { type: "number", description: "Maximum projects to return (1-1000, default: 100)" },
        sortBy: {
          type: "string",
          description: "Sort field: 'lastIngestedAt' (default), 'filesCount', or 'rootPath'",
          enum: ["lastIngestedAt", "filesCount", "rootPath"],
        },
      },
    },
  },
  {
    name: "project_delete",
    description: "Delete all memory, diagnostics, graph, and vectors for a project directory",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectDir: { type: "string", description: "Absolute path to project root" },
      },
      required: ["projectDir"],
    },
  },
];

// ============================================================================
// Module
// ============================================================================

export class CodebaseToolModule implements ToolModule {
  readonly tools: ToolDefinition[] = CODEBASE_TOOLS;
  private readonly state: SessionState;

  constructor(state: SessionState) {
    this.state = state;
  }

  handle(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> | undefined {
    switch (name) {
      case "codebase_ingest":
        return this.handleCodebaseIngest(args);
      case "codebase_verify":
        return this.handleCodebaseVerify(args);
      case "codebase_search":
        return this.handleCodebaseSearch(args);
      case "codebase_timeline":
        return this.handleCodebaseTimeline(args);
      case "codebase_list_projects":
        return this.handleCodebaseListProjects(args);
      case "project_delete":
        return this.handleProjectDelete(args);
      default:
        return undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Handlers (moved verbatim from PingMemServer)
  // --------------------------------------------------------------------------

  private async handleCodebaseIngest(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.ingestionService) {
      throw new Error("IngestionService not configured. Provide ingestionService in PingMemServerConfig.");
    }

    const projectDir = args.projectDir as string;
    const forceReingest = args.forceReingest === true;

    const ingestOpts: import("../../ingest/IngestionService.js").IngestProjectOptions = {
      projectDir,
      forceReingest,
    };
    if (typeof args.maxCommits === "number") {
      ingestOpts.maxCommits = args.maxCommits;
    }

    const result = await this.state.ingestionService.ingestProject(ingestOpts);

    if (!result) {
      return {
        success: true,
        hadChanges: false,
        message: "No changes detected since last ingestion.",
      };
    }

    return {
      success: true,
      hadChanges: true,
      projectId: result.projectId,
      treeHash: result.treeHash,
      filesIndexed: result.filesIndexed,
      chunksIndexed: result.chunksIndexed,
      commitsIndexed: result.commitsIndexed,
      ingestedAt: result.ingestedAt,
    };
  }

  private async handleCodebaseVerify(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.ingestionService) {
      throw new Error("IngestionService not configured. Provide ingestionService in PingMemServerConfig.");
    }

    const projectDir = args.projectDir as string;
    const result = await this.state.ingestionService.verifyProject(projectDir);

    return {
      projectId: result.projectId,
      valid: result.valid,
      manifestTreeHash: result.manifestTreeHash,
      currentTreeHash: result.currentTreeHash,
      message: result.message,
    };
  }

  private async handleCodebaseSearch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.ingestionService) {
      throw new Error("IngestionService not configured. Provide ingestionService in PingMemServerConfig.");
    }

    const query = args.query as string;
    const options: {
      projectId?: string;
      filePath?: string;
      type?: "code" | "comment" | "docstring";
      limit?: number;
    } = {};

    if (args.projectId !== undefined) {
      options.projectId = args.projectId as string;
    }
    if (args.filePath !== undefined) {
      options.filePath = args.filePath as string;
    }
    if (args.type !== undefined) {
      options.type = args.type as "code" | "comment" | "docstring";
    }
    if (args.limit !== undefined) {
      options.limit = args.limit as number;
    }

    const results = await this.state.ingestionService.searchCode(query, options);

    return {
      query,
      resultCount: results.length,
      results: results.map((r) => ({
        chunkId: r.chunkId,
        projectId: r.projectId,
        filePath: r.filePath,
        type: r.type,
        content: r.content,
        score: r.score,
      })),
    };
  }

  private async handleCodebaseTimeline(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.ingestionService) {
      throw new Error("IngestionService not configured. Provide ingestionService in PingMemServerConfig.");
    }

    const projectId = args.projectId as string;
    const options: {
      projectId: string;
      filePath?: string;
      limit?: number;
    } = { projectId };

    if (args.filePath !== undefined) {
      options.filePath = args.filePath as string;
    }
    if (args.limit !== undefined) {
      options.limit = args.limit as number;
    }

    const timeline = await this.state.ingestionService.queryTimeline(options);

    return {
      projectId,
      filePath: options.filePath,
      eventCount: timeline.length,
      events: timeline.map((e) => ({
        commitHash: e.commitHash,
        date: e.date,
        authorName: e.authorName,
        message: e.message,
        changeType: e.changeType,
        why: e.why,
      })),
    };
  }

  private async handleCodebaseListProjects(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.ingestionService) {
      throw new Error(
        "IngestionService not configured. Set NEO4J_URI and QDRANT_URL to enable code ingestion."
      );
    }

    // Validate input with Zod
    const parseResult = ListProjectsSchema.safeParse(args);
    if (!parseResult.success) {
      // Log validation failure for debugging/security
      log.error("codebase_list_projects validation failed", {
        receivedInput: args,
        validationErrors: parseResult.error.format(),
        sessionId: this.state.currentSessionId,
      });

      throw new Error(
        `Invalid input for codebase_list_projects: ${parseResult.error.message}`
      );
    }

    const validated: ListProjectsInput = parseResult.data;

    try {
      // Build options object - only include projectId if defined (exactOptionalPropertyTypes)
      // limit and sortBy always have defaults from Zod schema
      const options: Parameters<typeof this.state.ingestionService.listProjects>[0] = {
        limit: validated.limit,
        sortBy: validated.sortBy,
        ...(validated.projectId !== undefined && { projectId: validated.projectId }),
      };

      const projects = await this.state.ingestionService.listProjects(options);

      return {
        count: projects.length,
        sortBy: validated.sortBy,
        projects: projects.map((p) => ({
          projectId: p.projectId,
          rootPath: p.rootPath,
          treeHash: p.treeHash,
          filesCount: p.filesCount,
          chunksCount: p.chunksCount,
          commitsCount: p.commitsCount,
          lastIngestedAt: p.lastIngestedAt,
        })),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Log error before re-throwing for debugging
      log.error("codebase_list_projects failed", {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        input: validated,
      });

      throw new Error(`Failed to list projects: ${errorMessage}`);
    }
  }

  private async handleProjectDelete(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.ingestionService) {
      throw new Error("IngestionService not configured. Provide ingestionService in PingMemServerConfig.");
    }

    // Validate input with Zod
    const parseResult = DeleteProjectSchema.safeParse(args);
    if (!parseResult.success) {
      // Log validation failure for debugging/security
      log.error("project_delete validation failed", {
        receivedInput: args,
        validationErrors: parseResult.error.format(),
        sessionId: this.state.currentSessionId,
      });

      throw new Error(
        `Invalid input for project_delete: ${parseResult.error.message}`
      );
    }

    const validated: DeleteProjectInput = parseResult.data;
    const normalized = path.resolve(validated.projectDir);

    let projectId: string | null = null;
    if (fs.existsSync(normalized)) {
      try {
        const scanner = new ProjectScanner();
        const scan = await scanner.scanProject(normalized);
        projectId = scan.manifest.projectId;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        log.error("ProjectDelete: Failed to scan project directory", {
          error: errorMessage,
          projectDir: normalized,
        });

        // Fall through to "not found" error below
      }
    }

    if (!projectId) {
      throw new Error(
        `Project not found at ${normalized}. Directory may not exist or may not be a valid ping-mem project.`
      );
    }

    await this.state.ingestionService.deleteProject(projectId);

    if (this.state.diagnosticsStore) {
      this.state.diagnosticsStore.deleteProject(projectId);
    }

    let sessionsDeleted = 0;
    try {
      const sessionIds = this.state.eventStore.findSessionIdsByProjectDir(normalized);

      if (sessionIds.length > 0) {
        log.info(`ProjectDelete: Deleting ${sessionIds.length} sessions for project ${projectId}`);
        this.state.eventStore.deleteSessions(sessionIds);
        sessionsDeleted = sessionIds.length;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Log but don't fail - session cleanup is supplementary
      log.error(`ProjectDelete: Failed to delete sessions for project ${projectId}`, {
        error: errorMessage,
        projectDir: normalized,
      });

      // Continue with delete - session cleanup failure shouldn't block project deletion
    }

    const manifestPath = path.join(normalized, ".ping-mem", "manifest.json");
    if (fs.existsSync(manifestPath)) {
      try {
        fs.unlinkSync(manifestPath);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        log.error("ProjectDelete: Failed to delete manifest file", {
          error: errorMessage,
          path: manifestPath,
          projectId,
        });

        // Don't throw - manifest cleanup failure shouldn't block overall deletion
      }
    }

    const adminDbPath = process.env.PING_MEM_ADMIN_DB_PATH ?? path.join(os.homedir(), ".ping-mem", "admin.db");
    if (adminDbPath) {
      try {
        const adminStore = new AdminStore({ dbPath: adminDbPath });
        adminStore.deleteProject(projectId);
        adminStore.close();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Log admin cleanup failure - critical for diagnosing admin DB inconsistencies
        log.error(`ProjectDelete: Failed to cleanup admin store for project ${projectId}`, {
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
          adminDbPath,
        });

        // Don't re-throw - admin cleanup failure shouldn't block project deletion
      }
    }

    return {
      success: true,
      projectId,
      projectDir: normalized,
      sessionsDeleted,
    };
  }
}
