import { beforeEach, describe, expect, test } from "bun:test";
import { DiagnosticsStore } from "../../../diagnostics/DiagnosticsStore.js";
import { SessionManager } from "../../../session/SessionManager.js";
import { createInMemoryEventStore, type EventStore } from "../../../storage/EventStore.js";
import { renderMiningTable } from "../partials/mining.js";

describe("Mining UI", () => {
  let eventStore: EventStore;
  let sessionManager: SessionManager;
  let diagnosticsStore: DiagnosticsStore;

  beforeEach(() => {
    eventStore = createInMemoryEventStore();
    sessionManager = new SessionManager({ eventStore });
    diagnosticsStore = new DiagnosticsStore({ dbPath: ":memory:" });
  });

  test("renders recent transcript mined events in the dashboard", async () => {
    await eventStore.createEvent("system", "TRANSCRIPT_MINED", {
      sessionFile: "/tmp/sessions/demo-session.jsonl",
      project: "rankforge",
      factsExtracted: 3,
    });

    const { tableHtml } = await renderMiningTable({
      eventStore,
      sessionManager,
      diagnosticsStore,
    });

    expect(tableHtml).toContain("Recent Mined Transcripts");
    expect(tableHtml).toContain("demo-session.jsonl");
    expect(tableHtml).toContain("rankforge");
    expect(tableHtml).toContain("facts extracted");
    expect(tableHtml).toContain(">3<");
  });

  test("shows empty mined transcript state when no mining events exist", async () => {
    const { tableHtml } = await renderMiningTable({
      eventStore,
      sessionManager,
      diagnosticsStore,
    });

    expect(tableHtml).toContain("Recent Mined Transcripts");
    expect(tableHtml).toContain("No transcript mining events recorded yet.");
  });
});
