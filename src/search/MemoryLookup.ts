import type { VectorSearchResult } from "./VectorIndex.js";

/**
 * Interface for looking up memories by entity names.
 * Avoids circular dependency between HybridSearchEngine and MemoryManager.
 */
export interface MemoryLookup {
  lookupByEntityNames(names: string[]): Promise<VectorSearchResult[]>;
}
