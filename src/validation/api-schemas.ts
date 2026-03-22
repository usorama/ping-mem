/**
 * Zod validation schemas for REST API POST endpoints
 *
 * Provides input validation for all REST API request bodies
 * to prevent injection attacks, type coercion issues, and ensure
 * data integrity.
 *
 * @module validation/api-schemas
 */

import { z } from "zod";

// ============================================================================
// Session Schemas
// ============================================================================

/**
 * Request body for POST /api/v1/session/start
 */
export const SessionStartSchema = z.object({
  name: z.string().min(1, "Session name is required").max(500).trim(),
  projectDir: z.string().max(4096).trim().optional(),
  continueFrom: z.string().max(500).trim().optional(),
  defaultChannel: z.string().max(200).trim().optional(),
  agentId: z.string().max(256).trim().optional(),
});

export type SessionStartInput = z.infer<typeof SessionStartSchema>;

// ============================================================================
// Context Schemas
// ============================================================================

/**
 * Request body for POST /api/v1/context
 */
export const ContextSaveSchema = z.object({
  key: z.string().min(1, "key is required").max(1000).trim(),
  value: z.string().min(1, "value is required").max(1_000_000),
  category: z.string().max(200).trim().optional(),
  priority: z.enum(["high", "normal", "low"]).optional(),
  channel: z.string().max(200).trim().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  private: z.boolean().optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  skipProactiveRecall: z.boolean().optional(),
  agentId: z.string().max(256).trim().optional(),
  agentScope: z.enum(["private", "role", "shared", "public"]).optional(),
  strictSchema: z.boolean().optional(),
});

export type ContextSaveInput = z.infer<typeof ContextSaveSchema>;

/**
 * Request body for PUT /api/v1/context/:key
 */
