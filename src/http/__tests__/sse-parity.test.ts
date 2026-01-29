import { describe, it, expect } from "bun:test";
import { SSEPingMemServer, createDefaultSSEConfig } from "../sse-server.js";

describe("SSE tool parity", () => {
  it("delegates tool calls to PingMemServer", async () => {
    const server = new SSEPingMemServer({
      ...createDefaultSSEConfig(),
      dbPath: ":memory:",
    });

    const toolServer = server.getToolServer();
    const result = await toolServer.dispatchToolCall("context_session_start", {
      name: "sse-parity-test",
    });

    expect(result).toMatchObject({ success: true });
    await server.stop();
  });
});
