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
  category: z
    .enum(["task", "decision", "progress", "note", "error", "warning"])
    .optional(),
  priority: z.enum(["high", "normal", "low"]).optional(),
  channel: z.string().max(200).trim().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  private: z.boolean().optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  skipProactiveRecall: z.boolean().optional(),
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
