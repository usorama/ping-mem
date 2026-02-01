import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventStore, createInMemoryEventStore } from "../EventStore.js";
import type { SessionId } from "../../types/index.js";

describe("EventStore SQL Injection Protection", () => {
  let store: EventStore;

  beforeEach(() => {
    store = createInMemoryEventStore();
  });

  afterEach(async () => {
    await store.close();
  });

  describe("deleteSessions() SQL injection attempts", () => {
    it("should safely handle malicious session IDs with SQL injection payloads", async () => {
      // Create a legitimate session with events
      const legitimateSession = "session-legitimate-123" as SessionId;
      await store.createEvent(legitimateSession, "SESSION_STARTED", {
        projectDir: "/test/project",
      });
      await store.createEvent(legitimateSession, "CONTEXT_SAVED", {
        key: "test-key",
        value: "test-value",
      });

      // Attempt SQL injection with various payloads
      const maliciousSessionIds: SessionId[] = [
        // Classic SQL injection attempts
        "'; DROP TABLE events; --" as SessionId,
        "' OR '1'='1" as SessionId,
        "'; DELETE FROM events WHERE '1'='1" as SessionId,
        "' UNION SELECT * FROM sqlite_master; --" as SessionId,

        // Variations
        "admin'--" as SessionId,
        "' OR 1=1--" as SessionId,
        "session-1'; DROP TABLE checkpoints; --" as SessionId,
        "session' OR session_id IS NOT NULL--" as SessionId,
      ];

      // Should not throw exceptions
      expect(() => {
        store.deleteSessions(maliciousSessionIds);
      }).not.toThrow();

      // Verify legitimate session still exists (was not deleted by injection)
      const events = await store.getBySession(legitimateSession);
      expect(events.length).toBe(2);
      expect(events[0]?.eventType).toBe("SESSION_STARTED");
      expect(events[1]?.eventType).toBe("CONTEXT_SAVED");

      // Verify database integrity - tables should still exist
      const stats = store.getStats();
      expect(stats.eventCount).toBe(2); // Only legitimate events
      expect(stats.checkpointCount).toBe(0);
    });

    it("should safely delete only existing sessions with special characters", async () => {
      // Create sessions with special but valid characters
      const session1 = "session-uuid-123-abc" as SessionId;
      const session2 = "session_with_underscore" as SessionId;

      await store.createEvent(session1, "SESSION_STARTED", {});
      await store.createEvent(session2, "SESSION_STARTED", {});

      // Delete both sessions
      store.deleteSessions([session1, session2]);

      // Verify both sessions are deleted
      const events1 = await store.getBySession(session1);
      const events2 = await store.getBySession(session2);

      expect(events1.length).toBe(0);
      expect(events2.length).toBe(0);

      expect(store.getStats().eventCount).toBe(0);
    });

    it("should handle empty session ID array", () => {
      expect(() => {
        store.deleteSessions([]);
      }).not.toThrow();

      expect(store.getStats().eventCount).toBe(0);
    });

    it("should handle non-existent session IDs without errors", () => {
      expect(() => {
        store.deleteSessions([
          "non-existent-1" as SessionId,
          "non-existent-2" as SessionId,
        ]);
      }).not.toThrow();
    });

    it("should delete all events and checkpoints for given sessions", async () => {
      const session1 = "session-1" as SessionId;
      const session2 = "session-2" as SessionId;
      const session3 = "session-3" as SessionId;

      // Create events for multiple sessions
      await store.createEvent(session1, "SESSION_STARTED", {});
      await store.createEvent(session1, "CONTEXT_SAVED", { key: "k1", value: "v1" });
      await store.createEvent(session2, "SESSION_STARTED", {});
      await store.createEvent(session3, "SESSION_STARTED", {});

      // Create checkpoint for session1
      await store.createCheckpoint(session1, 1, "test checkpoint");

      expect(store.getStats().eventCount).toBe(4);
      expect(store.getStats().checkpointCount).toBe(1);

      // Delete session1 and session2
      store.deleteSessions([session1, session2]);

      // Verify only session3 events remain
      const session1Events = await store.getBySession(session1);
      const session2Events = await store.getBySession(session2);
      const session3Events = await store.getBySession(session3);

      expect(session1Events.length).toBe(0);
      expect(session2Events.length).toBe(0);
      expect(session3Events.length).toBe(1);

      expect(store.getStats().eventCount).toBe(1); // Only session3 event
      expect(store.getStats().checkpointCount).toBe(0); // Checkpoint deleted
    });

    it("should use parameterized queries (not string interpolation)", async () => {
      // This test verifies the fix by attempting injection that would work
      // if string interpolation was used, but should fail with parameterized queries

      const session1 = "session-1" as SessionId;
      await store.createEvent(session1, "SESSION_STARTED", {});

      // If code used: `DELETE FROM events WHERE session_id IN ('${id}')`
      // Then this would delete all events:
      const injectionAttempt = "') OR session_id IS NOT NULL--" as SessionId;

      store.deleteSessions([injectionAttempt]);

      // Verify session1 still exists (injection failed)
      const events = await store.getBySession(session1);
      expect(events.length).toBe(1);
      expect(store.getStats().eventCount).toBe(1);
    });
  });

  describe("findSessionIdsByProjectDir() safety", () => {
    it("should safely handle malicious project directory paths", async () => {
      const legitimateSession = "session-1" as SessionId;
      await store.createEvent(
        legitimateSession,
        "SESSION_STARTED",
        {},
        { projectDir: "/path/to/project" } // projectDir is in metadata, not payload
      );

      const maliciousPaths = [
        "'; DROP TABLE events; --",
        "' OR '1'='1",
        "../../../etc/passwd",
        "$(rm -rf /)",
      ];

      for (const path of maliciousPaths) {
        const sessions = store.findSessionIdsByProjectDir(path);
        expect(sessions.length).toBe(0); // Should not find any sessions
      }

      // Verify legitimate session still exists
      const legitimateSessions = store.findSessionIdsByProjectDir("/path/to/project");
      expect(legitimateSessions.length).toBe(1);
      expect(legitimateSessions[0]).toBe(legitimateSession);
    });
  });
});
