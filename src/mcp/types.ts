/**
 * Tool module types for PingMemServer decomposition.
 *
 * Defines the ToolDefinition and ToolModule interfaces used by
 * all handler modules.
 *
 * @module mcp/types
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolModule {
  readonly tools: ToolDefinition[];
  handle(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> | undefined;
}
