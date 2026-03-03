/**
 * Extraction routing logic for PingMemServer.handleSave.
 *
 * Determines whether LLM extraction should be used for entity extraction
 * based on category, content length, and explicit extraction flag.
 *
 * @module mcp/extractionRouting
 */

/**
 * Determines whether LLM extraction should be used for entity extraction.
 *
 * LLM extraction is triggered when:
 * - Category is one of: decision, error, task
 * - Content is longer than 200 characters
 * - Caller explicitly requested entity extraction
 */
export function shouldUseLlmExtraction(
  category: string | undefined,
  contentLength: number,
  explicitExtract: boolean
): boolean {
  return (
    (category !== undefined && ["decision", "error", "task"].includes(category)) ||
    contentLength > 500 ||
    explicitExtract
  );
}
