import { describe, it, expect } from "bun:test";

// Test that the TOOLS array includes the 4 new causal tools with correct schemas
import { TOOLS } from "../PingMemServer.js";

describe("PingMemServer - Causal Tools Registration", () => {
  it("should include search_causes tool with entityId required", () => {
    const tool = TOOLS.find(t => t.name === "search_causes");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toContain("entityId");
  });

  it("should include search_causes tool with query as optional field", () => {
    const tool = TOOLS.find(t => t.name === "search_causes");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.properties).toHaveProperty("query");
  });

  it("should include search_effects tool with entityId required", () => {
    const tool = TOOLS.find(t => t.name === "search_effects");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toContain("entityId");
  });

  it("should include search_effects tool with query as optional field", () => {
    const tool = TOOLS.find(t => t.name === "search_effects");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.properties).toHaveProperty("query");
  });

  it("should include get_causal_chain tool with startEntityId and endEntityId required", () => {
    const tool = TOOLS.find(t => t.name === "get_causal_chain");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toContain("startEntityId");
    expect(tool?.inputSchema.required).toContain("endEntityId");
  });

  it("should include trigger_causal_discovery tool with text required", () => {
    const tool = TOOLS.find(t => t.name === "trigger_causal_discovery");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toContain("text");
  });

  it("should include trigger_causal_discovery tool with optional persist flag", () => {
    const tool = TOOLS.find(t => t.name === "trigger_causal_discovery");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.properties).toHaveProperty("persist");
    // persist should not be required
    expect(tool?.inputSchema.required).not.toContain("persist");
  });

  it("should have exactly 4 causal tools", () => {
    const causalToolNames = ["search_causes", "search_effects", "get_causal_chain", "trigger_causal_discovery"];
    const causalTools = TOOLS.filter(t => causalToolNames.includes(t.name));
    expect(causalTools.length).toBe(4);
  });
});
