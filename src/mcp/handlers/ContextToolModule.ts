/**
 * Context tool handlers — session lifecycle and memory CRUD.
 *
 * Tools: context_session_start, context_session_end, context_save,
 * context_get, context_search, context_delete, context_checkpoint,
 * context_status, context_session_list
 *
 * @module mcp/handlers/ContextToolModule
 */

import type { ToolDefinition, ToolModule } from "../types.js";
import type { SessionState } from "./shared.js";
import { getActiveMemoryManager } from "./shared.js";
import { MemoryManager, type MemoryManagerConfig } from "../../memory/MemoryManager.js";
import { shouldUseLlmExtraction } from "../extractionRouting.js";
import { isProjectDirSafe } from "../../util/path-safety.js";
import type {
  SessionId,
  SessionStatus,
  MemoryCategory,
  MemoryPriority,
  MemoryQuery,
  AgentMemoryScope,
} from "../../types/index.js";
import { createAgentId } from "../../types/index.js";
import { checkEvidenceGate } from "../../validation/evidence-gates.js";
import { createLogger } from "../../util/logger.js";
import { JunkFilter } from "../../memory/JunkFilter.js";

const log = createLogger("ContextToolModule");
const junkFilterInstance = new JunkFilter();
let recallMissLastEmit = 0;

/** Reset the RECALL_MISS cooldown timer — for testing only */
export function _resetRecallMissCooldown(): void { recallMissLastEmit = 0; }

// ============================================================================
// Tool Schemas
// ============================================================================

export const CONTEXT_TOOLS: ToolDefinition[] = [
  {
    name: "context_session_start",
    description: "Start a new memory session with optional configuration. If projectDir is provided with autoIngest=true, automatically ingests the project codebase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Session name" },
        projectDir: { type: "string", description: "Project directory for context isolation and automatic code ingestion" },
        continueFrom: { type: "string", description: "Session ID to continue from" },
        defaultChannel: { type: "string", description: "Default channel for memories" },
        autoIngest: { type: "boolean", description: "Automatically ingest project codebase when projectDir is provided (default: false)" },
        agentId: { type: "string", description: "Agent identity for multi-agent scoping (stored in session metadata)" },
      },
      required: ["name"],
    },
  },
  {
    name: "context_session_end",
    description: "End the current session",
    inputSchema: {
      type: "object" as const,
      properties: {
        reason: { type: "string", description: "Reason for ending session" },
      },
    },
  },
  {
    name: "context_save",
    description: "Save or update a memory item. If the key already exists, the old value is archived and replaced (upsert behavior). Keys are exact-match. 'my-key' and 'my_key' are different keys. Use consistent naming.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "Unique key for the memory" },
        value: { type: "string", description: "Memory content" },
        category: {
          type: "string",
          enum: ["task", "decision", "progress", "note", "error", "warning", "fact", "observation"],
          description: "Memory category",
        },
        priority: {
          type: "string",
          enum: ["high", "normal", "low"],
          description: "Priority level",
        },
        channel: { type: "string", description: "Channel for organization" },
        metadata: { type: "object", description: "Custom metadata" },
        extractEntities: {
          type: "boolean",
          description: "Entity extraction is ON by default. Set false to skip extraction.",
        },
        skipProactiveRecall: {
          type: "boolean",
          description: "When true, skip proactive recall of related memories on save (default: false)",
        },
        agentScope: {
          type: "string",
          enum: ["private", "role", "shared", "public"],
          description: "Visibility scope for multi-agent access control (default: public)",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "context_get",
    description: "Retrieve memories by key or query parameters. Keys are exact-match. 'my-key' and 'my_key' are different keys. Use consistent naming.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "Exact key to retrieve" },
        keyPattern: { type: "string", description: "Wildcard pattern for keys" },
        category: { type: "string", description: "Filter by category" },
        channel: { type: "string", description: "Filter by channel" },
        limit: { type: "number", description: "Maximum results" },
        offset: { type: "number", description: "Pagination offset" },
      },
    },
  },
  {
    name: "context_search",
    description: "Search memories by keyword matching. Returns memories whose key or value contain words from the query.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        minSimilarity: { type: "number", description: "Minimum similarity score (0-1)" },
        category: { type: "string", description: "Filter by category" },
        channel: { type: "string", description: "Filter by channel" },
        limit: { type: "number", description: "Maximum results" },
        compact: { type: "boolean", description: "When true, return snippets (first 80 chars) instead of full memory values" },
      },
      required: ["query"],
    },
  },
  {
    name: "context_delete",
    description: "Delete a memory by key",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "Key of memory to delete" },
      },
      required: ["key"],
    },
  },
  {
    name: "context_checkpoint",
    description: "Create a checkpoint of current session state",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Checkpoint name" },
        description: { type: "string", description: "Checkpoint description" },
      },
      required: ["name"],
    },
  },
  {
    name: "context_status",
    description: "Get current session status and statistics",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "context_session_list",
    description: "List recent sessions",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Maximum sessions to return" },
      },
    },
  },
  {
    name: "context_auto_recall",
    description:
      "Deterministic memory recall for pre-prompt context injection. " +
      "Returns formatted context from relevant memories matching the query. " +
      "Designed for hook-driven or instruction-driven recall — call before processing any substantive user message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The user's message or keywords to search for relevant memories",
        },
        limit: {
          type: "number",
          description: "Maximum number of memories to return (default: 5)",
        },
        minScore: {
          type: "number",
          description: "Minimum relevance score threshold 0-1 (default: 0.1)",
        },
      },
      required: ["query"],
    },
  },
];

