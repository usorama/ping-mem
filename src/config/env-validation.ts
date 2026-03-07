/**
 * Environment Variable Validation for ping-mem
 *
 * Uses Zod to validate env var consistency at startup:
 * - Admin user+pass must both be set or both unset
 * - Neo4j URI+username+password must all be set or all unset
 * - Port values must be valid numbers
 *
 * No env var is strictly required — all have defaults.
 * This validates consistency and format only.
 *
 * @module config/env-validation
 * @version 1.0.0
 */

import { z } from "zod";
import { createLogger } from "../util/logger.js";

const log = createLogger("EnvValidation");

// ============================================================================
// Schema
// ============================================================================

const portSchema = z
  .string()
  .optional()
  .refine(
    (val) => val === undefined || (Number.isInteger(Number(val)) && Number(val) > 0 && Number(val) <= 65535),
    { message: "must be a valid port number (1-65535)" }
  );

const envSchema = z.object({
  // Core
  PING_MEM_DB_PATH: z.string().optional(),
  PING_MEM_PORT: portSchema,
  PING_MEM_HOST: z.string().optional(),
  PING_MEM_TRANSPORT: z.enum(["rest", "sse", "streamable-http"]).optional(),

  // Auth
  PING_MEM_API_KEY: z.string().optional(),

  // Admin — both or neither
  PING_MEM_ADMIN_USER: z.string().optional(),
  PING_MEM_ADMIN_PASS: z.string().optional(),

  // Encryption
  PING_MEM_SECRET_KEY: z.string().optional(),

  // Neo4j — all three or none
  NEO4J_URI: z.string().optional(),
  NEO4J_USERNAME: z.string().optional(),
  NEO4J_USER: z.string().optional(),
  NEO4J_PASSWORD: z.string().optional(),
  NEO4J_DATABASE: z.string().optional(),
  NEO4J_MAX_POOL_SIZE: z
    .string()
    .optional()
    .refine(
      (val) => val === undefined || (Number.isInteger(Number(val)) && Number(val) > 0),
      { message: "must be a positive integer" }
    ),

  // Qdrant
  QDRANT_URL: z.string().optional(),
  QDRANT_COLLECTION_NAME: z.string().optional(),
  QDRANT_API_KEY: z.string().optional(),
  QDRANT_VECTOR_DIMENSIONS: z
    .string()
    .optional()
    .refine(
      (val) => val === undefined || (Number.isInteger(Number(val)) && Number(val) > 0),
      { message: "must be a positive integer" }
    ),

  // Optional integrations
  OPENAI_API_KEY: z.string().optional(),
  PING_MEM_ENABLE_LLM_SUMMARIES: z.enum(["true", "false"]).optional(),
  PING_MEM_DIAGNOSTICS_DB_PATH: z.string().optional(),
  PING_MEM_ADMIN_DB_PATH: z.string().optional(),
  PING_MEM_CORS_ORIGIN: z.string().optional(),
  PING_MEM_MAX_AGENTS: z
    .string()
    .optional()
    .refine(
      (val) => val === undefined || (Number.isInteger(Number(val)) && Number(val) > 0),
      { message: "must be a positive integer" }
    ),
});

// ============================================================================
// Consistency Checks
// ============================================================================

interface ValidationError {
  field: string;
  message: string;
}

function checkConsistency(env: Record<string, string | undefined>): ValidationError[] {
  const errors: ValidationError[] = [];

  // Admin: both user and pass must be set or both unset
  const adminUser = env.PING_MEM_ADMIN_USER;
  const adminPass = env.PING_MEM_ADMIN_PASS;
  if ((adminUser && !adminPass) || (!adminUser && adminPass)) {
    errors.push({
      field: "PING_MEM_ADMIN_USER / PING_MEM_ADMIN_PASS",
      message: "Both PING_MEM_ADMIN_USER and PING_MEM_ADMIN_PASS must be set together, or both must be unset.",
    });
  }

  // Neo4j: all three (URI+username+password) or none
  const neo4jUri = env.NEO4J_URI;
  const neo4jUsername = env.NEO4J_USERNAME ?? env.NEO4J_USER;
  const neo4jPassword = env.NEO4J_PASSWORD;
  const neo4jSet = [neo4jUri, neo4jUsername, neo4jPassword].filter(Boolean);
  if (neo4jSet.length > 0 && neo4jSet.length < 3) {
    const missing: string[] = [];
    if (!neo4jUri) missing.push("NEO4J_URI");
    if (!neo4jUsername) missing.push("NEO4J_USERNAME (or NEO4J_USER)");
    if (!neo4jPassword) missing.push("NEO4J_PASSWORD");
    errors.push({
      field: "NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD",
      message: `All three Neo4j vars must be set together. Missing: ${missing.join(", ")}`,
    });
  }

  return errors;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Validate environment variables at startup.
 *
 * Checks format (via Zod) and consistency (paired variables).
 * On failure: logs clear errors and exits with code 1.
 */
export function validateEnv(): void {
  const env = process.env;

  // 1. Schema validation (format)
  const result = envSchema.safeParse(env);
  const schemaErrors: ValidationError[] = [];
  if (!result.success) {
    for (const issue of result.error.issues) {
      schemaErrors.push({
        field: issue.path.join("."),
        message: issue.message,
      });
    }
  }

  // 2. Consistency checks
  const consistencyErrors = checkConsistency(env as Record<string, string | undefined>);

  const allErrors = [...schemaErrors, ...consistencyErrors];

  if (allErrors.length > 0) {
    log.error("Environment variable validation failed:");
    for (const err of allErrors) {
      log.error(`  ${err.field}: ${err.message}`);
    }
    process.exit(1);
  }
}
