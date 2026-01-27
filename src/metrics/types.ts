/**
 * Metrics Types for ping-mem
 *
 * Defines types for recall accuracy, retrieval metrics (MRR, Precision@K),
 * and latency percentiles.
 *
 * @module metrics/types
 * @version 1.0.0
 */

// ============================================================================
// Core Metric Types
// ============================================================================

/**
 * Timestamp in ISO 8601 format
 */
export type ISOTimestamp = string;

/**
 * Metric value with timestamp
 */
export interface TimestampedValue<T> {
  value: T;
  timestamp: ISOTimestamp;
}

/**
 * Rolling window configuration
 */
export interface WindowConfig {
  /** Window size in seconds */
  sizeSeconds: number;
  /** Number of buckets for aggregation */
  buckets: number;
}

// ============================================================================
// Recall Accuracy Metrics
// ============================================================================

/**
 * Recall accuracy measurement for a single query
 */
export interface RecallMeasurement {
  /** Query that was executed */
  query: string;
  /** Expected relevant items (ground truth) */
  expectedKeys: string[];
  /** Actually retrieved items */
  retrievedKeys: string[];
  /** Cosine similarity threshold used */
  similarityThreshold: number;
  /** Recall score (0-1) */
  recall: number;
  /** Precision score (0-1) */
  precision: number;
  /** F1 score (0-1) */
  f1Score: number;
  /** Timestamp of measurement */
  timestamp: ISOTimestamp;
}

/**
 * Aggregated recall statistics
 */
export interface RecallStats {
  /** Mean recall across all measurements */
  meanRecall: number;
  /** Standard deviation of recall */
  stdDevRecall: number;
  /** Minimum recall observed */
  minRecall: number;
  /** Maximum recall observed */
  maxRecall: number;
  /** Mean precision */
  meanPrecision: number;
  /** Mean F1 score */
  meanF1: number;
  /** Number of measurements */
  sampleCount: number;
  /** Time window of measurements */
  windowStart: ISOTimestamp;
  windowEnd: ISOTimestamp;
}

// ============================================================================
// Retrieval Metrics (MRR, Precision@K)
// ============================================================================

/**
 * Single retrieval evaluation
 */
export interface RetrievalMeasurement {
  /** Query executed */
  query: string;
  /** Ranked list of retrieved keys */
  retrievedKeys: string[];
  /** The relevant key (ground truth) */
  relevantKey: string;
  /** Rank of the relevant key (1-indexed, 0 if not found) */
  rank: number;
  /** Reciprocal rank (1/rank, 0 if not found) */
  reciprocalRank: number;
  /** Whether relevant key was in top K */
  inTopK: Record<number, boolean>;
  /** Timestamp */
  timestamp: ISOTimestamp;
}

/**
 * Mean Reciprocal Rank statistics
 */
export interface MRRStats {
  /** Mean reciprocal rank across all queries */
  mrr: number;
  /** Number of queries evaluated */
  queryCount: number;
  /** Queries where relevant item was found */
  foundCount: number;
  /** Hit rate (foundCount / queryCount) */
  hitRate: number;
  /** Time window */
  windowStart: ISOTimestamp;
  windowEnd: ISOTimestamp;
}

/**
 * Precision@K statistics
 */
export interface PrecisionAtKStats {
  /** K value (e.g., 1, 3, 5, 10) */
  k: number;
  /** Precision at K */
  precision: number;
  /** Number of queries evaluated */
  queryCount: number;
  /** Queries with relevant item in top K */
  successCount: number;
  /** Time window */
  windowStart: ISOTimestamp;
  windowEnd: ISOTimestamp;
}

// ============================================================================
// Latency Metrics
// ============================================================================

/**
 * Single latency measurement
 */
export interface LatencyMeasurement {
  /** Operation type */
  operation: "save" | "get" | "recall" | "semanticSearch" | "delete";
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether operation was successful */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Number of items processed (for batch operations) */
  itemCount?: number;
  /** Timestamp */
  timestamp: ISOTimestamp;
}

/**
 * Latency percentile statistics
 */
