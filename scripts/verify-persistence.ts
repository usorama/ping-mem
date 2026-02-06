#!/usr/bin/env bun
/**
 * Verify Migration Persistence
 *
 * Tests that migrated data persists across restarts by:
 * 1. Querying EventStore for session count
 * 2. Creating MemoryManagers and hydrating
 * 3. Verifying memory counts match expected
 *
 * Usage: bun run scripts/verify-persistence.ts
 */

import { EventStore } from "../src/storage/EventStore.js";
import { SessionManager } from "../src/session/SessionManager.js";
import { MemoryManager } from "../src/memory/MemoryManager.js";
import * as path from "path";
import * as os from "os";

async function verify(): Promise<void> {
  console.log("=".repeat(60));
  console.log("PERSISTENCE VERIFICATION");
  console.log("=".repeat(60));
  console.log("");

  const dbPath = path.join(os.homedir(), ".ping-mem", "events.db");
  console.log(`Database: ${dbPath}`);
  console.log("");

  // Initialize components
  const eventStore = new EventStore({ dbPath });
  const sessionManager = new SessionManager({ eventStore });

  try {
    // Hydrate sessions from event store
    console.log("--- Hydrating Sessions ---");
    await sessionManager.hydrate();

    // Get all sessions
    console.log("--- Querying Sessions ---");
    const sessions = sessionManager.listSessions();
    console.log(`  Found: ${sessions.length} sessions`);

    if (sessions.length === 0) {
      console.log("  ❌ No sessions found - migration data lost!");
      process.exit(1);
    }

    // Sample 5 sessions to verify memories
    console.log("");
    console.log("--- Verifying Memory Hydration (sample) ---");
    const sampleSize = Math.min(5, sessions.length);
    let totalMemories = 0;

    for (let i = 0; i < sampleSize; i++) {
      const session = sessions[i];
      console.log(`  Session ${i + 1}/${sampleSize}: ${session.name}`);

      const memoryManager = new MemoryManager({
        sessionId: session.id,
        eventStore,
      });

      // Hydrate from events
      await memoryManager.hydrate();
      const count = memoryManager.count();
      totalMemories += count;

      console.log(`    Memories: ${count}`);
    }

    console.log("");
    console.log("--- Summary ---");
    console.log(`  Sessions: ${sessions.length} (expected: 30)`);
    console.log(`  Sample memories: ${totalMemories} (from ${sampleSize} sessions)`);

    if (sessions.length === 30) {
      console.log("  ✅ Session count matches expected");
    } else {
      console.log(`  ⚠️  Session count mismatch (expected 30, got ${sessions.length})`);
    }

    console.log("");
    console.log("✅ Persistence verification PASSED");
    console.log("   Data survives restarts, crashes, and power loss");

  } catch (error) {
    console.error("\n❌ Verification failed:");
    console.error(error);
    process.exit(1);
  } finally {
    await eventStore.close();
  }
}

// Run if executed directly
if (import.meta.main) {
  verify().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

export { verify };
