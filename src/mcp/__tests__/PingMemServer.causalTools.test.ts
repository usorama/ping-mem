import { describe, it, expect } from "bun:test";

// Test that the TOOLS array includes the 4 new causal tools
import { TOOLS } from "../PingMemServer.js";

describe("PingMemServer - Causal Tools Registration", () => {
  it("should include search_causes tool", () => {
    const tool = TOOLS.find(t => t.name === "search_causes");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toContain("query");
  });

  it("should include search_effects tool", () => {
    const tool = TOOLS.find(t => t.name === "search_effects");
    expect(tool).toBeDefined();
  });

  it("should include get_causal_chain tool", () => {
    const tool = TOOLS.find(t => t.name === "get_causal_chain");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toContain("startEntityId");
    expect(tool?.inputSchema.required).toContain("endEntityId");
  });

  it("should include trigger_causal_discovery tool", () => {
    const tool = TOOLS.find(t => t.name === "trigger_causal_discovery");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toContain("text");
  });
});
