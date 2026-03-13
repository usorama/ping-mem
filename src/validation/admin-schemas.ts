/**
 * Zod validation schemas for Admin API endpoints
 *
 * Provides input validation for all admin API request bodies
 * to prevent injection attacks, type coercion issues, and ensure
 * data integrity.
 *
 * @module validation/admin-schemas
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
 * Project ID schema — accepts SHA-256 hex strings (64 chars).
 * ProjectIds are computed as SHA-256(remoteUrl + "::" + relativeToGitRoot).
 */
const projectIdSchema = nonEmptyString.regex(
  /^[a-f0-9]{64}$/,
  "projectId must be a 64-character lowercase hex string (SHA-256)"
);

// ============================================================================
// Delete Project Schema
// ============================================================================

/**
 * Request body for DELETE /api/admin/projects
 *
 * Exactly one of `projectDir` or `projectId` must be provided.
 */
export const deleteProjectSchema = z
  .object({
    // projectDir uses its own schema with a PATH_MAX-aligned max (4096 bytes on Linux, 1024 on
    // macOS) rather than nonEmptyString's 10,000-char limit, to avoid submitting overly long
    // paths to path.resolve / fs APIs that have OS-level limits.
    // .trim() precedes .min(1) so the minimum-length check fires on the post-trim value:
    // whitespace-only strings (e.g. "   ") trim to "" and are rejected by min(1).
    projectDir: z.string().trim().min(1).max(4096).optional(),
    projectId: projectIdSchema.optional(),
  })
  // Refinement order matters: the "at least one" check must come first so that when both
  // are undefined it fires with the correct "required" message before the "not-both" check
  // runs. If the order were swapped, undefined-undefined would reach the wrong error.
  .refine(
    (data) => data.projectDir !== undefined || data.projectId !== undefined,
    { message: "Either projectDir or projectId is required" }
  )
  .refine(
    (data) => !(data.projectDir !== undefined && data.projectId !== undefined),
    { message: "Provide only one of projectDir or projectId, not both" }
  );

export type DeleteProjectInput = z.infer<typeof deleteProjectSchema>;

// ============================================================================
// Rotate Key Schema
// ============================================================================

/**
 * Request body for POST /api/admin/keys/rotate
 *
 * @param deactivateOld - If true, deactivate the old key after creating new one
 */
export const rotateKeySchema = z.object({
  deactivateOld: strictBoolean.optional().default(false),
});

export type RotateKeyInput = z.infer<typeof rotateKeySchema>;

// ============================================================================
// Deactivate Key Schema
// ============================================================================

/**
 * Request body for POST /api/admin/keys/deactivate
 *
 * @param id - The key ID to deactivate
 */
export const deactivateKeySchema = z.object({
  // Lowercase-only UUID: the /i flag was intentionally removed.
  // API key IDs are stored in the DB as lowercase; accepting uppercase UUIDs via /i
  // would cause the deactivateApiKey call to silently no-op (no matching row).
  id: nonEmptyString.regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "id must be a valid UUID in lowercase (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)"
  ),
});

export type DeactivateKeyInput = z.infer<typeof deactivateKeySchema>;

// ============================================================================
// LLM Config Schema
// ============================================================================

/**
 * Supported LLM providers.
 * Exported so admin.ts can reference the same list without duplication.
 */
export const SUPPORTED_PROVIDERS = [
  "OpenAI",
  "Anthropic",
  "OpenRouter",
  "Gemini",
  "Mistral",
  "Groq",
  "Cohere",
  "Together",
  "Perplexity",
  "Azure OpenAI",
  "Bedrock",
  "DeepSeek",
  "xAI",
  "Fireworks",
  "Custom",
] as const;

/**
 * Request body for POST /api/admin/llm-config
 *
 * @param provider - LLM provider name (must be one of SUPPORTED_PROVIDERS)
 * @param apiKey - API key for the provider
 * @param model - Optional model name/identifier
 * @param baseUrl - Optional base URL for custom/enterprise endpoints
 */
export const setLLMConfigSchema = z.object({
  provider: z.enum(SUPPORTED_PROVIDERS, {
    message: "provider must be one of: " + SUPPORTED_PROVIDERS.join(", "),
  }),
  // .trim() must precede .min(1) so that the minimum-length check fires on the post-trim value.
  // With .min(1).trim(), a whitespace-only string passes min(1) (pre-trim length > 0) then
  // trims to "" — an empty key/model would be silently stored.
  apiKey: z.string().trim().min(1).max(10_000),
  model: z.string().trim().min(1).max(500).optional(),
  baseUrl: z.preprocess(
    // Treat empty or whitespace-only string as "unset" — allows the UI to clear the field
    // by submitting an empty input without triggering a URL validation error.
    (val) => (typeof val === "string" && val.trim() === "" ? undefined : val),
    z
      .string()
      .url()
      .max(2_000)
      // Restrict to http/https only — arbitrary schemes (file://, ftp://, javascript://)
      // could be used for SSRF if baseUrl is later used to make outbound HTTP requests.
      // try-catch: if the URL is unparseable (already caught by .url()), return true so this
      // refinement does not emit a misleading "must use http or https" error alongside the
      // "Invalid URL" error from .url(). Only emit scheme errors for genuinely parseable URLs.
      .refine(
        (url) => {
          try {
            const proto = new URL(url).protocol;
            return proto === "http:" || proto === "https:";
          } catch {
            return true; // Not a valid URL — let z.string().url() report the parse error
          }
        },
        "baseUrl must use http or https scheme"
      )
      .optional()
  ),
});

export type SetLLMConfigInput = z.infer<typeof setLLMConfigSchema>;

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
 * Project data schema
 */
export const projectDataSchema = z.object({
  projectId: z.string(),
  projectDir: z.string(),
  lastIngestedAt: z.string().optional(),
  fileCount: z.number().int().nonnegative().optional(),
  chunkCount: z.number().int().nonnegative().optional(),
});

/**
 * API key data schema
 */
export const apiKeyDataSchema = z.object({
  id: z.string(),
  last4: z.string().length(4),
  createdAt: z.string(),
  active: z.boolean(),
});

/**
 * LLM config data schema
 */
export const llmConfigDataSchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  hasApiKey: z.boolean(),
});
