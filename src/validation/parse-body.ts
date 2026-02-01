/**
 * Request body parsing utilities with Zod validation
 *
 * Provides type-safe request body parsing with automatic validation
 * and error handling. Works with Node.js HTTP IncomingMessage.
 *
 * @module validation/parse-body
 */

import type { IncomingMessage } from "node:http";
import type { ZodSchema } from "zod";
import { ZodError } from "zod";
import { z } from "zod";

// ============================================================================
// Error Types
// ============================================================================

/**
 * Validation error with detailed field-level errors
 */
export class ValidationError extends Error {
  public readonly fieldErrors: Record<string, string>;

  constructor(message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = "ValidationError";
    this.fieldErrors = fieldErrors;
  }
}

// ============================================================================
// Response Types
// ============================================================================

/**
 * Type-safe parse result
 */
export interface ParseResult<T> {
  success: true;
  data: T;
}

/**
 * Parse error with details
 */
export interface ParseError {
  success: false;
  error: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Union type for parse results
 */
export type ParseBodyResult<T> = ParseResult<T> | ParseError;

// ============================================================================
// Body Parsing Functions
// ============================================================================

/**
 * Read and parse JSON from an IncomingMessage
 *
 * @param req - The HTTP request to read from
 * @returns Parsed JSON object or empty object if body is empty/invalid
 *
 * @example
 * ```ts
 * const body = await readJsonBody(req);
 * const userId = body.userId as string | undefined;
 * ```
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");

  // Check for empty body
  if (raw.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    // Return empty object for invalid JSON
    // (validation will catch missing required fields)
    return {};
  }
}

/**
 * Parse and validate request body using a Zod schema
 *
 * This function:
 * 1. Reads the JSON body from the request
 * 2. Validates it against the provided schema
 * 3. Returns a type-safe result
 *
 * @param req - The HTTP request to read from
 * @param schema - Zod schema to validate against
 * @returns Parse result with typed data or error details
 *
 * @example
 * ```ts
 * import { deleteProjectSchema } from "./admin-schemas.js";
 * import { parseBody } from "./parse-body.js";
 *
 * const result = await parseBody(req, deleteProjectSchema);
 * if (!result.success) {
 *   return respondJson(res, 400, { error: result.error });
 * }
 * const { projectDir, projectId } = result.data;
 * ```
 */
export async function parseBody<T extends ZodSchema>(
  req: IncomingMessage,
  schema: T
): Promise<ParseBodyResult<z.infer<T>>> {
  // Read raw JSON
  const body = await readJsonBody(req);

  // Validate against schema
  const result = schema.safeParse(body);

  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }

  // Extract field-level errors
  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join(".");
    fieldErrors[path] = issue.message;
  }

  // Get first error message for summary
  const firstError = result.error.issues[0];
  const errorMessage = firstError?.message ?? "Validation failed";

  return {
    success: false,
    error: errorMessage,
    fieldErrors,
  };
}

/**
 * Format Zod error for API response
 *
 * @param error - The Zod error to format
 * @returns Formatted error object suitable for API responses
 *
 * @example
 * ```ts
 * import { formatZodError } from "./parse-body.js";
 *
 * try {
 *   schema.parse(data);
 * } catch (error) {
 *   if (error instanceof ZodError) {
 *     return respondJson(res, 400, formatZodError(error));
 *   }
 * }
 * ```
 */
export function formatZodError(error: ZodError): {
  error: string;
  message: string;
  fieldErrors?: Record<string, string>;
} {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".");
    fieldErrors[path] = issue.message;
  }

  const result: {
    error: string;
    message: string;
    fieldErrors?: Record<string, string>;
  } = {
    error: "Validation Error",
    message: error.issues[0]?.message ?? "Invalid input",
  };

  if (Object.keys(fieldErrors).length > 1) {
    result.fieldErrors = fieldErrors;
  }

  return result;
}

/**
 * Helper to check if a parse result is successful
 *
 * @param result - The parse result to check
 * @returns true if the result is successful
 *
 * @example
 * ```ts
 * import { isParseSuccess } from "./parse-body.js";
 *
 * const result = await parseBody(req, schema);
 * if (isParseSuccess(result)) {
 *   console.log(result.data); // TypeScript knows result.data exists
 * }
 * ```
 */
export function isParseSuccess<T>(
  result: ParseBodyResult<T>
): result is ParseResult<T> {
  return result.success === true;
}

/**
 * Helper to check if a parse result failed
 *
 * @param result - The parse result to check
 * @returns true if the result failed
 *
 * @example
 * ```ts
 * import { isParseError } from "./parse-body.js";
 *
 * const result = await parseBody(req, schema);
 * if (isParseError(result)) {
 *   console.log(result.error); // TypeScript knows result.error exists
 * }
 * ```
 */
export function isParseError<T>(
  result: ParseBodyResult<T>
): result is ParseError {
  return result.success === false;
}
