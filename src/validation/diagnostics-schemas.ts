/**
 * Zod validation schemas for Diagnostics API endpoints
 *
 * Provides input validation for all diagnostics API request bodies
 * to prevent injection attacks, type coercion issues, and ensure
 * data integrity.
 *
 * @module validation/diagnostics-schemas
 */

import { z } from "zod";

// ============================================================================
// Common Schemas
// ============================================================================

/**
 * Non-empty string schema (trims whitespace)
 */
const nonEmptyString = z.string().min(1).max(10_000).trim();

/**
 * Optional non-empty string schema
 */
const optionalString = nonEmptyString.optional();

/**
 * Boolean schema (strict, no coercion)
 */
const strictBoolean = z.boolean({
  message: "Must be a boolean",
});

/**
 * Integer number schema (strict, no coercion)
 */
const strictInt = z.number({
  message: "Must be a number",
}).int();

/**
 * Non-negative integer schema
 */
const nonNegativeInt = strictInt.nonnegative();

/**
 * SHA-256 hash schema (64 hex characters)
 */
const sha256HashSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/, "Must be a valid SHA-256 hash (64 hex characters)");

/**
 * Git commit hash schema (7-40 hex characters)
 */
const commitHashSchema = z
  .string()
  .min(7)
  .max(40)
  .regex(/^[a-f0-9]+$/, "Must be a valid git commit hash (hex characters)");

/**
 * Tool status schema
 */
const toolStatusSchema = z.enum(["passed", "failed", "partial"], {
  message: "status must be one of: passed, failed, partial",
});

// ============================================================================
// Finding Schemas
// ============================================================================

/**
 * Severity level schema
 */
const severitySchema = z.enum(["error", "warning", "note", "none"], {
  message: "severity must be one of: error, warning, note, none",
});

/**
 * Location schema for a finding
 */
const locationSchema = z.object({
  filePath: z.string().max(1_000),
  startLine: nonNegativeInt.max(1_000_000).optional(),
  endLine: nonNegativeInt.max(1_000_000).optional(),
  startColumn: nonNegativeInt.max(10_000).optional(),
  endColumn: nonNegativeInt.max(10_000).optional(),
});

/**
 * Finding input schema
 */
export const findingSchema = z.object({
  ruleId: z.string().max(500).optional(),
  message: z.string().min(1).max(10_000),
  severity: severitySchema,
  location: locationSchema.optional(),
  code: z.string().max(50_000).optional(),
  category: z.string().max(200).optional(),
  fixes: z
    .array(
      z.object({
        message: z.string().max(1_000),
        replacement: z.string().max(50_000),
      })
    )
    .max(100)
    .optional(),
});

export type FindingInput = z.infer<typeof findingSchema>;

// ============================================================================
// Diagnostics Ingest Schema
// ============================================================================

/**
 * Request body for POST /api/v1/diagnostics/ingest
 *
 * This schema validates the ingestion of diagnostic findings,
 * either from SARIF format or as an array of findings.
 */
export const diagnosticsIngestSchema = z
  .object({
    // Required fields
    projectId: z
      .string()
      .min(1)
      .max(500)
      .regex(/^ping-mem-[a-zA-Z0-9]+$/, {
        message: "projectId must start with 'ping-mem-'",
      }),
    treeHash: sha256HashSchema,
    configHash: sha256HashSchema,

    // Optional fields with defaults
    commitHash: commitHashSchema.optional(),
    environmentHash: sha256HashSchema.optional(),
    status: toolStatusSchema.default("failed"),
    durationMs: nonNegativeInt.max(3_600_000).optional(), // Max 1 hour
    metadata: z.record(z.string(), z.unknown()).optional(),

    // Tool info (either explicit or from SARIF)
    toolName: z.string().min(1).max(100).optional(),
    toolVersion: z.string().min(1).max(50).optional(),

    // Findings input (either SARIF or array)
    sarif: z.union([z.string().max(10_000_000), z.unknown()]).optional(),
    findings: z.array(findingSchema).max(100_000).optional(),
  })
  .refine(
    (data) => data.toolName !== undefined && data.toolVersion !== undefined,
    { message: "toolName and toolVersion are required (unless in SARIF)" }
  )
  .refine(
    (data) => data.sarif !== undefined || data.findings !== undefined,
    { message: "Either sarif or findings must be provided" }
  )
  .refine(
    (data) => !(data.sarif !== undefined && data.findings !== undefined),
    { message: "Provide only one of sarif or findings, not both" }
  );