export const ContextUpdateSchema = z.object({
  value: z.string().min(1, "value is required").max(1_000_000),
  category: z.string().max(200).trim().optional(),
  priority: z.enum(["high", "normal", "low"]).optional(),
  channel: z.string().max(200).trim().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ContextUpdateInput = z.infer<typeof ContextUpdateSchema>;

// ============================================================================
// Checkpoint Schemas
// ============================================================================

/**
 * Request body for POST /api/v1/checkpoint
 */
export const CheckpointSchema = z.object({
  name: z.string().min(1, "Checkpoint name is required").max(500).trim(),
  description: z.string().max(5000).trim().optional(),
  includeFiles: z.boolean().optional(),
  includeGitStatus: z.boolean().optional(),
});

export type CheckpointInput = z.infer<typeof CheckpointSchema>;

// ============================================================================
// Codebase Schemas
// ============================================================================

/**
 * Request body for POST /api/v1/codebase/ingest
 */
export const CodebaseIngestSchema = z.object({
  projectDir: z
    .string()
    .min(1, "projectDir is required")
    .max(4096)
    .trim()
    .refine((p) => !p.includes(".."), {
      message: "projectDir cannot contain path traversal sequences",
    }),
  forceReingest: z.boolean().optional().default(false),
});

export type CodebaseIngestInput = z.infer<typeof CodebaseIngestSchema>;

/**
 * Request body for POST /api/v1/ingestion/enqueue
 */
export const IngestionEnqueueSchema = z.object({
  projectDir: z
    .string()
    .min(1, "projectDir is required")
    .max(4096)
    .trim()
    .refine((p) => !p.includes(".."), {
      message: "path traversal not allowed",
    }),
  forceReingest: z.boolean().optional().default(false),
  maxCommits: z.number().int().min(1).max(10000).optional(),
  maxCommitAgeDays: z.number().int().min(1).max(3650).optional(),
});

export type IngestionEnqueueInput = z.infer<typeof IngestionEnqueueSchema>;

/**
 * Request body for POST /api/v1/codebase/verify
 */
export const CodebaseVerifySchema = z.object({
  projectDir: z
    .string()
    .min(1, "projectDir is required")
    .max(4096)
    .trim()
    .refine((p) => !p.includes(".."), {
      message: "projectDir cannot contain path traversal sequences",
    }),
});

export type CodebaseVerifyInput = z.infer<typeof CodebaseVerifySchema>;

// ============================================================================
// Diagnostics Schemas
// ============================================================================

/**
 * Request body for POST /api/v1/diagnostics/diff
 */
export const DiagnosticsDiffSchema = z.object({
  analysisIdA: z.string().min(1, "analysisIdA is required").max(500),
  analysisIdB: z.string().min(1, "analysisIdB is required").max(500),
});

export type DiagnosticsDiffInput = z.infer<typeof DiagnosticsDiffSchema>;

/**
 * Request body for POST /api/v1/diagnostics/summarize/:analysisId
 */
export const DiagnosticsSummarizeSchema = z.object({
  useLLM: z.boolean().optional().default(false),
  forceRefresh: z.boolean().optional().default(false),
});

export type DiagnosticsSummarizeInput = z.infer<typeof DiagnosticsSummarizeSchema>;

// ============================================================================
// Agent Registration Schema
// ============================================================================

/**
 * Request body for POST /api/v1/agents/register
 */
export const AgentRegisterSchema = z.object({
  agentId: z.string().min(1, "agentId is required").max(256).trim(),
  role: z.string().min(1, "role is required").max(200).trim(),
  admin: z.literal(false).optional().default(false),
  ttlMs: z.number().int().positive().max(604800000).optional().default(86400000), // max 7 days
  quotaBytes: z.number().int().positive().optional().default(10485760), // 10MB
  quotaCount: z.number().int().positive().optional().default(10000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AgentRegisterInput = z.infer<typeof AgentRegisterSchema>;

// ============================================================================
// Structured Memory Schemas (for strictSchema validation)
// ============================================================================

/**
 * Schema for task_complete category memories.
 * Value must be JSON-parseable with these required fields.
 */
export const TaskCompleteValueSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
  output: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
});

/**
 * Schema for review_finding category memories.
 */
export const ReviewFindingValueSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().nonnegative().optional(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  message: z.string().min(1),
  rule: z.string().optional(),
});

/**
 * Schema for decision category memories.
 */
export const DecisionValueSchema = z.object({
  decision: z.string().min(1),
  rationale: z.string().min(1),
  alternatives: z.array(z.string()).optional(),
  reversible: z.boolean().optional(),
});

/**
 * Schema for knowledge_entry category memories.
 */
export const KnowledgeEntryValueSchema = z.object({
  title: z.string().min(1),
  solution: z.string().min(1),
  symptoms: z.string().optional(),
  rootCause: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

/**
 * Schema for digest category memories (produced by SemanticCompressor).
 */
export const DigestValueSchema = z.object({
  facts: z.array(z.string().min(1)).min(1),
  sourceCount: z.number().int().positive(),
  compressionRatio: z.number().positive().max(1),
});

/**
 * Registry mapping category names to their value schemas.
 * Only categories listed here support strictSchema validation.
 */
export const MEMORY_VALUE_SCHEMAS: Record<string, z.ZodType> = {
  task_complete: TaskCompleteValueSchema,
  review_finding: ReviewFindingValueSchema,
  decision: DecisionValueSchema,
  knowledge_entry: KnowledgeEntryValueSchema,
  digest: DigestValueSchema,
};

// ============================================================================
// Knowledge Schemas
// ============================================================================

/**
 * Request body for POST /api/v1/knowledge/search
 */
export const KnowledgeSearchSchema = z.object({
  query: z.string().min(1, "query is required").max(2000).trim(),
  projectId: z.string().max(500).trim().optional(),
  crossProject: z.boolean().optional().default(false),
  tags: z.array(z.string().max(200).trim()).max(50).optional(),
  limit: z.number().int().positive().max(100).optional().default(20),
});

export type KnowledgeSearchInput = z.infer<typeof KnowledgeSearchSchema>;

/**
 * Request body for POST /api/v1/knowledge/ingest
 */
export const KnowledgeIngestSchema = z.object({
  projectId: z.string().min(1, "projectId is required").max(500).trim(),
  title: z.string().min(1, "title is required").max(1000).trim(),
  solution: z.string().min(1, "solution is required").max(100_000),
  symptoms: z.string().max(10_000).optional(),
  rootCause: z.string().max(10_000).optional(),
  tags: z.array(z.string().max(200).trim()).max(50).optional().default([]),
});

export type KnowledgeIngestInput = z.infer<typeof KnowledgeIngestSchema>;

// ============================================================================
// Memory Consolidation Schema
// ============================================================================

/**
 * Request body for POST /api/v1/memory/consolidate
 */
export const MemoryConsolidateSchema = z.object({
  maxScore: z.number().min(0).max(1).optional(),
  minDaysOld: z.number().int().nonnegative().max(3650).optional(),
});

export type MemoryConsolidateInput = z.infer<typeof MemoryConsolidateSchema>;

// ============================================================================
// Memory Extraction Schema
// ============================================================================

/**
 * Request body for POST /api/v1/memory/extract
 * Extracts facts from a conversation exchange and saves them as memories.
 */
export const MemoryExtractSchema = z.object({
  exchange: z
    .string()
    .min(10, "Exchange text must be at least 10 characters")
    .max(50000, "Exchange text must be at most 50000 characters"),
  sessionId: z.string().optional(),
  category: z.enum(["note", "decision", "task", "insight", "fact", "preference"]).optional(),
});

export type MemoryExtractInput = z.infer<typeof MemoryExtractSchema>;

// ============================================================================
// Memory Auto-Recall Schema
// ============================================================================

/**
 * Request body for POST /api/v1/memory/auto-recall
 * Returns formatted context from relevant memories for pre-prompt injection.
 */
export const MemoryAutoRecallSchema = z.object({
  query: z.string().min(3, "Query must be at least 3 characters").max(1000, "Query too long"),
  limit: z.number().int().min(1).max(20).optional(),
  minScore: z.number().min(0).max(1).optional(),
});

export type MemoryAutoRecallInput = z.infer<typeof MemoryAutoRecallSchema>;

// ============================================================================
// Graph Schemas
// ============================================================================

/**
 * Query params for GET /api/v1/graph/relationships
 */
export const GraphRelationshipsSchema = z.object({
  entityId: z.string().min(1, "entityId is required").max(500),
  depth: z.coerce.number().int().min(1).max(10).optional().default(1),
  relationshipTypes: z.string().max(2000).optional(),
  direction: z.enum(["incoming", "outgoing", "both"]).optional().default("both"),
});

export type GraphRelationshipsInput = z.infer<typeof GraphRelationshipsSchema>;

/**
 * Request body for POST /api/v1/graph/hybrid-search
 */
export const GraphHybridSearchSchema = z.object({
  query: z.string().min(1, "query is required").max(2000).trim(),
  limit: z.number().int().positive().max(100).optional(),
  weights: z.object({
    semantic: z.number().min(0).max(1).optional(),
    keyword: z.number().min(0).max(1).optional(),
    graph: z.number().min(0).max(1).optional(),
  }).optional(),
  sessionId: z.string().max(500).optional(),
});

export type GraphHybridSearchInput = z.infer<typeof GraphHybridSearchSchema>;

// ============================================================================
// Causal Schemas
// ============================================================================

/**
 * Request body for POST /api/v1/causal/discover
 */
export const CausalDiscoverSchema = z.object({
  text: z.string().min(1, "text is required").max(50000),
  persist: z.boolean().optional().default(false),
});

export type CausalDiscoverInput = z.infer<typeof CausalDiscoverSchema>;

// ============================================================================
// Worklog Schemas
// ============================================================================

/**
 * Request body for POST /api/v1/worklog
 */
export const WorklogRecordSchema = z.object({
  kind: z.enum(["tool", "diagnostics", "git", "task"]),
  title: z.string().min(1, "title is required").max(1000).trim(),
  status: z.enum(["success", "failed", "partial"]).optional(),
  phase: z.enum(["started", "summary", "completed"]).optional(),
  toolName: z.string().max(200).optional(),
  toolVersion: z.string().max(200).optional(),
  configHash: z.string().max(200).optional(),
  environmentHash: z.string().max(200).optional(),
  projectId: z.string().max(500).optional(),
  treeHash: z.string().max(200).optional(),
  commitHash: z.string().max(200).optional(),
  runId: z.string().max(200).optional(),
  command: z.string().max(5000).optional(),
  durationMs: z.number().nonnegative().optional(),
  summary: z.string().max(10000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().max(500).optional(),
});

export type WorklogRecordInput = z.infer<typeof WorklogRecordSchema>;

// ============================================================================
// Memory PubSub Schemas
// ============================================================================

/**
 * Request body for POST /api/v1/memory/subscribe
 */
export const MemorySubscribeSchema = z.object({
  channel: z.string().max(200).optional(),
  category: z.string().max(200).optional(),
});

export type MemorySubscribeInput = z.infer<typeof MemorySubscribeSchema>;

/**
 * Request body for POST /api/v1/memory/unsubscribe
 */
export const MemoryUnsubscribeSchema = z.object({
  subscriptionId: z.string().min(1, "subscriptionId is required").max(500),
});

export type MemoryUnsubscribeInput = z.infer<typeof MemoryUnsubscribeSchema>;

/**
 * Request body for POST /api/v1/memory/compress
 */
export const MemoryCompressSchema = z.object({
  channel: z.string().max(200).optional(),
  category: z.string().max(200).optional(),
  maxCount: z.number().int().positive().max(10000).optional().default(100),
});

export type MemoryCompressInput = z.infer<typeof MemoryCompressSchema>;

// ============================================================================
// Tool Invoke Schema
// ============================================================================

/**
 * Request body for POST /api/v1/tools/:name/invoke
 */
export const ToolInvokeSchema = z.object({
  args: z.record(z.string(), z.unknown()).optional().default({}),
});

export type ToolInvokeInput = z.infer<typeof ToolInvokeSchema>;
