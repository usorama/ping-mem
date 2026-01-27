/**
 * Tests for SessionManager
 *
 * @module session/__tests__/SessionManager.test
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { SessionManager, createSessionManager } from "../SessionManager.js";
import { createInMemoryEventStore } from "../../storage/EventStore.js";

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    const eventStore = createInMemoryEventStore();
    manager = createSessionManager({ eventStore });
  });

  afterEach(async () => {
    await manager.close();
  });

  describe("Session Creation", () => {
    it("should start a new session", async () => {
      const session = await manager.startSession({
        name: "Test Session",
        projectDir: "/test/project",
      });

      expect(session.id).toBeDefined();
      expect(session.name).toBe("Test Session");
      expect(session.status).toBe("active");
      expect(session.projectDir).toBe("/test/project");
      expect(session.startedAt).toBeInstanceOf(Date);
      expect(session.memoryCount).toBe(0);
      expect(session.eventCount).toBe(0);
    });

    it("should set session as active", async () => {
      const session = await manager.startSession({
        name: "Active Session",
      });

      const activeSession = manager.getActiveSession();
      expect(activeSession).not.toBeNull();
      expect(activeSession?.id).toBe(session.id);
    });

    it("should create SESSION_STARTED event", async () => {
      const session = await manager.startSession({
        name: "Test Session",
      });

      const eventStore = manager.getEventStore();
      const events = await eventStore.getBySession(session.id);

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]?.eventType).toBe("SESSION_STARTED");
    });

    it("should enforce max active sessions limit", async () => {
      const limitedManager = createSessionManager({
        eventStore: createInMemoryEventStore(),
        maxActiveSessions: 2,
      });

      await limitedManager.startSession({ name: "Session 1" });
      await limitedManager.startSession({ name: "Session 2" });

      await expect(limitedManager.startSession({ name: "Session 3" })).rejects.toThrow(
        /maximum active sessions/i
      );

      await limitedManager.close();
    });
  });

  describe("Session Lifecycle", () => {
    it("should end a session", async () => {
      const session = await manager.startSession({ name: "Test Session" });

      const endedSession = await manager.endSession(session.id, "test completed");

      expect(endedSession.status).toBe("ended");
      expect(endedSession.endedAt).toBeInstanceOf(Date);
    });

    it("should create SESSION_ENDED event", async () => {
      const session = await manager.startSession({ name: "Test Session" });
      await manager.endSession(session.id);

      const eventStore = manager.getEventStore();
      const events = await eventStore.getBySession(session.id);

      const endEvents = events.filter((e) => e.eventType === "SESSION_ENDED");
      expect(endEvents.length).toBe(1);
    });

    it("should create checkpoint when ending session", async () => {
      const session = await manager.startSession({ name: "Test Session" });
      await manager.endSession(session.id);

      const eventStore = manager.getEventStore();
      const checkpoints = await eventStore.getCheckpointsBySession(session.id);

      expect(checkpoints.length).toBeGreaterThanOrEqual(1);
    });

    it("should pause a session", async () => {
      const session = await manager.startSession({ name: "Test Session" });

      const pausedSession = await manager.pauseSession(session.id);

      expect(pausedSession.status).toBe("paused");
    });

    it("should resume a paused session", async () => {
      const session = await manager.startSession({ name: "Test Session" });
      await manager.pauseSession(session.id);

      const resumedSession = await manager.resumeSession(session.id);

      expect(resumedSession.status).toBe("active");
    });

    it("should throw error when ending non-existent session", async () => {
      await expect(manager.endSession("non-existent-id")).rejects.toThrow(/not found/i);
    });

    it("should throw error when ending already-ended session", async () => {
      const session = await manager.startSession({ name: "Test Session" });
      await manager.endSession(session.id);

      await expect(manager.endSession(session.id)).rejects.toThrow(/cannot end/i);
    });
  });

  describe("Session Continuation", () => {
    it("should continue from previous session", async () => {
      const parentSession = await manager.startSession({ name: "Parent Session" });
      await manager.incrementMemoryCount(parentSession.id, 5);

      const childSession = await manager.continueSession(parentSession.id, "Child Session");

      expect(childSession.parentSessionId).toBe(parentSession.id);
      expect(childSession.name).toBe("Child Session");
      expect(childSession.id).not.toBe(parentSession.id);
    });

    it("should load context when continuing session", async () => {
      const parentSession = await manager.startSession({
        name: "Parent Session",
        projectDir: "/test",
      });
      await manager.incrementMemoryCount(parentSession.id, 3);

      const childSession = await manager.continueSession(parentSession.id, "Child Session");

      expect(childSession.projectDir).toBe(parentSession.projectDir);
    });
  });

  describe("Session Retrieval", () => {
    it("should get session by ID", async () => {
      const session = await manager.startSession({ name: "Test Session" });

      const retrieved = manager.getSession(session.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(session.id);
    });

    it("should return null for non-existent session", () => {
      const retrieved = manager.getSession("non-existent-id");
      expect(retrieved).toBeNull();
    });

    it("should list all sessions", async () => {
      await manager.startSession({ name: "Session 1" });
      await manager.startSession({ name: "Session 2" });
      await manager.startSession({ name: "Session 3" });

      const sessions = manager.listSessions();

      expect(sessions.length).toBe(3);
    });

    it("should filter sessions by status", async () => {
      const session1 = await manager.startSession({ name: "Session 1" });
      await manager.startSession({ name: "Session 2" });
      await manager.endSession(session1.id);

      const activeSessions = manager.listSessions({ status: "active" });
      const endedSessions = manager.listSessions({ status: "ended" });

      expect(activeSessions.length).toBe(1);
      expect(endedSessions.length).toBe(1);
    });

    it("should filter sessions by project directory", async () => {
      await manager.startSession({ name: "Session 1", projectDir: "/project-a" });
      await manager.startSession({ name: "Session 2", projectDir: "/project-b" });
      await manager.startSession({ name: "Session 3", projectDir: "/project-a" });

      const projectASessions = manager.listSessions({ projectDir: "/project-a" });

      expect(projectASessions.length).toBe(2);
    });

    it("should sort sessions by most recent first", async () => {
      const session1 = await manager.startSession({ name: "Session 1" });
      
      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const session2 = await manager.startSession({ name: "Session 2" });

      const sessions = manager.listSessions();

      expect(sessions[0]?.id).toBe(session2.id);
      expect(sessions[1]?.id).toBe(session1.id);
    });
  });

  describe("Session Activity", () => {
    it("should update activity timestamp", async () => {
      const session = await manager.startSession({ name: "Test Session" });
      const originalTimestamp = session.lastActivityAt;

      // Small delay
      await new Promise(resolve => setTimeout(resolve, 10));

      await manager.updateActivity(session.id);

      const updated = manager.getSession(session.id);
      expect(updated?.lastActivityAt.getTime()).toBeGreaterThan(originalTimestamp.getTime());
    });

    it("should increment memory count", async () => {
      const session = await manager.startSession({ name: "Test Session" });

      await manager.incrementMemoryCount(session.id, 5);

      const updated = manager.getSession(session.id);
      expect(updated?.memoryCount).toBe(5);
    });

    it("should update activity when incrementing memory count", async () => {
      const session = await manager.startSession({ name: "Test Session" });
      const originalTimestamp = session.lastActivityAt;

      await new Promise(resolve => setTimeout(resolve, 10));

      await manager.incrementMemoryCount(session.id, 1);

      const updated = manager.getSession(session.id);
      expect(updated?.lastActivityAt.getTime()).toBeGreaterThan(originalTimestamp.getTime());
    });
  });

  describe("Session Statistics", () => {
    it("should get session stats", async () => {
      const session = await manager.startSession({ name: "Test Session" });
      await manager.incrementMemoryCount(session.id, 10);

      const stats = await manager.getSessionStats(session.id);

      expect(stats).not.toBeNull();
      expect(stats?.sessionId).toBe(session.id);
      expect(stats?.totalMemories).toBe(10);
      expect(stats?.totalEvents).toBeGreaterThanOrEqual(1);
    });

    it("should return null for non-existent session stats", async () => {
      const stats = await manager.getSessionStats("non-existent-id");
      expect(stats).toBeNull();
    });

    it("should calculate session duration for active session", async () => {
      const session = await manager.startSession({ name: "Test Session" });

      await new Promise(resolve => setTimeout(resolve, 100));

      const stats = await manager.getSessionStats(session.id);

      expect(stats?.durationMs).toBeGreaterThan(0);
    });

    it("should calculate session duration for ended session", async () => {
      const session = await manager.startSession({ name: "Test Session" });
      
      await new Promise(resolve => setTimeout(resolve, 50));
      
      await manager.endSession(session.id);

      const stats = await manager.getSessionStats(session.id);

      expect(stats?.durationMs).toBeGreaterThan(0);
    });
  });

  describe("Cleanup", () => {
    it("should close cleanly", async () => {
      await manager.startSession({ name: "Test Session" });

      await expect(async () => {
        await manager.close();
      }).not.toThrow();
    });
  });
});