// ============================================================================
// Module
// ============================================================================

export class ContextToolModule implements ToolModule {
  readonly tools: ToolDefinition[] = CONTEXT_TOOLS;
  private readonly state: SessionState;
  private readonly junkFilter = junkFilterInstance;

  constructor(state: SessionState) {
    this.state = state;
  }

  handle(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> | undefined {
    switch (name) {
      case "context_session_start":
        return this.handleSessionStart(args);
      case "context_session_end":
        return this.handleSessionEnd(args);
      case "context_save":
        return this.handleSave(args);
      case "context_get":
        return this.handleGet(args);
      case "context_search":
        return this.handleSearch(args);
      case "context_delete":
        return this.handleDelete(args);
      case "context_checkpoint":
        return this.handleCheckpoint(args);
      case "context_status":
        return this.handleStatus();
      case "context_session_list":
        return this.handleSessionList(args);
      case "context_auto_recall":
        return this.handleAutoRecall(args);
      default:
        return undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Handlers (moved verbatim from PingMemServer)
  // --------------------------------------------------------------------------

  private async handleSessionStart(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Build session config with only defined properties (exactOptionalPropertyTypes)
    const sessionConfig: Parameters<typeof this.state.sessionManager.startSession>[0] = {
      name: args.name as string,
    };
    if (args.projectDir !== undefined) {
      sessionConfig.projectDir = args.projectDir as string;
    }
    if (args.continueFrom !== undefined) {
      sessionConfig.continueFrom = args.continueFrom as SessionId;
    }
    if (args.defaultChannel !== undefined) {
      sessionConfig.defaultChannel = args.defaultChannel as string;
    }
    if (args.agentId !== undefined) {
      sessionConfig.agentId = createAgentId(args.agentId as string);
    }

    const session = await this.state.sessionManager.startSession(sessionConfig);

    this.state.currentSessionId = session.id;

    // Create memory manager config with only defined properties (exactOptionalPropertyTypes)
    const memoryManagerConfig: MemoryManagerConfig = {
      sessionId: session.id,
      eventStore: this.state.eventStore,
    };
    if (this.state.vectorIndex !== null) {
      memoryManagerConfig.vectorIndex = this.state.vectorIndex;
    }
    if (session.defaultChannel !== undefined) {
      memoryManagerConfig.defaultChannel = session.defaultChannel;
    }
    // Pass agentId from session metadata to MemoryManager for scope enforcement
    if (session.metadata.agentId !== undefined) {
      memoryManagerConfig.agentId = createAgentId(session.metadata.agentId as string);
    }
    // Pass agentRole from session metadata for role-scoped visibility
    if (session.metadata.agentRole !== undefined) {
      memoryManagerConfig.agentRole = session.metadata.agentRole as string;
    }

    // Wire write lock manager for cross-process coordination
    if (this.state.writeLockManager !== null) {
      memoryManagerConfig.writeLockManager = this.state.writeLockManager;
    }

    const memoryManager = new MemoryManager(memoryManagerConfig);

    // Hydrate memory state from event store
    await memoryManager.hydrate();

    this.state.memoryManagers.set(session.id, memoryManager);

    // Auto-ingest project if requested
    let ingestResult: Record<string, unknown> | undefined;
    if (args.projectDir !== undefined && args.autoIngest === true && this.state.ingestionService) {
      try {
        const projectDir = args.projectDir as string;
        if (!projectDir || !isProjectDirSafe(projectDir)) {
          log.warn("autoIngest skipped: projectDir outside allowed roots", { projectDir });
          ingestResult = { ingested: false, reason: "projectDir outside allowed roots" };
        } else {
          const forceReingest = args.forceReingest as boolean ?? false;

          const ingestOpts: import("../../ingest/IngestionService.js").IngestProjectOptions = {
            projectDir,
            forceReingest,
          };
          if (typeof args.maxCommits === "number") {
            ingestOpts.maxCommits = args.maxCommits;
          }

          const result = await this.state.ingestionService.ingestProject(ingestOpts);

          ingestResult = result ? (result as unknown as Record<string, unknown>) : { ingested: false, reason: "No changes detected" };
        }
      } catch (error) {
        // Don't fail session start if ingestion fails, but log the error
        const errorMessage = error instanceof Error ? error.message : "Unknown ingestion error";
        log.error(`AutoIngest: Failed to ingest project at ${args.projectDir}`, { error: errorMessage });
        if (error instanceof Error && error.stack) {
          log.error("AutoIngest: Stack trace", { stack: error.stack });
        }
        ingestResult = {
          ingestError: errorMessage,
        };
      }
    }

    return {
      success: true,
      sessionId: session.id,
      name: session.name,
      status: session.status,
      startedAt: session.startedAt.toISOString(),
      ...(ingestResult && { ingestResult }),
    };
  }

  private async handleSessionEnd(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.currentSessionId) {
      throw new Error("No active session");
    }

    const session = await this.state.sessionManager.endSession(
      this.state.currentSessionId,
      args.reason as string | undefined
    );

    const previousSessionId = this.state.currentSessionId;
    this.state.currentSessionId = null;
    // Evict the MemoryManager from the map to prevent unbounded memory growth.
    // Matches the eviction logic in the REST server's POST /api/v1/session/end handler.
    this.state.memoryManagers.delete(previousSessionId);

    // Auto-maintenance on session end (fire-and-forget, don't block session close)
    try {
      const { MaintenanceRunner } = await import("../../maintenance/MaintenanceRunner.js");
      const runner = new MaintenanceRunner({
        eventStore: this.state.eventStore,
        relevanceEngine: this.state.relevanceEngine,
      });
      void runner.run({ dream: false }).catch((err) => {
        log.warn("Auto-maintenance failed", { error: err instanceof Error ? err.message : String(err) });
      });
    } catch { /* MaintenanceRunner not available */ }

    return {
      success: true,
      sessionId: previousSessionId,
      status: session.status,
      endedAt: session.endedAt?.toISOString(),
    };
  }

  private async handleSave(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const memoryManager = getActiveMemoryManager(this.state);

    // Normalize key: trim whitespace to match REST Zod behavior (issue #87)
    const normalizedArgs = { ...args, key: (args.key as string).trim() };
    args = normalizedArgs;

    // --- JunkFilter quality gate (issue #52) ---
    const junkResult = this.junkFilter.isJunk(args.value as string);
    if (junkResult.junk) {
      return { success: false, rejected: true, reason: junkResult.reason };
    }

    // Build save options with only defined properties (exactOptionalPropertyTypes)
    const saveOptions: Parameters<typeof memoryManager.save>[2] = {};
    if (args.category !== undefined) {
      saveOptions.category = args.category as MemoryCategory;
    }
    if (args.priority !== undefined) {
      saveOptions.priority = args.priority as MemoryPriority;
    }
    if (args.channel !== undefined) {
      saveOptions.channel = args.channel as string;
    }
    if (args.metadata !== undefined) {
      saveOptions.metadata = args.metadata as Record<string, unknown>;
    }
    if (args.agentScope !== undefined) {
      saveOptions.agentScope = args.agentScope as AgentMemoryScope;
    }

    // --- Supersede semantics (issue #55) ---
    // Evidence gate check — derive admin from agent_quotas if agentId present
    const metadata = saveOptions.metadata ?? {};
    let isAdmin = false;
    const effectiveAgentId = memoryManager.getAgentId?.();
    if (effectiveAgentId) {
      const db = this.state.eventStore.getDatabase();
      const adminRow = db.prepare("SELECT admin FROM agent_quotas WHERE agent_id = $id").get({ $id: effectiveAgentId }) as { admin: number } | null;
      isAdmin = adminRow?.admin === 1;
    }
    const gateResult = checkEvidenceGate(
      saveOptions.category,
      metadata,
      isAdmin
    );
    if (!gateResult.passed) {
      const { EvidenceGateRejectionError } = await import("../../types/agent-errors.js");
      const agentId = createAgentId(effectiveAgentId ?? "unregistered");
      throw new EvidenceGateRejectionError(agentId, args.key as string, gateResult.warnings.join("; "));
    }
    const warnings: string[] = [...gateResult.warnings];

    // Use MemoryManager.supersede() to handle supersede logic properly
    // This eliminates code duplication and silent failure patterns
    const savedMemory = await memoryManager.supersede(args.key as string, args.value as string, saveOptions);

    // Track relevance for the new memory
    if (this.state.relevanceEngine) {
      this.state.relevanceEngine.ensureTracking(
        savedMemory.id,
        savedMemory.priority,
        savedMemory.category
      );
    }

    // Handle entity extraction — default ON unless explicitly disabled (issue #54)
    const value = args.value as string;
    const category = args.category as string | undefined;
    const extractionDisabled = args.extractEntities === false;

    // Determine whether to use LLM extraction (high-value categories / long content)
    const useLlmExtraction = shouldUseLlmExtraction(category, value.length, false);

    const shouldExtract = !extractionDisabled;
    let entityIds: string[] | undefined;

    if (shouldExtract && this.state.graphManager) {
      if (useLlmExtraction && this.state.llmEntityExtractor) {
        // LLM extraction is fire-and-forget to avoid blocking the context_save hot path (300-800ms).
        // Entity IDs won't be in the response for LLM-extracted memories, but the graph gets populated async.
        const llmExtractor = this.state.llmEntityExtractor;
        const gm = this.state.graphManager;
        void (async () => {
          try {
            const llmResult = await llmExtractor.extract(value);
            if (llmResult) {
              if (llmResult.entities.length > 0) {
                await gm.batchCreateEntities(llmResult.entities);
              }
              for (const rel of llmResult.relationships) {
                try {
                  await gm.createRelationship(rel);
                } catch (relErr) {
                  log.warn("Relationship storage failed", { sourceId: rel.sourceId, targetId: rel.targetId, type: rel.type, error: relErr instanceof Error ? relErr.message : String(relErr) });
                }
              }
            }
          } catch (error) {
            log.warn("Background LLM entity extraction failed", { error: error instanceof Error ? error.message : String(error) });
          }
        })();
        entityIds = [];
      } else if (this.state.entityExtractor) {
        // Regex extraction for standard memories
        const extractionContext: { key: string; value: string; category?: string } = {
          key: args.key as string,
          value,
        };
        if (category !== undefined) {
          extractionContext.category = category;
        }
        const extractResult = this.state.entityExtractor.extractFromContext(extractionContext);
        if (extractResult.entities.length > 0) {
          const createdEntities = await this.state.graphManager.batchCreateEntities(extractResult.entities);
          entityIds = createdEntities.map((e) => e.id);
        } else {
          entityIds = [];
        }
      }
    }

    // Dual-write to KnowledgeStore when category is "knowledge_entry"
    if (category === "knowledge_entry" && this.state.knowledgeStore) {
      try {
        const parsed = JSON.parse(value) as {
          title?: string;
          solution?: string;
          symptoms?: string;
          rootCause?: string;
          tags?: string[];
          projectId?: string;
        };
        if (parsed.title && parsed.solution) {
          // Derive projectId from parsed value, session metadata, or fallback to key
          const projectId = parsed.projectId ?? "default";

          // Build ingest entry with only defined properties (exactOptionalPropertyTypes)
          const knowledgeIngestEntry: Omit<import("../../knowledge/index.js").KnowledgeEntry, "id" | "createdAt" | "updatedAt"> = {
            projectId,
            title: parsed.title,
            solution: parsed.solution,
            tags: parsed.tags ?? [],
          };
          if (parsed.symptoms !== undefined) {
            knowledgeIngestEntry.symptoms = parsed.symptoms;
          }
          if (parsed.rootCause !== undefined) {
            knowledgeIngestEntry.rootCause = parsed.rootCause;
          }
          this.state.knowledgeStore.ingest(knowledgeIngestEntry);
        }
      } catch (knowledgeError) {
        log.warn("Knowledge dual-write failed", {
          key: args.key as string,
          category: "knowledge_entry",
          error: knowledgeError instanceof Error ? knowledgeError.message : String(knowledgeError),
          memoryId: savedMemory.id,
        });
      }
    }

    const result: Record<string, unknown> = {
      success: true,
      memoryId: savedMemory.id,
      key: args.key,
    };

    // --- Advisory contradiction check (issue #53) ---
    // Timeout after 3s — contradiction detection is advisory and must not block saves
    if (this.state.contradictionDetector) {
      try {
        const contradictionPromise = (async () => {
          const similar = await memoryManager.recall({
            semanticQuery: args.value as string,
            limit: 3,
          });
          const contradictions: Array<{ existingKey: string; existingValue: string; type: string }> = [];
          for (const r of similar) {
            if (r.memory.id === savedMemory.id) continue;
            if ((r.score ?? 0) < 0.5) continue;
            const detection = await this.state.contradictionDetector!.detect(
              args.key as string,
              r.memory.value,
              args.value as string
            );
            if (detection.isContradiction) {
              contradictions.push({
                existingKey: r.memory.key,
                existingValue: r.memory.value,
                type: detection.conflict || "semantic",
              });
            }
          }
          return contradictions;
        })();

        const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
        const contradictions = await Promise.race([contradictionPromise, timeoutPromise]);

        if (contradictions && contradictions.length > 0) {
          result.contradictions = contradictions;
        }
      } catch (contradictionError) {
        log.warn("Advisory contradiction check failed", {
          error: contradictionError instanceof Error ? contradictionError.message : String(contradictionError),
        });
      }
    }

    // Supersede info is now handled internally by memoryManager.supersede()

    // Index memory for hybrid search (BM25 + semantic) — fire-and-forget
    if (this.state.hybridSearchEngine && value.length >= 20) {
      void this.state.hybridSearchEngine.indexDocument(
        savedMemory.id as import("../../types/index.js").MemoryId,
        (this.state.currentSessionId ?? "unknown") as import("../../types/index.js").SessionId,
        `${args.key as string}: ${value}`,
        new Date(),
        category !== undefined || args.metadata !== undefined
          ? {
              ...(category !== undefined ? { category } : {}),
              ...(args.metadata !== undefined ? { metadata: args.metadata as Record<string, unknown> } : {}),
            }
          : undefined
      ).catch((err) => {
        log.warn("Hybrid search indexing failed", { error: err instanceof Error ? err.message : String(err) });
      });
    }

    // Surface evidence gate warnings
    if (warnings.length > 0) {
      result.warnings = warnings;
    }

    // Include entityIds in response when extraction was performed
    if (shouldExtract) {
      result.entityIds = entityIds ?? [];
    }

    // CcMemoryBridge write-through enrichment
    if (this.state.ccMemoryBridge) {
      try {
        // Derive projectId from session metadata or args
        const session = this.state.currentSessionId
          ? await this.state.sessionManager.getSession(this.state.currentSessionId)
          : null;
        const projectId = (session?.projectDir ?? args.projectId as string | undefined) ?? "default";
        const tags = (args.metadata as Record<string, unknown> | undefined)?.tags as string[] | undefined;
        const enrichment = this.state.ccMemoryBridge.enrich(
          args.key as string,
          value,
          category,
          projectId,
          tags,
        );
        if (enrichment.entities.length > 0) {
          result.enrichment = {
            entities: enrichment.entities.length,
            relationships: enrichment.relationships.length,
            crossProjectMatches: enrichment.crossProjectMatches.length,
            propagatedTo: enrichment.propagatedTo,
          };
        }
      } catch (error) {
        log.warn("CcMemoryBridge enrichment failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Proactive recall: surface related memories (unless explicitly skipped)
    // Combines same-session (in-memory) and cross-session (SQLite) results
    if (args.skipProactiveRecall !== true) {
      try {
        const timeoutMs = 200;
        const recallPromise = new Promise<Array<Record<string, unknown>>>((resolve) => {
          const excludeKeys = [args.key as string];
          const searchLimit = 5;

          // 1. Same-session results (in-memory Map)
          const sameSessionOpts: Parameters<typeof memoryManager.findRelated>[1] = {
            excludeKeys,
            limit: searchLimit,
          };
          if (this.state.currentSessionId) {
            sameSessionOpts.excludeSessionId = this.state.currentSessionId;
          }
          const sameSession = memoryManager.findRelated(args.value as string, sameSessionOpts);

          // 2. Cross-session results (SQLite query across all sessions)
          const crossSessionOpts: Parameters<typeof memoryManager.findRelatedAcrossSessions>[1] = {
            excludeKeys,
            limit: searchLimit,
          };
          if (this.state.currentSessionId) {
            crossSessionOpts.excludeSessionId = this.state.currentSessionId;
          }
          const crossSession = memoryManager.findRelatedAcrossSessions(
            args.value as string,
            crossSessionOpts
          );

          // 3. Merge and deduplicate by key (higher score wins)
          const byKey = new Map<string, { memory: { id: string; key: string; value: string; sessionId: string; category?: string; priority: string; createdAt: Date }; score: number }>();
          for (const r of [...sameSession, ...crossSession]) {
            const existing = byKey.get(r.memory.key);
            if (!existing || r.score > existing.score) {
              byKey.set(r.memory.key, r);
            }
          }

          // 4. Sort by score descending and take top N
          const merged = Array.from(byKey.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, searchLimit);

          // 5. Filter by relevance score from RelevanceEngine — minimum 0.3 to suppress noise
          const withRelevance = merged
            .filter((r) => {
              // Always apply minimum keyword-score threshold to suppress low-relevance noise
              if (r.score < 0.3) return false;
              if (!this.state.relevanceEngine) return true;
              const tracking = this.state.relevanceEngine.getRelevanceScore(r.memory.id);
              return tracking >= 0.5;
            })
            .map((r) => ({
              key: r.memory.key,
              value: r.memory.value.length > 200
                ? r.memory.value.substring(0, 200) + "..."
                : r.memory.value,
              category: r.memory.category ?? "note",
              relevance: r.score,
              sessionId: r.memory.sessionId,
              createdAt: r.memory.createdAt.toISOString(),
            }));

          resolve(withRelevance);
        });

        const timeout = new Promise<Array<Record<string, unknown>>>((resolve) => {
          setTimeout(() => resolve([]), timeoutMs);
        });

        const relatedMemories = await Promise.race([recallPromise, timeout]);
        if (relatedMemories.length > 0) {
          result.relatedMemories = relatedMemories;
        }
      } catch (error) {
        log.warn("Proactive recall failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }

    return result;
  }

  private async handleGet(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const memoryManager = getActiveMemoryManager(this.state);

    // If exact key provided, use direct get
    if (args.key && !args.keyPattern && !args.category && !args.channel) {
      const memory = await memoryManager.get(args.key as string);
      if (!memory) {
        return { found: false, key: args.key };
      }
      // Track access for relevance scoring
      if (this.state.relevanceEngine) {
        this.state.relevanceEngine.trackAccess(memory.id);
      }
      return {
        found: true,
        memory: serializeMemory(memory),
      };
    }

    // Otherwise use query - build with only defined properties (exactOptionalPropertyTypes)
    const query: MemoryQuery = {};
    if (args.key !== undefined) {
      query.key = args.key as string;
    }
    if (args.keyPattern !== undefined) {
      query.keyPattern = args.keyPattern as string;
    }
    if (args.category !== undefined) {
      query.category = args.category as MemoryCategory;
    }
    if (args.channel !== undefined) {
      query.channel = args.channel as string;
    }
    if (args.limit !== undefined) {
      query.limit = args.limit as number;
    }
    if (args.offset !== undefined) {
      query.offset = args.offset as number;
    }

    const results = await memoryManager.recall(query);

    // Track access for all returned memories
    if (this.state.relevanceEngine) {
      for (const r of results) {
        this.state.relevanceEngine.trackAccess(r.memory.id);
      }
    }

    return {
      count: results.length,
      memories: results.map((r) => ({
        ...serializeMemory(r.memory),
        score: r.score,
      })),
    };
  }

  private async handleSearch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const memoryManager = getActiveMemoryManager(this.state);

    // Build query with only defined properties (exactOptionalPropertyTypes)
    const query: MemoryQuery = {
      semanticQuery: args.query as string,
    };
    if (args.minSimilarity !== undefined) {
      query.minSimilarity = args.minSimilarity as number;
    }
    if (args.category !== undefined) {
      query.category = args.category as MemoryCategory;
    }
    if (args.channel !== undefined) {
      query.channel = args.channel as string;
    }
    if (args.limit !== undefined) {
      query.limit = args.limit as number;
    }

    const results = await memoryManager.recall(query);

    const compact = args.compact === true;

    if (compact) {
      return {
        count: results.length,
        results: results.map((r) => ({
          id: r.memory.id,
          key: r.memory.key,
          category: r.memory.category,
          snippet: r.memory.value?.slice(0, 80) ?? "",
          score: r.score,
        })),
      };
    }

    return {
      count: results.length,
      results: results.map((r) => ({
        ...serializeMemory(r.memory),
        score: r.score,
      })),
    };
  }

  private async handleDelete(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const memoryManager = getActiveMemoryManager(this.state);

    const deleted = await memoryManager.delete(args.key as string);

    return {
      success: deleted,
      key: args.key,
    };
  }

  private async handleCheckpoint(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.state.currentSessionId) {
      throw new Error("No active session");
    }

    const memoryManager = getActiveMemoryManager(this.state);

    // Create checkpoint by saving a special memory
    const checkpointKey = `checkpoint:${args.name as string}`;
    const stats = await memoryManager.getStats();

    const memoryId = await memoryManager.save(
      checkpointKey,
      JSON.stringify({
        name: args.name,
        description: args.description,
        timestamp: new Date().toISOString(),
        stats,
      }),
      {
        category: "progress",
        priority: "high",
        metadata: {
          isCheckpoint: true,
          checkpointName: args.name,
        },
      }
    );

    return {
      success: true,
      checkpointId: memoryId,
      name: args.name,
      timestamp: new Date().toISOString(),
    };
  }

  private async handleStatus(): Promise<Record<string, unknown>> {
    if (!this.state.currentSessionId) {
      return {
        hasActiveSession: false,
        message: "No active session. Use context_session_start to begin.",
      };
    }

    const session = await this.state.sessionManager.getSession(this.state.currentSessionId);
    if (!session) {
      return {
        hasActiveSession: false,
        message: "Session not found",
      };
    }

    const memoryManager = this.state.memoryManagers.get(this.state.currentSessionId);
    const stats = memoryManager ? await memoryManager.getStats() : null;

    return {
      hasActiveSession: true,
      session: {
        id: session.id,
        name: session.name,
        status: session.status,
        startedAt: session.startedAt.toISOString(),
        memoryCount: session.memoryCount,
        eventCount: session.eventCount,
        lastActivityAt: session.lastActivityAt.toISOString(),
      },
      stats,
    };
  }

  private async handleSessionList(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const limit = (args.limit as number) ?? 10;

    // Build filter with only defined properties (exactOptionalPropertyTypes)
    const filter: { status?: SessionStatus; projectDir?: string } = {};
    if (args.status !== undefined) {
      filter.status = args.status as SessionStatus;
    }
    if (args.projectDir !== undefined) {
      filter.projectDir = args.projectDir as string;
    }

    // listSessions takes optional filter, apply limit manually
    const allSessions = this.state.sessionManager.listSessions(
      Object.keys(filter).length > 0 ? filter : undefined
    );
    const sessions = allSessions.slice(0, limit);

    return {
      count: sessions.length,
      sessions: sessions.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt?.toISOString(),
        memoryCount: s.memoryCount,
      })),
    };
  }

  private async handleAutoRecall(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const queryText = args.query as string;
    // Minimum query length: 5 chars. Allows meaningful short terms like "debug", "FSRS", "auth"
    // while rejecting noise tokens like "ok", "yes", "no", "hi". The companion hook
    // (ping-mem-auto-recall.sh) uses a higher threshold of 10 chars (full prompt length) because
    // it filters at the prompt level before keyword extraction — these thresholds operate at
    // different layers and are intentionally different.
    if (!queryText || queryText.trim().length < 5) {
      return { recalled: false, reason: "query too short", context: "" };
    }

    const limit = (args.limit as number) ?? 5;
    const minScore = (args.minScore as number) ?? 0.1;

    let memoryManager: ReturnType<typeof getActiveMemoryManager> | undefined;
    try {
      memoryManager = getActiveMemoryManager(this.state);
    } catch (err) {
      log.warn("auto_recall session lookup failed", { error: err instanceof Error ? err.message : String(err) });
      return { recalled: false, reason: "no active session", context: "" };
    }

    const query: MemoryQuery = {
      semanticQuery: queryText,
      limit,
    };

    const results = await memoryManager.recall(query);
    const filtered = results.filter((r) => (r.score ?? 0) >= minScore);

    if (filtered.length === 0) {
      // Emit RECALL_MISS event fire-and-forget with 60s cooldown to prevent EventStore flooding
      const now = Date.now();
      if (now - recallMissLastEmit > 60_000) {
        recallMissLastEmit = now;
        void this.state.eventStore.createEvent(
          this.state.currentSessionId ?? "system",
          "RECALL_MISS",
          { query: queryText, timestamp: now }
        ).catch((err) => { log.warn("Failed to emit RECALL_MISS event", { error: err instanceof Error ? err.message : String(err) }); });
      }
      return { recalled: false, reason: "no relevant memories found", context: "" };
    }

    const lines = filtered.map((r, i) => {
      const mem = r.memory;
      const score = Math.round((r.score ?? 0) * 100);
      return `[${i + 1}] (${score}%) ${mem.key}: ${mem.value}`;
    });

    const context = [
      "--- ping-mem auto-recall ---",
      ...lines,
      "--- end recall ---",
    ].join("\n");

    return {
      recalled: true,
      count: filtered.length,
      context,
      memories: filtered.map((r) => ({
        key: r.memory.key,
        value: r.memory.value,
        score: r.score ?? 0,
        category: r.memory.category,
      })),
    };
  }
}

// ============================================================================
// Helper — exported for use by other modules if needed
// ============================================================================

export function serializeMemory(memory: {
  id: string;
  key: string;
  value: string;
  sessionId: string;
  category?: string;
  priority: string;
  privacy: string;
  channel?: string;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: memory.id,
    key: memory.key,
    value: memory.value,
    category: memory.category,
    priority: memory.priority,
    privacy: memory.privacy,
    channel: memory.channel,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
    metadata: memory.metadata,
  };
}