export interface LatencyStats {
  /** Operation type */
  operation: "save" | "get" | "recall" | "semanticSearch" | "delete" | "all";
  /** P50 (median) latency in ms */
  p50: number;
  /** P75 latency in ms */
  p75: number;
  /** P90 latency in ms */
  p90: number;
  /** P95 latency in ms */
  p95: number;
  /** P99 latency in ms */
  p99: number;
  /** Mean latency in ms */
  mean: number;
  /** Standard deviation in ms */
  stdDev: number;
  /** Minimum latency in ms */
  min: number;
  /** Maximum latency in ms */
  max: number;
  /** Number of measurements */
  sampleCount: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Time window */
  windowStart: ISOTimestamp;
  windowEnd: ISOTimestamp;
}

// ============================================================================
// Aggregate Metrics Report
// ============================================================================

/**
 * Complete metrics report
 */
export interface MetricsReport {
  /** Report generation timestamp */
  generatedAt: ISOTimestamp;
  /** Time window covered */
  windowStart: ISOTimestamp;
  windowEnd: ISOTimestamp;
  /** Recall accuracy statistics */
  recallStats: RecallStats;
  /** Mean Reciprocal Rank statistics */
  mrrStats: MRRStats;
  /** Precision@K for various K values */
  precisionAtK: PrecisionAtKStats[];
  /** Latency statistics per operation */
  latencyStats: LatencyStats[];
  /** Overall system health score (0-100) */
  healthScore: number;
  /** Any alerts or warnings */
  alerts: MetricAlert[];
}

/**
 * Metric alert when thresholds are breached
 */
export interface MetricAlert {
  /** Alert severity */
  severity: "warning" | "error" | "critical";
  /** Metric that triggered the alert */
  metric: string;
  /** Alert message */
  message: string;
  /** Current value */
  currentValue: number;
  /** Threshold that was breached */
  threshold: number;
  /** Timestamp */
  timestamp: ISOTimestamp;
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Metrics collector configuration
 */
export interface MetricsConfig {
  /** Enable metrics collection */
  enabled: boolean;
  /** Rolling window size in seconds (default: 3600 = 1 hour) */
  windowSizeSeconds?: number;
  /** Latency percentiles to track */
  latencyPercentiles?: number[];
  /** K values for Precision@K */
  precisionKValues?: number[];
  /** Alert thresholds */
  alertThresholds?: AlertThresholds;
  /** Storage backend (in-memory or persistent) */
  storageType?: "memory" | "persistent";
  /** Maximum measurements to retain in memory */
  maxMeasurements?: number;
}

/**
 * Alert threshold configuration
 */
export interface AlertThresholds {
  /** Minimum acceptable MRR (default: 0.7) */
  minMRR?: number;
  /** Minimum acceptable Precision@5 (default: 0.8) */
  minPrecisionAt5?: number;
  /** Maximum acceptable P95 latency in ms (default: 500) */
  maxP95LatencyMs?: number;
  /** Minimum acceptable recall (default: 0.7) */
  minRecall?: number;
  /** Maximum acceptable error rate (default: 0.05) */
  maxErrorRate?: number;
}

// ============================================================================
// Metric Events for Event Sourcing
// ============================================================================

/**
 * Base metric event
 */
export interface MetricEvent {
  type: string;
  timestamp: ISOTimestamp;
  sessionId?: string;
}

/**
 * Recall measurement event
 */
export interface RecallMeasuredEvent extends MetricEvent {
  type: "RECALL_MEASURED";
  measurement: RecallMeasurement;
}

/**
 * Retrieval measurement event
 */
export interface RetrievalMeasuredEvent extends MetricEvent {
  type: "RETRIEVAL_MEASURED";
  measurement: RetrievalMeasurement;
}

/**
 * Latency measurement event
 */
export interface LatencyMeasuredEvent extends MetricEvent {
  type: "LATENCY_MEASURED";
  measurement: LatencyMeasurement;
}

/**
 * Alert triggered event
 */
export interface AlertTriggeredEvent extends MetricEvent {
  type: "ALERT_TRIGGERED";
  alert: MetricAlert;
}

/**
 * All metric event types
 */
export type MetricEventType =
  | RecallMeasuredEvent
  | RetrievalMeasuredEvent
  | LatencyMeasuredEvent
  | AlertTriggeredEvent;
