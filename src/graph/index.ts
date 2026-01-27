/**
 * Graph Module Exports
 *
 * Provides Neo4j client wrapper, entity extraction, relationship inference,
 * and bi-temporal storage for Graphiti integration.
 *
 * @module graph
 * @version 1.3.0
 */

export {
  Neo4jClient,
  Neo4jClientConfig,
  Neo4jClientError,
  Neo4jConnectionError,
  Neo4jQueryError,
  createNeo4jClient,
  createNeo4jClientFromEnv,
} from "./Neo4jClient.js";

export {
  EntityExtractor,
  EntityExtractorConfig,
  ExtractionContext,
  createEntityExtractor,
  createEntityExtractorWithConfig,
  DEFAULT_PATTERNS,
} from "./EntityExtractor.js";

export {
  RelationshipInferencer,
  RelationshipInferencerConfig,
  InferenceRule,
  createRelationshipInferencer,
  createRelationshipInferencerWithConfig,
  DEFAULT_INFERENCE_RULES,
} from "./RelationshipInferencer.js";

export {
  TemporalStore,
  TemporalStoreConfig,
  TemporalStoreError,
  BiTemporalMeta,
  createTemporalStore,
} from "./TemporalStore.js";

export {
  GraphManager,
  GraphManagerConfig,
  GraphManagerError,
  EntityNotFoundError,
  RelationshipNotFoundError,
  CreateEntityInput,
  CreateRelationshipInput,
  UpdateEntityInput,
  createGraphManager,
} from "./GraphManager.js";

export {
  LineageEngine,
  LineageEngineError,
  LineageEntityNotFoundError,
  LineagePathNotFoundError,
  EntityEvolutionEntry,
  LineageGraphNode,
  LineageGraphEdge,
  LineageGraph,
  createLineageEngine,
} from "./LineageEngine.js";

export {
  EvolutionEngine,
  EvolutionEngineConfig,
  EvolutionEngineError,
  EntityEvolutionNotFoundError,
  ChangeType,
  RelatedChange,
  EntityChange,
  EvolutionTimeline,
  EvolutionComparison,
  EvolutionQueryOptions,
  createEvolutionEngine,
} from "./EvolutionEngine.js";
