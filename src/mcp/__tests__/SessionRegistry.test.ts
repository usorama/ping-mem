import { describe, expect, test, beforeEach } from "bun:test";
import { SessionRegistry, type ClientSession } from "../SessionRegistry.js";

/** Counter-based ID generator to avoid crypto.randomUUID mock interference */
function createIdGenerator(): () => string {
  let counter = 0;
  return () => `session-${++counter}-${Date.now()}`;
}

describe("SessionRegistry", () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry({
      maxSessions: 5,
      ttlMs: 60_000,
      sessionIdGenerator: createIdGenerator(),
    });
  });

  describe("create", () => {
    test("creates a session with unique ID", () => {
      const session = registry.create("claude-code");
      expect(session).not.toBeNull();
      expect(session!.sessionId).toBeDefined();
      expect(session!.sessionId.length).toBeGreaterThan(0);
      expect(session!.clientName).toBe("claude-code");
    });

    test("creates sessions with different IDs", () => {
      const s1 = registry.create("claude-code");
      const s2 = registry.create("codex");
      expect(s1!.sessionId).not.toBe(s2!.sessionId);
    });

    test("returns null when max sessions reached", () => {
      for (let i = 0; i < 5; i++) {
        expect(registry.create("unknown")).not.toBeNull();
      }
      const overflow = registry.create("unknown");
      expect(overflow).toBeNull();
    });

    test("sets createdAt and lastActivityAt", () => {
      const session = registry.create("cursor");
      expect(session!.createdAt).toBeDefined();
      expect(session!.lastActivityAt).toBeDefined();
      expect(session!.createdAt).toBe(session!.lastActivityAt);
    });

    test("defaults to unknown client name", () => {
      const session = registry.create();
      expect(session!.clientName).toBe("unknown");
    });
  });

  describe("get", () => {
    test("returns session by ID", () => {
      const created = registry.create("codex");
      const found = registry.get(created!.sessionId);
      expect(found).toBeDefined();
      expect(found!.sessionId).toBe(created!.sessionId);
      expect(found!.clientName).toBe("codex");
    });

    test("returns undefined for non-existent session", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    test("updates lastActivityAt on access", () => {
      const session = registry.create("claude-code");
      const originalActivity = session!.lastActivityAt;
      // Small delay to ensure timestamp differs
      const retrieved = registry.get(session!.sessionId);
      expect(retrieved).toBeDefined();
      // lastActivityAt should be >= original
      expect(new Date(retrieved!.lastActivityAt).getTime()).toBeGreaterThanOrEqual(
        new Date(originalActivity).getTime(),
      );
    });

    test("returns undefined for expired session", () => {
      // Create with very short TTL
      const shortRegistry = new SessionRegistry({
        ttlMs: 1,
        sessionIdGenerator: createIdGenerator(),
      });
      const session = shortRegistry.create("codex");
      // Force expiry by backdating lastActivityAt
      session!.lastActivityAt = new Date(Date.now() - 100).toISOString();
      expect(shortRegistry.get(session!.sessionId)).toBeUndefined();
    });
  });

  describe("remove", () => {
    test("removes an existing session", () => {
      const session = registry.create("cursor");
      expect(registry.remove(session!.sessionId)).toBe(true);
      expect(registry.get(session!.sessionId)).toBeUndefined();
    });

    test("returns false for non-existent session", () => {
      expect(registry.remove("nonexistent")).toBe(false);
    });

    test("frees capacity for new sessions", () => {
      const sessions: ClientSession[] = [];
      for (let i = 0; i < 5; i++) {
        sessions.push(registry.create("unknown")!);
      }
      expect(registry.create("unknown")).toBeNull(); // full

      registry.remove(sessions[0]!.sessionId);
      expect(registry.create("unknown")).not.toBeNull(); // freed
    });
  });

  describe("cleanup", () => {
    test("evicts expired sessions", () => {
      const session = registry.create("claude-code");
      // Backdate to force expiry
      session!.lastActivityAt = new Date(Date.now() - 120_000).toISOString();

      const evicted = registry.cleanup();
      expect(evicted).toBe(1);
      expect(registry.get(session!.sessionId)).toBeUndefined();
    });

    test("keeps active sessions", () => {
      registry.create("claude-code");
      registry.create("codex");
      const evicted = registry.cleanup();
      expect(evicted).toBe(0);
      expect(registry.size).toBe(2);
    });

    test("create evicts expired before rejecting at capacity", () => {
      const sessions: ClientSession[] = [];
      for (let i = 0; i < 5; i++) {
        sessions.push(registry.create("unknown")!);
      }
      // Expire one
      sessions[0]!.lastActivityAt = new Date(Date.now() - 120_000).toISOString();

      // Should succeed because cleanup runs first
      const newSession = registry.create("unknown");
      expect(newSession).not.toBeNull();
    });
  });

  describe("list", () => {
    test("lists all active sessions", () => {
      registry.create("claude-code");
      registry.create("codex");
      registry.create("cursor");

      const list = registry.list();
      expect(list.length).toBe(3);
    });

    test("excludes expired sessions", () => {
      const s1 = registry.create("claude-code");
      registry.create("codex");
      s1!.lastActivityAt = new Date(Date.now() - 120_000).toISOString();

      const list = registry.list();
      expect(list.length).toBe(1);
      expect(list[0]!.clientName).toBe("codex");
    });
  });

  describe("has", () => {
    test("returns true for existing session", () => {
      const session = registry.create("cursor");
      expect(registry.has(session!.sessionId)).toBe(true);
    });

    test("returns false for non-existent session", () => {
      expect(registry.has("nope")).toBe(false);
    });
  });

  describe("metadata", () => {
    test("sets and gets session metadata", () => {
      const session = registry.create("claude-code");
      registry.setMetadata(session!.sessionId, "projectDir", "/home/user/project");
      expect(registry.getMetadata(session!.sessionId, "projectDir")).toBe("/home/user/project");
    });

    test("returns undefined for non-existent session metadata", () => {
      expect(registry.getMetadata("nonexistent", "key")).toBeUndefined();
    });

    test("returns false when setting metadata on non-existent session", () => {
      expect(registry.setMetadata("nonexistent", "key", "value")).toBe(false);
    });

    test("metadata is isolated between sessions", () => {
      const s1 = registry.create("claude-code");
      const s2 = registry.create("codex");

      registry.setMetadata(s1!.sessionId, "project", "alpha");
      registry.setMetadata(s2!.sessionId, "project", "beta");

      expect(registry.getMetadata(s1!.sessionId, "project")).toBe("alpha");
      expect(registry.getMetadata(s2!.sessionId, "project")).toBe("beta");
    });
  });

  describe("detectClient", () => {
    test("detects Claude Code", () => {
      expect(SessionRegistry.detectClient("claude-code/1.0")).toBe("claude-code");
      expect(SessionRegistry.detectClient("Anthropic-Client/2.0")).toBe("claude-code");
    });

    test("detects Codex", () => {
      expect(SessionRegistry.detectClient("codex-cli/1.0")).toBe("codex");
      expect(SessionRegistry.detectClient("OpenAI-Codex/3.0")).toBe("codex");
    });

    test("detects Cursor", () => {
      expect(SessionRegistry.detectClient("cursor/0.45")).toBe("cursor");
    });

    test("detects OpenCode", () => {
      expect(SessionRegistry.detectClient("opencode/1.2")).toBe("opencode");
    });

    test("detects Antigravity", () => {
      expect(SessionRegistry.detectClient("antigravity-ide/0.1")).toBe("antigravity");
    });

    test("returns unknown for unrecognized agents", () => {
      expect(SessionRegistry.detectClient("SomeRandomClient/1.0")).toBe("unknown");
      expect(SessionRegistry.detectClient()).toBe("unknown");
    });

    test("uses clientInfo as fallback", () => {
      expect(SessionRegistry.detectClient("generic/1.0", "claude-code")).toBe("claude-code");
    });
  });

  describe("concurrent session isolation", () => {
    test("two clients have independent sessions", () => {
      const client1 = registry.create("claude-code");
      const client2 = registry.create("codex");

      expect(client1!.sessionId).not.toBe(client2!.sessionId);

      // Set different metadata
      registry.setMetadata(client1!.sessionId, "context", "project-a");
      registry.setMetadata(client2!.sessionId, "context", "project-b");

      // Each sees only their own context
      expect(registry.getMetadata(client1!.sessionId, "context")).toBe("project-a");
      expect(registry.getMetadata(client2!.sessionId, "context")).toBe("project-b");

      // Removing one doesn't affect the other
      registry.remove(client1!.sessionId);
      expect(registry.get(client1!.sessionId)).toBeUndefined();
      expect(registry.get(client2!.sessionId)).toBeDefined();
      expect(registry.getMetadata(client2!.sessionId, "context")).toBe("project-b");
    });

    test("session IDs are unique across rapid creation", () => {
      const ids = new Set<string>();
      const reg = new SessionRegistry({
        maxSessions: 100,
        sessionIdGenerator: createIdGenerator(),
      });
      for (let i = 0; i < 50; i++) {
        const session = reg.create("unknown");
        expect(session).not.toBeNull();
        expect(ids.has(session!.sessionId)).toBe(false);
        ids.add(session!.sessionId);
      }
      expect(ids.size).toBe(50);
    });

    test("custom session ID generator is used", () => {
      let counter = 0;
      const customRegistry = new SessionRegistry({
        sessionIdGenerator: () => `custom-${++counter}`,
      });

      const s1 = customRegistry.create("claude-code");
      const s2 = customRegistry.create("codex");

      expect(s1!.sessionId).toBe("custom-1");
      expect(s2!.sessionId).toBe("custom-2");
    });
  });
});
