/**
 * Tests that SessionManager.hydrate() restores sessions from EventStore
 * after a simulated restart (new SessionManager instance, same DB).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { SessionManager } from "../SessionManager.js";
import { EventStore } from "../../storage/EventStore.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("SessionManager.hydrate() — restart survival", () => {
  const tmpFiles: string[] = [];

  function createTmpDbPath(): string {
    const p = path.join(os.tmpdir(), `ping-mem-hydrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    tmpFiles.push(p);
    return p;
  }

  afterEach(() => {
    for (const f of tmpFiles) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(f + suffix); } catch { /* ignore */ }
      }
    }
    tmpFiles.length = 0;
  });

  it("restores sessions from EventStore after restart", async () => {
    const dbPath = createTmpDbPath();

    // --- First lifecycle: create session, then close ---
    const es1 = new EventStore({ dbPath, walMode: true });
    const sm1 = new SessionManager({ eventStore: es1 });
    const session = await sm1.startSession({ name: "test-session" });
    expect(session.id).toBeDefined();
    await sm1.close();
    await es1.close();

    // --- Second lifecycle: new instances, same DB, hydrate ---
    const es2 = new EventStore({ dbPath, walMode: true });
    const sm2 = new SessionManager({ eventStore: es2 });

    // Before hydration: session should not be present
    const beforeHydrate = sm2.getSession(session.id);
    expect(beforeHydrate).toBeNull();

    // Hydrate from EventStore
    await sm2.hydrate();

    // After hydration: session should be restored
    const restored = sm2.getSession(session.id);
    expect(restored).toBeDefined();
    expect(restored!.name).toBe("test-session");

    await sm2.close();
    await es2.close();
  });

  it("hydrate() is idempotent — calling twice doesn't duplicate sessions", async () => {
    const dbPath = createTmpDbPath();

    const es = new EventStore({ dbPath, walMode: true });
    const sm = new SessionManager({ eventStore: es });
    await sm.startSession({ name: "session-a" });
    await sm.startSession({ name: "session-b" });

    // Hydrate twice
    await sm.hydrate();
    await sm.hydrate();

    const sessions = sm.listSessions();
    const names = sessions.map((s) => s.name);
    expect(names.filter((n) => n === "session-a")).toHaveLength(1);
    expect(names.filter((n) => n === "session-b")).toHaveLength(1);

    await sm.close();
    await es.close();
  });
});
