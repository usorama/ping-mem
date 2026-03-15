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
