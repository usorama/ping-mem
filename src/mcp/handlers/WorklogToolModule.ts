/**
 * Worklog tool handlers — recording and listing worklog events.
 *
 * Tools: worklog_record, worklog_list
 *
 * @module mcp/handlers/WorklogToolModule
 */

import type { ToolDefinition, ToolModule } from "../types.js";
import type { SessionState } from "./shared.js";
import type {
  EventType,
  WorklogEventData,
} from "../../types/index.js";

// ============================================================================
// Tool Schemas
// ============================================================================

const WORKLOG_TOOLS: ToolDefinition[] = [
  {
    name: "worklog_record",
    description: "Record a deterministic worklog event (tool, diagnostics, git, task)",
    inputSchema: {
      type: "object" as const,
      properties: {
        kind: {
          type: "string",
          enum: ["tool", "diagnostics", "git", "task"],
          description: "Worklog category",
        },
        title: { type: "string", description: "Short title for the event" },
        status: {
          type: "string",
          enum: ["success", "failed", "partial"],
          description: "Outcome status",
        },
        phase: {
          type: "string",
          enum: ["started", "summary", "completed"],
          description: "Task phase (only for kind=task)",
        },
        toolName: { type: "string", description: "Tool name" },
        toolVersion: { type: "string", description: "Tool version" },
        configHash: { type: "string", description: "Deterministic config hash" },
        environmentHash: { type: "string", description: "Environment hash" },
        projectId: { type: "string", description: "Project ID" },
        treeHash: { type: "string", description: "Tree hash" },
        commitHash: { type: "string", description: "Commit hash" },
        runId: { type: "string", description: "Diagnostics run ID" },
        command: { type: "string", description: "Command executed" },
        durationMs: { type: "number", description: "Duration in milliseconds" },
        summary: { type: "string", description: "Summary of outcome" },
        metadata: { type: "object", description: "Additional metadata" },
        sessionId: { type: "string", description: "Explicit session ID (optional)" },
      },
      required: ["kind", "title"],
    },
  },
  {
    name: "worklog_list",
    description: "List worklog events for a session",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID (optional)" },
        limit: { type: "number", description: "Max events to return" },
        eventTypes: {
          type: "array",
          items: { type: "string" },
          description: "Filter by event types",
        },
      },
    },
  },
];

// ============================================================================
// Module
// ============================================================================

export class WorklogToolModule implements ToolModule {
  readonly tools: ToolDefinition[] = WORKLOG_TOOLS;
  private readonly state: SessionState;

  constructor(state: SessionState) {
    this.state = state;
  }

  handle(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> | undefined {
    switch (name) {
      case "worklog_record":
        return this.handleWorklogRecord(args);
      case "worklog_list":
        return this.handleWorklogList(args);
      default:
        return undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Handlers (moved verbatim from PingMemServer)
  // --------------------------------------------------------------------------

  private async handleWorklogRecord(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = (args.sessionId as string | undefined) ?? this.state.currentSessionId;
    if (!sessionId) {
      throw new Error("No active session. Use context_session_start first.");
    }

    const kind = args.kind as WorklogEventData["kind"];
    const phase = args.phase as string | undefined;

    let eventType: EventType;
    switch (kind) {
      case "tool":
        eventType = "TOOL_RUN_RECORDED";
        break;
      case "diagnostics":
        eventType = "DIAGNOSTICS_INGESTED";
        break;
      case "git":
        eventType = "GIT_OPERATION_RECORDED";
        break;
      case "task":
        if (phase === "started") {
          eventType = "AGENT_TASK_STARTED";
        } else if (phase === "summary") {
          eventType = "AGENT_TASK_SUMMARY";
        } else if (phase === "completed") {
          eventType = "AGENT_TASK_COMPLETED";
        } else {
          throw new Error("Task worklog requires phase: started | summary | completed");
        }
        break;
      default:
        throw new Error("Invalid worklog kind");
    }

    const payload: WorklogEventData = {
      sessionId,
      kind,
      title: args.title as string,
    };

    if (args.status !== undefined) payload.status = args.status as WorklogEventData["status"];
    if (args.toolName !== undefined) payload.toolName = args.toolName as string;
    if (args.toolVersion !== undefined) payload.toolVersion = args.toolVersion as string;
    if (args.configHash !== undefined) payload.configHash = args.configHash as string;
    if (args.environmentHash !== undefined) payload.environmentHash = args.environmentHash as string;
    if (args.projectId !== undefined) payload.projectId = args.projectId as string;
    if (args.treeHash !== undefined) payload.treeHash = args.treeHash as string;
    if (args.commitHash !== undefined) payload.commitHash = args.commitHash as string;
    if (args.runId !== undefined) payload.runId = args.runId as string;
    if (args.command !== undefined) payload.command = args.command as string;
    if (args.durationMs !== undefined) payload.durationMs = args.durationMs as number;
    if (args.summary !== undefined) payload.summary = args.summary as string;
    if (args.metadata !== undefined) payload.metadata = args.metadata as Record<string, unknown>;

    const metadata = {
      kind,
      projectId: payload.projectId,
      treeHash: payload.treeHash,
      commitHash: payload.commitHash,
      toolName: payload.toolName,
      toolVersion: payload.toolVersion,
      runId: payload.runId,
    };

    const event = await this.state.eventStore.createEvent(sessionId, eventType, payload, metadata);

    return {
      success: true,
      eventId: event.eventId,
      eventType: event.eventType,
      timestamp: event.timestamp.toISOString(),
    };
  }

  private async handleWorklogList(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = (args.sessionId as string | undefined) ?? this.state.currentSessionId;
    if (!sessionId) {
      throw new Error("No active session. Use context_session_start first.");
    }

    const limit = (args.limit as number | undefined) ?? 100;
    const allowedTypes = new Set(
      ((args.eventTypes as string[] | undefined) ?? [
        "TOOL_RUN_RECORDED",
        "DIAGNOSTICS_INGESTED",
        "GIT_OPERATION_RECORDED",
        "AGENT_TASK_STARTED",
        "AGENT_TASK_SUMMARY",
        "AGENT_TASK_COMPLETED",
      ])
    );

    const events = await this.state.eventStore.getBySession(sessionId);
    const filtered = events.filter((e) => allowedTypes.has(e.eventType));
    const selected = filtered.slice(-limit);

    return {
      sessionId,
      count: selected.length,
      events: selected.map((e) => ({
        eventId: e.eventId,
        eventType: e.eventType,
        timestamp: e.timestamp.toISOString(),
        payload: e.payload,
        metadata: e.metadata,
        causedBy: e.causedBy,
      })),
    };
  }
}
