/**
 * Agent tool handlers -- register, quota status, deregister.
 *
 * Tools: agent_register, agent_quota_status, agent_deregister
 *
 * @module mcp/handlers/AgentToolModule
 */

import type { ToolDefinition, ToolModule } from "../types.js";
import type { SessionState } from "./shared.js";
import { createAgentId, type AgentQuotaUsage } from "../../types/index.js";

// ============================================================================
// Row shape from agent_quotas table
// ============================================================================

interface AgentQuotaRow {
  agent_id: string;
  role: string;
  admin: number;
  ttl_ms: number;
  expires_at: string | null;
  current_bytes: number;
  current_count: number;
  quota_bytes: number;
  quota_count: number;
  created_at: string;
  updated_at: string;
  metadata: string;
}

// ============================================================================
// Tool Schemas
// ============================================================================

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: "agent_register",
    description:
      "Register or update an agent identity with quota and TTL. Upserts into the agent_quotas table.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Unique agent identifier (1-256 characters)",
        },
        role: {
          type: "string",
          description:
            'Free-form agent role (e.g. "researcher", "coder", "reviewer")',
        },
        admin: {
          type: "boolean",
          description: "Whether this agent has admin privileges (default: false)",
        },
        ttlMs: {
          type: "number",
          description:
            "Time-to-live for registration in milliseconds (default: 86400000 = 24h)",
        },
        quotaBytes: {
          type: "number",
          description:
            "Maximum memory storage in bytes (default: 10485760 = 10MB)",
        },
        quotaCount: {
          type: "number",
          description: "Maximum number of memory entries (default: 10000)",
        },
        metadata: {
          type: "object",
          description: "Arbitrary metadata attached to this agent",
        },
      },
      required: ["agentId", "role"],
    },
  },
  {
    name: "agent_quota_status",
    description:
      "Get current quota usage for a registered agent. Returns bytes/count consumed and limits.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent identifier to query",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "agent_deregister",
    description:
      "Remove an agent registration and release all its write locks.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent identifier to deregister",
        },
      },
      required: ["agentId"],
    },
  },
];

// ============================================================================
// Module
// ============================================================================

export class AgentToolModule implements ToolModule {
  readonly tools: ToolDefinition[] = AGENT_TOOLS;
  private readonly state: SessionState;

  constructor(state: SessionState) {
    this.state = state;
  }

  handle(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> | undefined {
    switch (name) {
      case "agent_register":
        return this.handleRegister(args);
      case "agent_quota_status":
        return this.handleQuotaStatus(args);
      case "agent_deregister":
        return this.handleDeregister(args);
      default:
        return undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  private async handleRegister(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (typeof args.agentId !== "string" || typeof args.role !== "string") {
      throw new Error("agentId and role are required strings");
    }
    const agentId = createAgentId(args.agentId);
    const role = args.role;
    // admin is always false for self-registration — only server config can grant admin
    const admin = false;
    const ttlMs = Math.min(typeof args.ttlMs === "number" ? args.ttlMs : 86_400_000, 604_800_000); // cap at 7 days
    const quotaBytes = Math.min(typeof args.quotaBytes === "number" ? args.quotaBytes : 10_485_760, 104_857_600); // cap at 100MB
    const quotaCount = Math.min(typeof args.quotaCount === "number" ? args.quotaCount : 10_000, 100_000); // cap at 100k
    const metadata = (typeof args.metadata === "object" && args.metadata !== null ? args.metadata : {}) as Record<string, unknown>;

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    const db = this.state.eventStore.getDatabase();

    db.prepare(
      `INSERT INTO agent_quotas (agent_id, role, admin, ttl_ms, expires_at, current_bytes, current_count, quota_bytes, quota_count, created_at, updated_at, metadata)
       VALUES ($agent_id, $role, $admin, $ttl_ms, $expires_at, 0, 0, $quota_bytes, $quota_count, $created_at, $updated_at, $metadata)
       ON CONFLICT(agent_id) DO UPDATE SET
         role = $role,
         admin = $admin,
         ttl_ms = $ttl_ms,
         expires_at = $expires_at,
         quota_bytes = $quota_bytes,
         quota_count = $quota_count,
         updated_at = $updated_at,
         metadata = $metadata`
    ).run({
      $agent_id: agentId,
      $role: role,
      $admin: admin ? 1 : 0,
      $ttl_ms: ttlMs,
      $expires_at: expiresAt,
      $quota_bytes: quotaBytes,
      $quota_count: quotaCount,
      $created_at: now,
      $updated_at: now,
      $metadata: JSON.stringify(metadata),
    });

    return {
      success: true,
      agentId,
      role,
      admin,
      ttlMs,
      expiresAt,
      quotaBytes,
      quotaCount,
    };
  }

  private async handleQuotaStatus(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const agentId = createAgentId(args.agentId as string);

    const db = this.state.eventStore.getDatabase();

    const row = db
      .prepare("SELECT * FROM agent_quotas WHERE agent_id = $agent_id")
      .get({ $agent_id: agentId }) as AgentQuotaRow | undefined;

    if (!row) {
      return { found: false, agentId };
    }

    const bytesRatio =
      row.quota_bytes > 0 ? (row.current_bytes / row.quota_bytes) * 100 : 0;
    const countRatio =
      row.quota_count > 0 ? (row.current_count / row.quota_count) * 100 : 0;
    const percentUsed = Math.min(100, Math.max(bytesRatio, countRatio));

    const usage: AgentQuotaUsage = {
      agentId,
      role: row.role,
      currentBytes: row.current_bytes,
      currentCount: row.current_count,
      quotaBytes: row.quota_bytes,
      quotaCount: row.quota_count,
      percentUsed: Math.round(percentUsed * 100) / 100,
    };

    return { found: true, usage };
  }

  private async handleDeregister(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const agentId = createAgentId(args.agentId as string);

    const db = this.state.eventStore.getDatabase();

    const { lockResult, quotaResult } = db.transaction(() => {
      const lockResult = db.prepare("DELETE FROM write_locks WHERE holder_id = $agent_id").run({ $agent_id: agentId });
      const quotaResult = db.prepare("DELETE FROM agent_quotas WHERE agent_id = $agent_id").run({ $agent_id: agentId });
      return { lockResult, quotaResult };
    })();

    return {
      success: true,
      agentId,
      quotaRowsDeleted: quotaResult.changes,
      lockRowsDeleted: lockResult.changes,
    };
  }
}
