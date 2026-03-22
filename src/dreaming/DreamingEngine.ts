/**
 * Dreaming Engine for ping-mem
 *
 * Performs periodic LLM reasoning over stored memories to:
 * 1. Deduce implicit facts from memory clusters (deduction phase)
 * 2. Generalize patterns into personality traits and update UserProfile (generalization phase)
 * 3. Detect and invalidate stale derived insights (clean phase)
 *
 * Inspired by Honcho's "dreaming" capability — the key differentiator for
 * memory systems that store AND reason, not just store.
 *
 * IMPORTANT: Input memories always exclude category='derived_insight' to
 * prevent circular reasoning (Amendment #12).
 *
 * @module dreaming/DreamingEngine
 * @version 1.0.0
 */

import type { Memory, SessionId } from "../types/index.js";
import type { MemoryManager } from "../memory/MemoryManager.js";
import type { ContradictionDetector } from "../graph/ContradictionDetector.js";
import type { UserProfileStore } from "../profile/UserProfile.js";
import { EventStore } from "../storage/EventStore.js";
import { createLogger } from "../util/logger.js";
import { callClaude } from "../llm/ClaudeCli.js";

const log = createLogger("DreamingEngine");

// ============================================================================
// Configuration & Result Types
// ============================================================================

export interface DreamConfig {
  /** Maximum memories to load per dreaming cycle. Default: 200 */
  maxMemoriesPerCycle: number;
  /** Minimum memories required before dreaming starts. Default: 20 */
  minMemoriesForDreaming: number;
  /** Enable deduction phase. Default: true */
  deductionEnabled: boolean;
  /** Enable generalization phase. Default: true */
  generalizationEnabled: boolean;
}

export interface DreamResult {
  /** Number of new facts derived (deductions saved as memories) */
  deductions: number;
  /** Number of personality traits formed via generalization */
  generalizations: number;
  /** Number of stale insights invalidated via ContradictionDetector */
  contradictions: number;
  /** Number of UserProfile fields updated */
  profileUpdates: number;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Phase-level failures collected during the dreaming cycle */
  errors: string[];
  /** Estimated token usage (available when Claude CLI reports it) */
  costEstimate?: { inputTokens: number; outputTokens: number };
}

// ============================================================================
// Prompts
// ============================================================================

const DEDUCTION_SYSTEM = `You are a memory reasoning engine. Given a set of memories from an AI assistant's user, derive implicit facts that are NOT already stated but can be logically inferred.

Rules:
- Only derive facts that are clearly implied by multiple memories
- Do NOT include facts already stated verbatim in the memories
- Prefer concrete, specific facts over vague generalizations
- Return a JSON array of strings, each a derived fact
- Limit to 5 most important derived facts
- If nothing meaningful can be derived, return an empty array []

Example output: ["User prefers TypeScript over JavaScript based on consistent corrections", "Project X appears to be complete since it stopped being mentioned after March 2026"]`;

const GENERALIZATION_SYSTEM = `You are a user behavior analyst. Given memories from an AI assistant's interactions with a user, identify personality traits, work preferences, and behavioral patterns.

Rules:
- Focus on consistent patterns across multiple memories
- Identify: technical preferences, work style, communication style, domain expertise
- Return a JSON object with these exact fields:
  {
    "traits": ["trait1", "trait2"],
    "expertise": ["domain1", "domain2"],
    "projects": ["project1", "project2"],
    "workStyle": ["style1", "style2"]
  }
- Only include fields where you have at least 2 supporting memories
- If no patterns are clear, return empty arrays for each field`;

// ============================================================================
// DreamingEngine Implementation
// ============================================================================

export class DreamingEngine {
  /** Singleton lock — prevents concurrent dream() calls */
  private dreamingLock = false;

  constructor(
    private readonly memoryManager: MemoryManager,
    private readonly contradictionDetector: ContradictionDetector | null,
    private readonly userProfile: UserProfileStore,
    private readonly eventStore: EventStore,
    private readonly config: DreamConfig
  ) {}

