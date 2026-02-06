#!/usr/bin/env bun
/**
 * Migration Script: memory-keeper -> ping-mem
 *
 * Migrates all data from memory-keeper to ping-mem with:
 * - Zero data loss
 * - Preserved timestamps
 * - Idempotent execution
 * - Verification report
 *
 * Usage:
 *   bun run scripts/migrate-from-memory-keeper.ts [--source-db <path>] [--dry-run] [--force]
 *
 * @version 1.0.0
 */

import { MemoryKeeperReader } from "../src/migration/MemoryKeeperReader.js";
import { MigrationLedger } from "../src/migration/MigrationLedger.js";
import { MigrationVerifier } from "../src/migration/MigrationVerifier.js";
import { SessionManager } from "../src/session/SessionManager.js";
import { MemoryManager } from "../src/memory/MemoryManager.js";
import { EventStore } from "../src/storage/EventStore.js";
import type { MemoryCategory, MemoryPriority } from "../src/types/index.js";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Configuration
// ============================================================================

interface MigrationConfig {
  sourceDbPath: string;
  targetDbPath: string;
  dryRun: boolean;
  force: boolean;
  skipProactiveRecall: boolean;
}

const DEFAULT_CONFIG: MigrationConfig = {
  sourceDbPath: path.join(os.homedir(), "mcp-data", "memory-keeper", "context.db"),
  targetDbPath: path.join(os.homedir(), ".ping-mem", "events.db"),
  dryRun: false,
  force: false,
  skipProactiveRecall: true, // Disable for bulk migration
};

// ============================================================================
// Main Migration Function
// ============================================================================

