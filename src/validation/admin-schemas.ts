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
 * Project ID schema (format: ping-mem-<base58>)
 * Validates format but doesn't enforce strict base58 for flexibility
 */
const projectIdSchema = nonEmptyString.regex(
  /^ping-mem-[a-zA-Z0-9]+$/,
  "projectId must start with 'ping-mem-' followed by alphanumeric characters"
);

// ============================================================================
// Delete Project Schema
// ============================================================================

/**
 * Request body for DELETE /api/admin/projects
 *
 * Exactly one of `projectDir` or `projectId` must be provided.
 */
export const deleteProjectSchema = z.object({
  projectDir: optionalString.refine(
    (val) => val === undefined || val.length > 0,
    "projectDir cannot be empty string"
  ),
  projectId: projectIdSchema.optional(),
}).refine(
  (data) => data.projectDir !== undefined || data.projectId !== undefined,
  { message: "Either projectDir or projectId is required" }
).refine(
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
  id: nonEmptyString.regex(
    /^[a-f0-9-]+$/,
    "id must be a valid UUID or hex string"
  ),
});

export type DeactivateKeyInput = z.infer<typeof deactivateKeySchema>;

// ============================================================================
// LLM Config Schema
// ============================================================================

/**
 * Supported LLM providers
 */
const SUPPORTED_PROVIDERS = [
  "OpenAI",
  "Anthropic",
  "OpenRouter",
  "zAI",
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
  apiKey: z.string().min(1).max(10_000).trim(),
  model: z.string().min(1).max(500).trim().optional(),
  baseUrl: z.string().url().max(2_000).optional().or(z.literal("")),
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