  /**
   * Run full dreaming cycle: deduce → generalize → cleanStaleInsights → profile update
   * Serialized via dreamingLock — returns early if already running.
   */
  async dream(sessionId: SessionId): Promise<DreamResult> {
    if (this.dreamingLock) {
      log.warn("dream() called while already running — skipping");
      return {
        deductions: 0,
        generalizations: 0,
        contradictions: 0,
        profileUpdates: 0,
        durationMs: 0,
        errors: ["Dreaming already in progress"],
      };
    }

    this.dreamingLock = true;
    const startMs = Date.now();
    const result: DreamResult = {
      deductions: 0,
      generalizations: 0,
      contradictions: 0,
      profileUpdates: 0,
      durationMs: 0,
      errors: [],
    };

    try {
      log.info("Starting dreaming cycle", { sessionId });

      // Load all memories, excluding derived_insight to prevent circular reasoning
      const allResults = await this.memoryManager.recall({
        limit: this.config.maxMemoriesPerCycle,
        sort: "updated_desc",
      });
      const rawMemories = allResults.map((r) => r.memory);

      // Filter out derived_insight memories for input to deduce/generalize
      const sourceMemories = rawMemories.filter(
        (m) => m.category !== "derived_insight"
      );

      if (sourceMemories.length < this.config.minMemoriesForDreaming) {
        log.info("Not enough source memories for dreaming", {
          count: sourceMemories.length,
          required: this.config.minMemoriesForDreaming,
        });
        result.durationMs = Date.now() - startMs;
        return result;
      }

      log.info("Memory counts for dreaming", {
        total: rawMemories.length,
        sourceMemories: sourceMemories.length,
      });

      // Phase 1: Deduction
      if (this.config.deductionEnabled) {
        try {
          const deductions = await this.deduce(sourceMemories);
          for (const fact of deductions) {
            const key = `derived_insight::deduction::${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            await this.memoryManager.save(key, fact, {
              category: "derived_insight",
              priority: "normal",
              metadata: {
                phase: "deduction",
                sourceCount: sourceMemories.length,
                derivedAt: new Date().toISOString(),
              },
            });
            await this.eventStore.createEvent(sessionId, "INSIGHT_DERIVED", {
              key,
              fact,
              phase: "deduction",
            });
            result.deductions++;
          }
          log.info("Deduction phase complete", { count: result.deductions });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error("Deduction phase failed", { error: msg });
          result.errors.push(`deduction: ${msg}`);
        }
      }

      // Phase 2: Generalization
      if (this.config.generalizationEnabled) {
        try {
          const traits = await this.generalize(sourceMemories);
          for (const trait of traits) {
            const key = `derived_insight::generalization::${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            await this.memoryManager.save(key, trait, {
              category: "derived_insight",
              priority: "normal",
              metadata: {
                phase: "generalization",
                sourceCount: sourceMemories.length,
                derivedAt: new Date().toISOString(),
              },
            });
            await this.eventStore.createEvent(sessionId, "INSIGHT_DERIVED", {
              key,
              trait,
              phase: "generalization",
            });
            result.generalizations++;
          }
          log.info("Generalization phase complete", {
            count: result.generalizations,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error("Generalization phase failed", { error: msg });
          result.errors.push(`generalization: ${msg}`);
        }
      }

      // Phase 3: Clean stale insights
      const existingInsights = rawMemories.filter(
        (m) => m.category === "derived_insight"
      );
      if (existingInsights.length > 0) {
        try {
          result.contradictions = await this.cleanStaleInsights(existingInsights);
          log.info("Stale insight cleanup complete", {
            invalidated: result.contradictions,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error("Stale insight cleanup failed", { error: msg });
          result.errors.push(`stale-insight-cleanup: ${msg}`);
        }
      }

      result.durationMs = Date.now() - startMs;
      log.info("Dreaming cycle complete", result as unknown as Record<string, unknown>);
      return result;
    } finally {
      this.dreamingLock = false;
    }
  }

  /**
   * Phase 1: Compare memory clusters to derive implicit facts.
   * CRITICAL: Input memories must already exclude category='derived_insight'.
   */
  async deduce(memories: Memory[]): Promise<string[]> {
    if (memories.length === 0) return [];

    // Build a concise summary of memories for the LLM
    const memoryText = memories
      .slice(0, 50) // limit context to avoid token explosion
      .map((m, i) => `[${i + 1}] ${m.key}: ${m.value}`)
      .join("\n");

    const prompt = `Here are memories stored about a user's work and interactions:\n\n${memoryText}\n\nDerive up to 5 implicit facts that are clearly implied but not explicitly stated. Return a JSON array of strings.`;

    const raw = await callClaude(prompt, {
      model: "claude-sonnet-4-6",
      system: DEDUCTION_SYSTEM,
    });
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      log.warn("Deduction response was not an array", { raw });
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string");
  }

  /**
   * Phase 2: Find patterns across memories to form personality traits and update UserProfile.
   */
  async generalize(memories: Memory[]): Promise<string[]> {
    if (memories.length === 0) return [];

    const memoryText = memories
      .slice(0, 50)
      .map((m, i) => `[${i + 1}] ${m.key}: ${m.value}`)
      .join("\n");

    const prompt = `Here are memories stored about a user's work and interactions:\n\n${memoryText}\n\nIdentify personality traits, technical preferences, and behavioral patterns. Return a JSON object with traits, expertise, projects, and workStyle arrays.`;

    const raw = await callClaude(prompt, {
      model: "claude-sonnet-4-6",
      system: GENERALIZATION_SYSTEM,
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const traits: string[] = [];
    if (Array.isArray(parsed.traits)) {
      traits.push(
        ...(parsed.traits as unknown[]).filter(
          (t): t is string => typeof t === "string"
        )
      );
    }

    // Auto-update UserProfile from generalization results
    const profileUpdates: {
      expertise?: string[];
      activeProjects?: string[];
      currentFocus?: string[];
    } = {};

    if (Array.isArray(parsed.expertise) && parsed.expertise.length > 0) {
      profileUpdates.expertise = (parsed.expertise as unknown[]).filter(
        (e): e is string => typeof e === "string"
      );
    }
    if (Array.isArray(parsed.projects) && parsed.projects.length > 0) {
      profileUpdates.activeProjects = (parsed.projects as unknown[]).filter(
        (p): p is string => typeof p === "string"
      );
    }
    if (Array.isArray(parsed.workStyle) && parsed.workStyle.length > 0) {
      profileUpdates.currentFocus = (parsed.workStyle as unknown[]).filter(
        (s): s is string => typeof s === "string"
      );
    }

    if (Object.keys(profileUpdates).length > 0) {
      try {
        this.userProfile.updateProfile("default", profileUpdates);
        log.info("UserProfile updated from generalization", profileUpdates);
      } catch (profileErr) {
        log.warn("Failed to update UserProfile from generalization", {
          error:
            profileErr instanceof Error
              ? profileErr.message
              : String(profileErr),
        });
      }
    }

    // Return all generalizations as strings to be stored as derived_insight memories
    const allGeneralizations: string[] = [...traits];
    if (Array.isArray(parsed.workStyle)) {
      allGeneralizations.push(
        ...(parsed.workStyle as unknown[]).filter(
          (s): s is string => typeof s === "string"
        )
      );
    }

    return allGeneralizations;
  }

  /**
   * Phase 3: Check existing derived insights for staleness.
   * Skipped entirely when contradictionDetector is null (no OPENAI_API_KEY).
   * Returns the count of insights invalidated.
   */
  async cleanStaleInsights(insights: Memory[]): Promise<number> {
    if (!this.contradictionDetector) {
      log.info(
        "Skipping stale insight cleanup — no ContradictionDetector (OPENAI_API_KEY not set)"
      );
      return 0;
    }

    if (insights.length === 0) return 0;

    let invalidated = 0;

    // Load current source memories to compare against stored derived insights
    const sourceResults = await this.memoryManager.recall({
      limit: this.config.maxMemoriesPerCycle,
      sort: "updated_desc",
    });
    const sourceSummary = sourceResults
      .map((r) => r.memory)
      .filter((m) => m.category !== "derived_insight")
      .slice(0, 30)
      .map((m) => m.value)
      .join("; ");

    for (const insight of insights) {
      try {
        const result = await this.contradictionDetector.detect(
          insight.key,
          insight.value,
          sourceSummary
        );

        if (result.isContradiction) {
          log.info("Stale insight detected, invalidating", {
            key: insight.key,
            conflict: result.conflict,
            confidence: result.confidence,
          });

          // Supersede the stale insight with an invalidation note
          await this.memoryManager.supersede(
            insight.key,
            `[INVALIDATED: ${result.conflict}] Original: ${insight.value}`,
            {
              category: "derived_insight",
              priority: "low",
              metadata: {
                invalidatedAt: new Date().toISOString(),
                conflict: result.conflict,
                confidence: result.confidence,
                status: "invalidated",
              },
            }
          );

          await this.eventStore.createEvent(
            this.memoryManager.getSessionId(),
            "INSIGHT_INVALIDATED",
            {
              key: insight.key,
              conflict: result.conflict,
              confidence: result.confidence,
            }
          );

          invalidated++;
        }
      } catch (err) {
        log.warn("Failed to check insight for staleness", {
          key: insight.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return invalidated;
  }

}

// ============================================================================
// Factory
// ============================================================================

export function createDreamingEngine(
  memoryManager: MemoryManager,
  contradictionDetector: ContradictionDetector | null,
  userProfile: UserProfileStore,
  eventStore: EventStore,
  config?: Partial<DreamConfig>
): DreamingEngine {
  const resolvedConfig: DreamConfig = {
    maxMemoriesPerCycle: config?.maxMemoriesPerCycle ?? 200,
    minMemoriesForDreaming: config?.minMemoriesForDreaming ?? 20,
    deductionEnabled: config?.deductionEnabled ?? true,
    generalizationEnabled: config?.generalizationEnabled ?? true,
  };
  return new DreamingEngine(
    memoryManager,
    contradictionDetector,
    userProfile,
    eventStore,
    resolvedConfig
  );
}