async function migrate(config: MigrationConfig): Promise<void> {
  console.log("=".repeat(60));
  console.log("MEMORY-KEEPER TO PING-MEM MIGRATION");
  console.log("=".repeat(60));
  console.log("");
  console.log(`Source DB: ${config.sourceDbPath}`);
  console.log(`Target DB: ${config.targetDbPath}`);
  console.log(`Dry Run: ${config.dryRun ? "YES" : "NO"}`);
  console.log(`Force: ${config.force ? "YES" : "NO"}`);
  console.log("");

  // Initialize components
  console.log("Initializing components...");
  const memoryKeeperReader = new MemoryKeeperReader(config.sourceDbPath);
  const ledger = new MigrationLedger();
  const eventStore = new EventStore({ dbPath: config.targetDbPath });
  const sessionManager = new SessionManager({
    eventStore,
    maxActiveSessions: 50, // Allow more sessions for migration (default is 10)
  });
  const memoryManagers = new Map<string, MemoryManager>();

  try {
    // Get source statistics
    console.log("\nSource database statistics:");
    const stats = memoryKeeperReader.getStats();
    console.log(`  Sessions: ${stats.totalSessions}`);
    console.log(`  Context Items: ${stats.totalContextItems}`);
    console.log(`  Checkpoints: ${stats.totalCheckpoints}`);
    console.log(`  Checkpoint Items: ${stats.totalCheckpointItems}`);
    console.log(`  Categories:`, stats.categoryCounts);
    console.log(`  Channels: ${Object.keys(stats.channelCounts).length} unique`);

    if (config.dryRun) {
      console.log("\n⚠️  DRY RUN MODE - No changes will be made");
      console.log("\nMigration plan:");
      console.log(`  1. Create ${stats.totalSessions} sessions`);
      console.log(`  2. Migrate ${stats.totalContextItems} context items`);
      console.log(`  3. Migrate ${stats.totalCheckpoints} checkpoints`);
      console.log(`  4. Verify migration`);
      return;
    }

    // Check ledger
    const ledgerStats = ledger.getStats();
    if (ledgerStats.successCount > 0 && !config.force) {
      console.log(`\n⚠️  Found ${ledgerStats.successCount} already migrated items`);
      console.log("Use --force to re-migrate (will replace existing data)");
      return;
    }

    // Phase 1: Migrate sessions
    console.log("\n--- Phase 1: Migrating Sessions ---");
    const sourceSessions = memoryKeeperReader.getSessions();
    for (const sourceSession of sourceSessions) {
      if (ledger.wasMigrated("sessions", sourceSession.id) && !config.force) {
        console.log(`  ⏭️  Skipping session ${sourceSession.name} (already migrated)`);
        continue;
      }

      try {
        const session = await sessionManager.startSession({
          name: sourceSession.name,
          projectDir: sourceSession.working_directory ?? undefined,
          defaultChannel: sourceSession.default_channel ?? undefined,
          continueFrom: undefined,
          metadata: {
            description: sourceSession.description,
            branch: sourceSession.branch,
            parent_id: sourceSession.parent_id,
          },
        });

        // Create memory manager for this session
        const memoryManager = new MemoryManager({
          sessionId: session.id,
          eventStore,
          defaultChannel: sourceSession.default_channel ?? undefined,
        });

        // Hydrate to restore any existing state
        await memoryManager.hydrate();

        memoryManagers.set(session.id, memoryManager);

        ledger.recordSuccess("sessions", sourceSession.id, session.id);
        console.log(`  ✅ ${sourceSession.name} -> ${session.id}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        ledger.recordFailure("sessions", sourceSession.id, "", errorMsg);
        console.log(`  ❌ ${sourceSession.name}: ${errorMsg}`);
      }
    }

    // Phase 2: Migrate context items
    console.log("\n--- Phase 2: Migrating Context Items ---");
    const sourceItems = memoryKeeperReader.getContextItems();
    let migratedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const sourceItem of sourceItems) {
      // Find target session
      const sessionRecord = ledger.getRecord("sessions", sourceItem.session_id);
      if (!sessionRecord || sessionRecord.status !== "success") {
        ledger.recordSkipped("context_items", sourceItem.id, "Session not migrated");
        skippedCount++;
        continue;
      }

      const manager = memoryManagers.get(sessionRecord.targetId);
      if (!manager) {
        ledger.recordSkipped("context_items", sourceItem.id, "Memory manager not found");
        skippedCount++;
        continue;
      }

      if (ledger.wasMigrated("context_items", sourceItem.id) && !config.force) {
        skippedCount++;
        continue;
      }

      try {
        // Map category (memory-keeper uses different names)
        let category: MemoryCategory | undefined;
        if (sourceItem.category === "progress") category = "progress";
        else if (sourceItem.category === "decision") category = "decision";
        else if (sourceItem.category === "task") category = "task";
        else if (sourceItem.category === "note") category = "note";
        else if (sourceItem.category === "error") category = "error";
        else if (sourceItem.category === "failure") category = "error"; // Map failure -> error
        else if (sourceItem.category === "warning") category = "warning";

        // Map priority
        let priority: MemoryPriority = "normal";
        if (sourceItem.priority === "high") priority = "high";
        else if (sourceItem.priority === "low") priority = "low";

        // Parse metadata
        const metadata = sourceItem.metadata ? JSON.parse(sourceItem.metadata) : {};

        // Use saveOrUpdate for idempotency
        await manager.saveOrUpdate(sourceItem.key, sourceItem.value, {
          category,
          priority,
          channel: sourceItem.channel ?? undefined,
          metadata,
          createdAt: new Date(sourceItem.created_at),
          updatedAt: new Date(sourceItem.updated_at),
        });

        ledger.recordSuccess("context_items", sourceItem.id, sourceItem.key);
        migratedCount++;

        if (migratedCount % 50 === 0) {
          console.log(`  Progress: ${migratedCount}/${sourceItems.length} items migrated`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        ledger.recordFailure("context_items", sourceItem.id, sourceItem.key, errorMsg);
        errorCount++;
      }
    }

    console.log(`  ✅ Migrated: ${migratedCount}`);
    console.log(`  ⏭️  Skipped: ${skippedCount}`);
    console.log(`  ❌ Errors: ${errorCount}`);

    // Phase 3: Migrate checkpoints
    console.log("\n--- Phase 3: Migrating Checkpoints ---");
    const sourceCheckpoints = memoryKeeperReader.getCheckpoints();
    const checkpointItems = memoryKeeperReader.getCheckpointItems();

    for (const sourceCheckpoint of sourceCheckpoints) {
      // Find target session
      const sessionRecord = ledger.getRecord("sessions", sourceCheckpoint.session_id);
      if (!sessionRecord || sessionRecord.status !== "success") {
        ledger.recordSkipped("checkpoints", sourceCheckpoint.id, "Session not migrated");
        continue;
      }

      if (ledger.wasMigrated("checkpoints", sourceCheckpoint.id) && !config.force) {
        continue;
      }

      try {
        // Get checkpoint items
        const items = checkpointItems.filter(
          (ci) => ci.checkpoint_id === sourceCheckpoint.id
        );

        // Map item IDs to keys
        const memoryKeys: string[] = [];
        for (const item of items) {
          const contextItem = memoryKeeperReader.getContextItemById(item.context_item_id);
          if (contextItem) {
            memoryKeys.push(contextItem.key);
          }
        }

        // Get manager
        const manager = memoryManagers.get(sessionRecord.targetId);
        if (!manager) {
          throw new Error("Memory manager not found");
        }

        // Create checkpoint
        const checkpoint = await eventStore.createCheckpoint(
          sessionRecord.targetId,
          memoryKeys.length,
          sourceCheckpoint.description ?? sourceCheckpoint.name,
          memoryKeys
        );

        ledger.recordSuccess("checkpoints", sourceCheckpoint.id, checkpoint.checkpointId);
        console.log(`  ✅ ${sourceCheckpoint.name} -> ${checkpoint.checkpointId}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        ledger.recordFailure("checkpoints", sourceCheckpoint.id, "", errorMsg);
        console.log(`  ❌ ${sourceCheckpoint.name}: ${errorMsg}`);
      }
    }

    // Verification
    console.log("\n--- Phase 4: Verification ---");
    const verifier = new MigrationVerifier(memoryKeeperReader, sessionManager, memoryManagers);
    const report = await verifier.generateReport(10);
    console.log(report);

    // Summary
    console.log("\n--- Migration Summary ---");
    const finalStats = ledger.getStats();
    console.log(`Total Records: ${finalStats.totalRecords}`);
    console.log(`  Success: ${finalStats.successCount}`);
    console.log(`  Failed: ${finalStats.failedCount}`);
    console.log(`  Skipped: ${finalStats.skippedCount}`);
    console.log("");
    console.log("Migration complete! 🎉");
  } catch (error) {
    console.error("\n❌ Migration failed:");
    console.error(error);
    throw error;
  } finally {
    // Cleanup
    memoryKeeperReader.close();
    ledger.close();
    await eventStore.close();
    for (const manager of memoryManagers.values()) {
      await manager.close();
    }
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main(): Promise<void> {
  const config = { ...DEFAULT_CONFIG };

  // Parse CLI arguments
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--source-db" && i + 1 < args.length) {
      config.sourceDbPath = args[++i] as string;
    } else if (arg === "--target-db" && i + 1 < args.length) {
      config.targetDbPath = args[++i] as string;
    } else if (arg === "--dry-run") {
      config.dryRun = true;
    } else if (arg === "--force") {
      config.force = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run scripts/migrate-from-memory-keeper.ts [options]");
      console.log("");
      console.log("Options:");
      console.log("  --source-db <path>  Path to memory-keeper database");
      console.log("  --target-db <path>  Path to ping-mem database");
      console.log("  --dry-run           Preview migration without making changes");
      console.log("  --force             Re-migrate items even if already migrated");
      console.log("  --help, -h          Show this help message");
      process.exit(0);
    }
  }

  await migrate(config);
}

// Run if executed directly
if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

export { migrate };