export type DiagnosticsIngestInput = z.infer<typeof diagnosticsIngestSchema>;

// ============================================================================
// Query Latest Schema
// ============================================================================

/**
 * Query parameters for GET /api/v1/diagnostics/latest
 *
 * @param projectId - Project ID to query
 * @param toolName - Tool name to filter by
 * @param treeHash - Tree hash to filter by (optional)
 */
export const queryLatestSchema = z.object({
  projectId: z.string().min(1).max(500),
  toolName: z.string().min(1).max(100),
  treeHash: sha256HashSchema.optional().or(z.literal("")),
});

export type QueryLatestInput = z.infer<typeof queryLatestSchema>;

// ============================================================================
// Diff Schema
// ============================================================================

/**
 * Request body for POST /api/v1/diagnostics/diff
 *
 * @param analysisIdA - First analysis ID to compare
 * @param analysisIdB - Second analysis ID to compare
 */
export const diffSchema = z.object({
  analysisIdA: z.string().min(1).max(500),
  analysisIdB: z.string().min(1).max(500),
});

export type DiffInput = z.infer<typeof diffSchema>;

// ============================================================================
// Compare Tools Schema
// ============================================================================

/**
 * Request body for POST /api/v1/diagnostics/compare-tools
 *
 * @param projectId - Project ID to query
 * @param treeHash - Tree hash to query
 * @param toolNames - Array of tool names to compare
 */
export const compareToolsSchema = z.object({
  projectId: z.string().min(1).max(500),
  treeHash: sha256HashSchema,
  toolNames: z
    .array(z.string().min(1).max(100))
    .min(2, { message: "At least 2 tools are required for comparison" })
    .max(20, { message: "Maximum 20 tools can be compared" }),
});

export type CompareToolsInput = z.infer<typeof compareToolsSchema>;

// ============================================================================
// By Symbol Schema
// ============================================================================

/**
 * Request body for POST /api/v1/diagnostics/by-symbol
 *
 * @param analysisId - Analysis ID to query
 * @param groupBy - How to group findings (symbol or file)
 */
export const bySymbolSchema = z.object({
  analysisId: z.string().min(1).max(500),
  groupBy: z.enum(["symbol", "file"]).default("symbol"),
});

export type BySymbolInput = z.infer<typeof bySymbolSchema>;

// ============================================================================
// Summarize Schema
// ============================================================================

/**
 * Request body for POST /api/v1/diagnostics/summarize
 *
 * @param analysisId - Analysis ID to summarize
 * @param useLLM - Whether to use LLM for summarization
 */
export const summarizeSchema = z.object({
  analysisId: z.string().min(1).max(500),
  useLLM: strictBoolean.optional().default(false),
});

export type SummarizeInput = z.infer<typeof summarizeSchema>;

// ============================================================================
// Response Schemas
// ============================================================================

/**
 * Error response schema
 */
export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});

/**
 * Success response schema with data
 */
export const successResponseSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.object({
    data: dataSchema,
  });

/**
 * Finding response schema (as returned by API)
 */
export const findingResponseSchema = findingSchema.extend({
  id: z.string(),
  analysisId: z.string(),
  createdAt: z.string(),
});

/**
 * Run response schema
 */
export const runResponseSchema = z.object({
  runId: z.string(),
  analysisId: z.string(),
  projectId: z.string(),
  treeHash: z.string(),
  commitHash: z.string().optional(),
  tool: z.object({
    name: z.string(),
    version: z.string(),
  }),
  configHash: z.string(),
  environmentHash: z.string().optional(),
  status: toolStatusSchema,
  createdAt: z.string(),
  durationMs: z.number().optional(),
  findingsDigest: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Diff response schema
 */
export const diffResponseSchema = z.object({
  introduced: z.array(findingResponseSchema),
  resolved: z.array(findingResponseSchema),
  unchanged: z.array(findingResponseSchema),
});
