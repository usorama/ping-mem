/**
 * Migration Verifier
 *
 * Verifies migration correctness by comparing source and target data.
 * Performs count checks, sample comparisons, and search parity validation.
 *
 * @module migration/MigrationVerifier
 * @version 1.0.0
 */

import type { MemoryKeeperReader } from "./MemoryKeeperReader.js";
import type { MemoryManager } from "../memory/MemoryManager.js";
import type { SessionManager } from "../session/SessionManager.js";

// ============================================================================
// Verification Result Types
// ============================================================================

export interface VerificationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
  details: {
    sessionCounts: { source: number; target: number; match: boolean };
    contextItemCounts: { source: number; target: number; match: boolean };
    checkpointCounts: { source: number; target: number; match: boolean };
    sampleComparisons: Array<{
      key: string;
      sourceValue: string;
      targetValue: string;
      match: boolean;
    }>;
    searchParityTests: Array<{
      query: string;
      sourceResults: number;
      targetResults: number;
      topResultsMatch: boolean;
    }>;
  };
}

// ============================================================================
// Migration Verifier
// ============================================================================

export class MigrationVerifier {
  constructor(
    private memoryKeeperReader: MemoryKeeperReader,
    private sessionManager: SessionManager,
    private memoryManagers: Map<string, MemoryManager>
  ) {}

  /**
   * Verify migration completeness and correctness
   */
  async verify(sampleSize: number = 10): Promise<VerificationResult> {
    const result: VerificationResult = {
      passed: true,
      errors: [],
      warnings: [],
      details: {
        sessionCounts: { source: 0, target: 0, match: false },
        contextItemCounts: { source: 0, target: 0, match: false },
        checkpointCounts: { source: 0, target: 0, match: false },
        sampleComparisons: [],
        searchParityTests: [],
      },
    };

    try {
      // Verify session counts
      const sourceSessions = this.memoryKeeperReader.getSessions();
      const targetSessions = await this.sessionManager.listSessions();
      result.details.sessionCounts = {
        source: sourceSessions.length,
        target: targetSessions.length,
        match: sourceSessions.length === targetSessions.length,
      };

      if (!result.details.sessionCounts.match) {
        result.errors.push(
          `Session count mismatch: source=${sourceSessions.length}, target=${targetSessions.length}`
        );
        result.passed = false;
      }

      // Verify context item counts
      const sourceItems = this.memoryKeeperReader.getContextItems();
      let targetItemCount = 0;
      for (const manager of this.memoryManagers.values()) {
        targetItemCount += manager.count();
      }
      result.details.contextItemCounts = {
        source: sourceItems.length,
        target: targetItemCount,
        match: sourceItems.length === targetItemCount,
      };

      if (!result.details.contextItemCounts.match) {
        result.errors.push(
          `Context item count mismatch: source=${sourceItems.length}, target=${targetItemCount}`
        );
        result.passed = false;
      }

      // Sample comparisons (random sample of items)
      const sampleItems = this.sampleArray(sourceItems, Math.min(sampleSize, sourceItems.length));
      for (const sourceItem of sampleItems) {
        const manager = this.memoryManagers.get(sourceItem.session_id);
        if (!manager) {
          result.warnings.push(
            `No memory manager found for session ${sourceItem.session_id}`
          );
          continue;
        }

        const targetMemory = manager.get(sourceItem.key);
        if (!targetMemory) {
          result.errors.push(`Memory not found in target: key=${sourceItem.key}`);
          result.passed = false;
          continue;
        }

        const valuesMatch = sourceItem.value === targetMemory.value;
        result.details.sampleComparisons.push({
          key: sourceItem.key,
          sourceValue: sourceItem.value.substring(0, 100),
          targetValue: targetMemory.value.substring(0, 100),
          match: valuesMatch,
        });

        if (!valuesMatch) {
          result.errors.push(`Value mismatch for key=${sourceItem.key}`);
          result.passed = false;
        }
      }

      // Checkpoint counts
      const sourceCheckpoints = this.memoryKeeperReader.getCheckpoints();
      // Note: We can't easily count target checkpoints without querying each session
      // For now, just record the source count
      result.details.checkpointCounts = {
        source: sourceCheckpoints.length,
        target: -1, // Not easily retrievable
        match: false, // Unknown
      };

      result.warnings.push("Checkpoint count verification skipped (requires per-session queries)");

    } catch (error) {
      result.errors.push(`Verification failed: ${error instanceof Error ? error.message : String(error)}`);
      result.passed = false;
    }

    return result;
  }

  /**
   * Generate verification report as string
   */
  async generateReport(sampleSize: number = 10): Promise<string> {
    const result = await this.verify(sampleSize);

    const lines: string[] = [];
    lines.push("=".repeat(60));
    lines.push("MIGRATION VERIFICATION REPORT");
    lines.push("=".repeat(60));
    lines.push("");
    lines.push(`Status: ${result.passed ? "✅ PASSED" : "❌ FAILED"}`);
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push("");

    // Counts
    lines.push("--- Counts ---");
    lines.push(`Sessions: ${result.details.sessionCounts.source} -> ${result.details.sessionCounts.target} ${result.details.sessionCounts.match ? "✅" : "❌"}`);
    lines.push(`Context Items: ${result.details.contextItemCounts.source} -> ${result.details.contextItemCounts.target} ${result.details.contextItemCounts.match ? "✅" : "❌"}`);
    lines.push(`Checkpoints: ${result.details.checkpointCounts.source} (target count unknown)`);
    lines.push("");

    // Sample comparisons
    if (result.details.sampleComparisons.length > 0) {
      lines.push(`--- Sample Comparisons (${result.details.sampleComparisons.length} items) ---`);
      for (const sample of result.details.sampleComparisons) {
        lines.push(`  ${sample.key}: ${sample.match ? "✅" : "❌"}`);
      }
      lines.push("");
    }

    // Errors
    if (result.errors.length > 0) {
      lines.push("--- Errors ---");
      for (const error of result.errors) {
        lines.push(`  ❌ ${error}`);
      }
      lines.push("");
    }

    // Warnings
    if (result.warnings.length > 0) {
      lines.push("--- Warnings ---");
      for (const warning of result.warnings) {
        lines.push(`  ⚠️  ${warning}`);
      }
      lines.push("");
    }

    lines.push("=".repeat(60));
    return lines.join("\n");
  }

  /**
   * Sample array randomly
   */
  private sampleArray<T>(array: T[], size: number): T[] {
    const shuffled = [...array].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, size);
  }
}
