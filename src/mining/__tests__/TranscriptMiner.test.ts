/**
 * Tests for TranscriptMiner
 *
 * Uses bun:test — NOT vitest/jest.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TranscriptMiner } from "../TranscriptMiner.js";
import type { MiningConfig } from "../TranscriptMiner.js";

// ============================================================================
// Module-level mock for callClaude (process-global — must be at top level)
// ============================================================================

let _mockCallClaudeImpl: () => Promise<string> = async () => "[]";

mock.module("../../llm/ClaudeCli.js", () => ({
  callClaude: () => _mockCallClaudeImpl(),
}));

function setMockCallClaude(returnValue: string): void {
  _mockCallClaudeImpl = async () => returnValue;
}

// ============================================================================
// Minimal stubs
// ============================================================================

function createMockMemoryManager() {
  return {
    saveOrUpdate: mock(async (_key: string, _value: string) => ({ id: "mem-1", value: _value })),
  };
}

function createMockUserProfile() {
  return {
    getProfile: mock((_userId: string) => null),
    upsertProfile: mock((_userId: string, _update: Record<string, unknown>) => undefined),
  };
}

function createInMemoryDb(): Database {
  return new Database(":memory:");
}

function createConfig(transcriptDir: string): MiningConfig {
  return {
    transcriptDir,
    batchSize: 5,
    skipSubagents: true,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("TranscriptMiner", () => {
  let db: Database;
  let memoryManager: ReturnType<typeof createMockMemoryManager>;
  let userProfile: ReturnType<typeof createMockUserProfile>;
  let tmpDir: string;

  beforeEach(() => {
    db = createInMemoryDb();
    memoryManager = createMockMemoryManager();
    userProfile = createMockUserProfile();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-miner-test-"));
  });

  // --------------------------------------------------------------------------
  // Schema initialization
  // --------------------------------------------------------------------------

  describe("schema initialization", () => {
    it("creates mining_progress table on construction", () => {
      const config = createConfig(tmpDir);
      new TranscriptMiner(
        db,
        memoryManager as never,
        userProfile as never,
        config
      );

      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mining_progress'")
        .get() as { name: string } | undefined;

      expect(row).toBeDefined();
      expect(row?.name).toBe("mining_progress");
    });

    it("creates idx_mining_status index", () => {
      const config = createConfig(tmpDir);
      new TranscriptMiner(db, memoryManager as never, userProfile as never, config);

      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_mining_status'")
        .get() as { name: string } | undefined;

      expect(row).toBeDefined();
    });

    it("creates idx_mining_project index", () => {
      const config = createConfig(tmpDir);
      new TranscriptMiner(db, memoryManager as never, userProfile as never, config);

      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_mining_project'")
        .get() as { name: string } | undefined;

      expect(row).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // extractUserMessages
  // --------------------------------------------------------------------------

  describe("extractUserMessages", () => {
    it("extracts messages with role=user (top-level)", async () => {
      const jsonlPath = path.join(tmpDir, "session.jsonl");
      const lines = [
        JSON.stringify({ role: "user", content: "Hello world" }),
        JSON.stringify({ role: "assistant", content: "Hi there" }),
        JSON.stringify({ role: "user", content: "Another user message" }),
      ];
      fs.writeFileSync(jsonlPath, lines.join("\n") + "\n");

      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);
      const messages = await miner.extractUserMessages(jsonlPath);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toBe("Hello world");
      expect(messages[1]).toBe("Another user message");
    });

    it("extracts messages with type=human (top-level)", async () => {
      const jsonlPath = path.join(tmpDir, "session.jsonl");
      const lines = [
        JSON.stringify({ type: "human", content: "Human message" }),
        JSON.stringify({ type: "ai", content: "AI response" }),
      ];
      fs.writeFileSync(jsonlPath, lines.join("\n"));

      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);
      const messages = await miner.extractUserMessages(jsonlPath);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toBe("Human message");
    });

    it("extracts messages from nested message.role=user format", async () => {
      const jsonlPath = path.join(tmpDir, "session.jsonl");
      const lines = [
        JSON.stringify({
          message: { role: "user", content: "Nested user message" },
        }),
        JSON.stringify({
          message: { role: "assistant", content: "Nested assistant message" },
        }),
      ];
      fs.writeFileSync(jsonlPath, lines.join("\n"));

      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);
      const messages = await miner.extractUserMessages(jsonlPath);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toBe("Nested user message");
    });

    it("extracts text from content array blocks", async () => {
      const jsonlPath = path.join(tmpDir, "session.jsonl");
      const lines = [
        JSON.stringify({
          role: "user",
          content: [
            { type: "text", text: "First block" },
            { type: "tool_use", id: "t1" },
            { type: "text", text: "Second block" },
          ],
        }),
      ];
      fs.writeFileSync(jsonlPath, lines.join("\n"));

      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);
      const messages = await miner.extractUserMessages(jsonlPath);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toBe("First block");
      expect(messages[1]).toBe("Second block");
    });

    it("skips malformed JSON lines", async () => {
      const jsonlPath = path.join(tmpDir, "session.jsonl");
      const content = [
        JSON.stringify({ role: "user", content: "Good line" }),
        "not-valid-json{{{",
        JSON.stringify({ role: "user", content: "Another good line" }),
      ].join("\n");
      fs.writeFileSync(jsonlPath, content);

      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);
      const messages = await miner.extractUserMessages(jsonlPath);

      expect(messages).toHaveLength(2);
    });

    it("skips blank lines without error", async () => {
      const jsonlPath = path.join(tmpDir, "session.jsonl");
      const content = [
        JSON.stringify({ role: "user", content: "Valid" }),
        "",
        "   ",
        JSON.stringify({ role: "user", content: "Also valid" }),
      ].join("\n");
      fs.writeFileSync(jsonlPath, content);

      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);
      const messages = await miner.extractUserMessages(jsonlPath);

      expect(messages).toHaveLength(2);
    });

    it("returns empty array for file with no user messages", async () => {
      const jsonlPath = path.join(tmpDir, "session.jsonl");
      const lines = [
        JSON.stringify({ role: "assistant", content: "Only assistant" }),
        JSON.stringify({ type: "tool_result", content: "Tool result" }),
      ];
      fs.writeFileSync(jsonlPath, lines.join("\n"));

      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);
      const messages = await miner.extractUserMessages(jsonlPath);

      expect(messages).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // recoverStaleEntries
  // --------------------------------------------------------------------------

  describe("recoverStaleEntries", () => {
    it("resets processing entries older than 1 hour to pending", async () => {
      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);

      // Insert a stale processing entry (started 2 hours ago)
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      db.prepare(`
        INSERT INTO mining_progress (session_file, status, started_at)
        VALUES (?, 'processing', ?)
      `).run("/fake/session.jsonl", twoHoursAgo);

      const recovered = await miner.recoverStaleEntries();
      expect(recovered).toBe(1);

      const row = db
        .prepare("SELECT status FROM mining_progress WHERE session_file = ?")
        .get("/fake/session.jsonl") as { status: string };

      expect(row.status).toBe("pending");
    });

    it("does not reset processing entries started within the last hour", async () => {
      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);

      // Insert a recent processing entry (started 30 minutes ago)
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      db.prepare(`
        INSERT INTO mining_progress (session_file, status, started_at)
        VALUES (?, 'processing', ?)
      `).run("/fake/recent.jsonl", thirtyMinAgo);

      const recovered = await miner.recoverStaleEntries();
      expect(recovered).toBe(0);

      const row = db
        .prepare("SELECT status FROM mining_progress WHERE session_file = ?")
        .get("/fake/recent.jsonl") as { status: string };

      expect(row.status).toBe("processing");
    });

    it("returns 0 when there are no processing entries", async () => {
      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);

      const recovered = await miner.recoverStaleEntries();
      expect(recovered).toBe(0);
    });

    it("handles multiple stale entries at once", async () => {
      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      db.prepare(`
        INSERT INTO mining_progress (session_file, status, started_at) VALUES (?, 'processing', ?)
      `).run("/stale1.jsonl", twoHoursAgo);
      db.prepare(`
        INSERT INTO mining_progress (session_file, status, started_at) VALUES (?, 'processing', ?)
      `).run("/stale2.jsonl", twoHoursAgo);

      const recovered = await miner.recoverStaleEntries();
      expect(recovered).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // miningLock — prevents concurrent mine() calls
  // --------------------------------------------------------------------------

  describe("miningLock", () => {
    it("returns early with error if mine() is already running", async () => {
      // Create a transcript dir with no .jsonl files — mine() completes instantly
      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);

      // Manually set miningLock to simulate an in-progress run
      // Access private field via type assertion for testing
      (miner as unknown as { miningLock: boolean }).miningLock = true;

      const result = await miner.mine();

      expect(result.errors).toContain("Mining already in progress");
      expect(result.sessionsScanned).toBe(0);
      expect(result.sessionsProcessed).toBe(0);
    });

    it("releases lock after mine() completes normally", async () => {
      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);

      // First call should succeed (empty dir = no sessions)
      await miner.mine();

      // Lock should be released — second call should also succeed
      const result = await miner.mine();
      expect(result.errors).not.toContain("Mining already in progress");
    });

    it("releases lock even after an exception during scanning", async () => {
      // Use a non-existent transcriptDir to trigger a graceful no-op
      const config = createConfig(path.join(tmpDir, "nonexistent"));
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);

      // Should not throw — missing dir is handled gracefully
      await miner.mine();

      // Lock should be released
      const internal = miner as unknown as { miningLock: boolean };
      expect(internal.miningLock).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // mine() — integration with DB
  // --------------------------------------------------------------------------

  describe("mine()", () => {
    it("registers discovered .jsonl files in mining_progress", async () => {
      // Create a project dir with a .jsonl file
      const projectDir = path.join(tmpDir, "my-project");
      fs.mkdirSync(projectDir);
      const jsonlPath = path.join(projectDir, "abc-session.jsonl");
      fs.writeFileSync(jsonlPath, JSON.stringify({ role: "assistant", content: "hi" }) + "\n");

      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);

      await miner.mine({ limit: 0 }); // limit=0 → register but don't process

      const row = db
        .prepare("SELECT session_file, project, status FROM mining_progress WHERE session_file = ?")
        .get(jsonlPath) as { session_file: string; project: string; status: string } | undefined;

      expect(row).toBeDefined();
      expect(row?.project).toBe("my-project");
      expect(row?.status).toBe("pending");
    });

    it("skips subagent directories when skipSubagents=true", async () => {
      const subagentDir = path.join(tmpDir, "subagent-xyz");
      fs.mkdirSync(subagentDir);
      fs.writeFileSync(
        path.join(subagentDir, "session.jsonl"),
        JSON.stringify({ role: "user", content: "subagent msg" }) + "\n"
      );

      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);

      const result = await miner.mine();
      expect(result.sessionsScanned).toBe(0);
    });

    it("returns sessionsScanned=0 when transcriptDir does not exist", async () => {
      const config = createConfig(path.join(tmpDir, "does-not-exist"));
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config);

      const result = await miner.mine();
      expect(result.sessionsScanned).toBe(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // TRANSCRIPT_MINED event emission
  // --------------------------------------------------------------------------

  describe("eventStore — TRANSCRIPT_MINED emission", () => {
    it("emits TRANSCRIPT_MINED when mining saves facts", async () => {
      // Mock callClaude to return two facts
      setMockCallClaude('["User prefers dark mode", "User works on ping-mem"]');

      // Create a project dir with a session that has a user message
      const projectDir = path.join(tmpDir, "test-project");
      fs.mkdirSync(projectDir);
      const jsonlPath = path.join(projectDir, "session.jsonl");
      fs.writeFileSync(
        jsonlPath,
        JSON.stringify({ role: "user", content: "I prefer dark mode when working on ping-mem" }) + "\n"
      );

      const createEvent = mock(async () => ({ eventId: "test-evt" }));
      const mockEventStore = { createEvent } as never;

      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config, mockEventStore);

      await miner.mine({ limit: 1 });

      // Give fire-and-forget a tick to resolve
      await new Promise((r) => setTimeout(r, 20));

      expect(createEvent).toHaveBeenCalledWith(
        "system",
        "TRANSCRIPT_MINED",
        expect.objectContaining({ project: "test-project", factsExtracted: 2 })
      );
    });

    it("does not emit TRANSCRIPT_MINED when no facts are saved", async () => {
      // Mock callClaude to return empty array
      setMockCallClaude("[]");

      const projectDir = path.join(tmpDir, "empty-project");
      fs.mkdirSync(projectDir);
      const jsonlPath = path.join(projectDir, "session.jsonl");
      fs.writeFileSync(
        jsonlPath,
        JSON.stringify({ role: "user", content: "hi" }) + "\n"
      );

      const createEvent = mock(async () => ({ eventId: "test-evt" }));
      const mockEventStore = { createEvent } as never;

      const config = createConfig(tmpDir);
      const miner = new TranscriptMiner(db, memoryManager as never, userProfile as never, config, mockEventStore);

      await miner.mine({ limit: 1 });
      await new Promise((r) => setTimeout(r, 20));

      expect(createEvent).not.toHaveBeenCalled();
    });
  });
});
