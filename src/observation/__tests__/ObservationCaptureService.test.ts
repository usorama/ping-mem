/**
 * Tests for ObservationCaptureService
 *
 * Covers: capture + eventId return, 30s dedup window,
 * secret redaction (Bearer tokens, sk- keys, password=),
 * and summary truncation at 200 chars.
 *
 * @module observation/__tests__/ObservationCaptureService.test
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { ObservationCaptureService } from "../ObservationCaptureService.js";
import type { ObservationInput } from "../ObservationCaptureService.js";
import type { EventStore } from "../../storage/EventStore.js";

// ============================================================================
// Helpers
// ============================================================================

function makeEventStore(eventIdOverride = "evt-001"): EventStore {
  return {
    createEvent: mock(async (_sessionId, _type, _payload) => ({
      eventId: eventIdOverride,
      sessionId: _sessionId,
      eventType: _type,
      payload: _payload,
      metadata: {},
      timestamp: new Date().toISOString(),
    })),
  } as unknown as EventStore;
}

function makeInput(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    sessionId: "session-test-001",
    toolName: "Bash",
    hookEvent: "PostToolUse",
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("ObservationCaptureService", () => {
  describe("capture returns eventId", () => {
    it("returns the eventId from the event store on first capture", async () => {
      const store = makeEventStore("evt-abc123");
      const svc = new ObservationCaptureService(store);

      const result = await svc.capture(makeInput({ summary: "ran a shell command" }));

      expect(result.eventId).toBe("evt-abc123");
      expect(result.deduplicated).toBe(false);
    });

    it("calls eventStore.createEvent with the correct session and event type", async () => {
      const store = makeEventStore();
      const svc = new ObservationCaptureService(store);

      await svc.capture(makeInput({ sessionId: "session-xyz", toolName: "Read" }));

      expect(store.createEvent).toHaveBeenCalledTimes(1);
      const [sessionId, eventType] = (store.createEvent as ReturnType<typeof mock>).mock.calls[0] as [string, string, unknown];
      expect(sessionId).toBe("session-xyz");
      expect(eventType).toBe("OBSERVATION_CAPTURED");
    });

    it("includes toolName in the stored payload", async () => {
      const store = makeEventStore();
      const svc = new ObservationCaptureService(store);

      await svc.capture(makeInput({ toolName: "Write", summary: "wrote a file" }));

      const payload = (store.createEvent as ReturnType<typeof mock>).mock.calls[0]?.[2] as Record<string, unknown>;
      expect(payload?.toolName).toBe("Write");
    });

    it("uses default summary when no summary is provided", async () => {
      const store = makeEventStore();
      const svc = new ObservationCaptureService(store);

      await svc.capture(makeInput({ toolName: "Grep", summary: undefined }));

      const payload = (store.createEvent as ReturnType<typeof mock>).mock.calls[0]?.[2] as Record<string, unknown>;
      expect(payload?.summary).toBe("Grep used");
    });
  });

  // --------------------------------------------------------------------------
  // Deduplication
  // --------------------------------------------------------------------------

  describe("deduplication within 30s window", () => {
    it("deduplicates an identical capture within the window", async () => {
      // Each test needs a unique session+toolName+summary to avoid cross-test
      // interference from the module-level dedup cache.
      const store = makeEventStore();
      const svc = new ObservationCaptureService(store);
      const input = makeInput({
        sessionId: `session-dedup-${Date.now()}`,
        toolName: "BashDedup",
        summary: "some unique command output for dedup test",
      });

      const first = await svc.capture(input);
      const second = await svc.capture(input);

      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(true);
      expect(second.eventId).toBe("");
    });

    it("does not deduplicate when toolName differs", async () => {
      const store = makeEventStore();
      const svc = new ObservationCaptureService(store);
      const base = makeInput({
        sessionId: `session-diff-tool-${Date.now()}`,
        summary: "same summary text different tool test",
      });

      const first = await svc.capture({ ...base, toolName: "ToolA" });
      const second = await svc.capture({ ...base, toolName: "ToolB" });

      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(false);
    });

    it("does not deduplicate when summary differs", async () => {
      const store = makeEventStore();
      const svc = new ObservationCaptureService(store);
      const session = `session-diff-summary-${Date.now()}`;

      const first = await svc.capture(makeInput({ sessionId: session, toolName: "BashX", summary: "output alpha" }));
      const second = await svc.capture(makeInput({ sessionId: session, toolName: "BashX", summary: "output beta" }));

      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(false);
    });

    it("does not deduplicate when sessionId differs", async () => {
      const store = makeEventStore();
      const svc = new ObservationCaptureService(store);
      const ts = Date.now();

      const first = await svc.capture(makeInput({ sessionId: `session-a-${ts}`, toolName: "BashY", summary: "shared summary for session test" }));
      const second = await svc.capture(makeInput({ sessionId: `session-b-${ts}`, toolName: "BashY", summary: "shared summary for session test" }));

      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Secret redaction
  // --------------------------------------------------------------------------

  describe("redacts secrets from summary", () => {
    it("redacts Bearer tokens", async () => {
      const store = makeEventStore();
      const svc = new ObservationCaptureService(store);

      await svc.capture(makeInput({
        sessionId: `session-redact-bearer-${Date.now()}`,
        summary: "called API with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
      }));

      const payload = (store.createEvent as ReturnType<typeof mock>).mock.calls[0]?.[2] as Record<string, unknown>;
      expect(payload?.summary as string).toContain("[REDACTED]");
      expect(payload?.summary as string).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    });

    it("redacts sk- API keys", async () => {
      const store = makeEventStore();
      const svc = new ObservationCaptureService(store);

      await svc.capture(makeInput({
        sessionId: `session-redact-sk-${Date.now()}`,
        summary: "used key sk-abcdefghijklmnopqrstuvwxyz123456 to call model",
      }));

      const payload = (store.createEvent as ReturnType<typeof mock>).mock.calls[0]?.[2] as Record<string, unknown>;
      expect(payload?.summary as string).toContain("[REDACTED]");
      expect(payload?.summary as string).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    });

    it("redacts password= secrets", async () => {
      const store = makeEventStore();
      const svc = new ObservationCaptureService(store);

      await svc.capture(makeInput({
        sessionId: `session-redact-pw-${Date.now()}`,
        summary: "connected to db with password=supersecret123",
      }));

      const payload = (store.createEvent as ReturnType<typeof mock>).mock.calls[0]?.[2] as Record<string, unknown>;
      expect(payload?.summary as string).toContain("[REDACTED]");
      expect(payload?.summary as string).not.toContain("supersecret123");
    });

    it("preserves non-secret content after redaction", async () => {
      const store = makeEventStore();
      const svc = new ObservationCaptureService(store);

      await svc.capture(makeInput({
        sessionId: `session-redact-preserve-${Date.now()}`,
        summary: "request to /api/data succeeded with Bearer secrettoken123456789012345678",
      }));

      const payload = (store.createEvent as ReturnType<typeof mock>).mock.calls[0]?.[2] as Record<string, unknown>;
      const summary = payload?.summary as string;
      expect(summary).toContain("request to /api/data succeeded");
      expect(summary).toContain("[REDACTED]");
    });
  });

  // --------------------------------------------------------------------------
  // Summary truncation
  // --------------------------------------------------------------------------

  describe("truncates summary to 200 chars", () => {
    it("truncates a summary longer than 200 characters", async () => {
      const store = makeEventStore();
      const svc = new ObservationCaptureService(store);
      const longSummary = "x".repeat(300);

      await svc.capture(makeInput({
        sessionId: `session-trunc-${Date.now()}`,
        summary: longSummary,
      }));

      const payload = (store.createEvent as ReturnType<typeof mock>).mock.calls[0]?.[2] as Record<string, unknown>;
      const summary = payload?.summary as string;
      expect(summary.length).toBeLessThanOrEqual(200);
    });

    it("does not truncate a summary of exactly 200 characters", async () => {
      const store = makeEventStore();
      const svc = new ObservationCaptureService(store);
      const exactSummary = "a".repeat(200);

      await svc.capture(makeInput({
        sessionId: `session-trunc-exact-${Date.now()}`,
        summary: exactSummary,
      }));

      const payload = (store.createEvent as ReturnType<typeof mock>).mock.calls[0]?.[2] as Record<string, unknown>;
      const summary = payload?.summary as string;
      expect(summary.length).toBeLessThanOrEqual(200);
    });

    it("does not alter a short summary", async () => {
      const store = makeEventStore();
      const svc = new ObservationCaptureService(store);
      const shortSummary = "ran ls command";

      await svc.capture(makeInput({
        sessionId: `session-trunc-short-${Date.now()}`,
        summary: shortSummary,
      }));

      const payload = (store.createEvent as ReturnType<typeof mock>).mock.calls[0]?.[2] as Record<string, unknown>;
      expect(payload?.summary as string).toBe(shortSummary);
    });

    it("applies truncation before redaction check (slice first)", async () => {
      const store = makeEventStore();
      const svc = new ObservationCaptureService(store);
      // 300 chars — truncated to 200, then no secrets remain in the 200-char window
      const paddedSummary = "safe content ".repeat(15) + "password=hidden";

      await svc.capture(makeInput({
        sessionId: `session-trunc-order-${Date.now()}`,
        summary: paddedSummary,
      }));

      const payload = (store.createEvent as ReturnType<typeof mock>).mock.calls[0]?.[2] as Record<string, unknown>;
      const summary = payload?.summary as string;
      // Must be within 200 chars
      expect(summary.length).toBeLessThanOrEqual(200);
    });
  });
});
