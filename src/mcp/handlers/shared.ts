/**
 * Shared session state passed by reference to all ToolModules.
 *
 * Mutable fields (currentSessionId, memoryManagers) are mutated
 * by ContextToolModule and read by all others.
 *
 * @module mcp/handlers/shared
 */

import type { SessionId } from "../../types/index.js";
import type { MemoryManager } from "../../memory/MemoryManager.js";
import type { SessionManager } from "../../session/SessionManager.js";
import type { EventStore } from "../../storage/EventStore.js";
import type { VectorIndex } from "../../search/VectorIndex.js";
import type { EntityExtractor } from "../../graph/EntityExtractor.js";
import type { LLMEntityExtractor } from "../../graph/LLMEntityExtractor.js";
import type { GraphManager } from "../../graph/GraphManager.js";
import type { HybridSearchEngine } from "../../search/HybridSearchEngine.js";
import type { LineageEngine } from "../../graph/LineageEngine.js";
import type { EvolutionEngine } from "../../graph/EvolutionEngine.js";
import type { IngestionService } from "../../ingest/IngestionService.js";
import type { DiagnosticsStore } from "../../diagnostics/index.js";
import type { SummaryGenerator } from "../../diagnostics/SummaryGenerator.js";
import type { RelevanceEngine } from "../../memory/RelevanceEngine.js";
import type { CausalGraphManager } from "../../graph/CausalGraphManager.js";
import type { CausalDiscoveryAgent } from "../../graph/CausalDiscoveryAgent.js";
import type { MemoryPubSub } from "../../pubsub/index.js";
import type { KnowledgeStore } from "../../knowledge/index.js";
import type { QdrantClientWrapper } from "../../search/QdrantClient.js";
import type { CcMemoryBridge } from "../../integration/CcMemoryBridge.js";
import type { ContradictionDetector } from "../../graph/ContradictionDetector.js";

/**
 * Mutable session state shared across all ToolModules by reference.
 */
export interface SessionState {
  /** Currently active session ID — mutated by ContextToolModule */
  currentSessionId: SessionId | null;
  /** Map of session IDs to MemoryManager instances — mutated by ContextToolModule */
  memoryManagers: Map<SessionId, MemoryManager>;

  // Read-only service references (set once in constructor, never reassigned)
  readonly sessionManager: SessionManager;
  readonly eventStore: EventStore;
  readonly vectorIndex: VectorIndex | null;
  readonly graphManager: GraphManager | null;
  readonly entityExtractor: EntityExtractor | null;
  readonly llmEntityExtractor: LLMEntityExtractor | null;
  readonly hybridSearchEngine: HybridSearchEngine | null;
  readonly lineageEngine: LineageEngine | null;
  readonly evolutionEngine: EvolutionEngine | null;
  readonly ingestionService: IngestionService | null;
  readonly diagnosticsStore: DiagnosticsStore | null;
  readonly summaryGenerator: SummaryGenerator | null;
  readonly relevanceEngine: RelevanceEngine | null;
  readonly causalGraphManager: CausalGraphManager | null;
  readonly causalDiscoveryAgent: CausalDiscoveryAgent | null;
  readonly pubsub: MemoryPubSub | null;
  readonly knowledgeStore: KnowledgeStore | null;
  readonly qdrantClient: QdrantClientWrapper | null;
  readonly ccMemoryBridge: CcMemoryBridge | null;
  readonly contradictionDetector: ContradictionDetector | null;
}

/**
 * Get the active MemoryManager for the current session.
 * Throws if no session is active or the manager is missing.
 */
export function getActiveMemoryManager(state: SessionState): MemoryManager {
  if (!state.currentSessionId) {
    throw new Error("No active session. Use context_session_start first.");
  }

  const memoryManager = state.memoryManagers.get(state.currentSessionId);
  if (!memoryManager) {
    throw new Error("Memory manager not found for current session");
  }

  return memoryManager;
}
