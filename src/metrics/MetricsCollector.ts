/**
 * Metrics Collector for ping-mem
 *
 * Collects and aggregates metrics for recall accuracy, retrieval quality (MRR, Precision@K),
 * and operation latency with percentile tracking.
 *
 * @module metrics/MetricsCollector
 * @version 1.0.0
 */

import type {
  ISOTimestamp,
  RecallMeasurement,
  RecallStats,
  RetrievalMeasurement,
  MRRStats,
  PrecisionAtKStats,
  LatencyMeasurement,
  LatencyStats,
  MetricsReport,
  MetricAlert,
  MetricsConfig,
  AlertThresholds,
} from "./types.js";

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: Required<MetricsConfig> = {
  enabled: true,
  windowSizeSeconds: 3600, // 1 hour
  latencyPercentiles: [50, 75, 90, 95, 99],
  precisionKValues: [1, 3, 5, 10],
  alertThresholds: {
    minMRR: 0.7,
    minPrecisionAt5: 0.8,
    maxP95LatencyMs: 500,
    minRecall: 0.7,
    maxErrorRate: 0.05,
  },
  storageType: "memory",
  maxMeasurements: 10000,
};

// ============================================================================
// MetricsCollector Class
// ============================================================================

/**
 * Collects and aggregates metrics for memory system operations
 */
export class MetricsCollector {
  private readonly config: Required<MetricsConfig>;

  // Measurement storage
  private recallMeasurements: RecallMeasurement[] = [];
  private retrievalMeasurements: RetrievalMeasurement[] = [];
  private latencyMeasurements: LatencyMeasurement[] = [];
  private alerts: MetricAlert[] = [];

  constructor(config?: Partial<MetricsConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      alertThresholds: {
        ...DEFAULT_CONFIG.alertThresholds,
        ...config?.alertThresholds,
      },
    };
  }

  // ==========================================================================
  // Recall Accuracy Recording
  // ==========================================================================

  /**
   * Record a recall accuracy measurement
   */
  recordRecall(
    query: string,
    expectedKeys: string[],
    retrievedKeys: string[],
    similarityThreshold: number
  ): RecallMeasurement {
    if (!this.config.enabled) {
      return this.createEmptyRecallMeasurement(
        query,
        expectedKeys,
        retrievedKeys,
        similarityThreshold
      );
    }

    const expectedSet = new Set(expectedKeys);
    const retrievedSet = new Set(retrievedKeys);

    // Calculate true positives (intersection)
    const truePositives = retrievedKeys.filter((k) => expectedSet.has(k)).length;

    // Calculate recall: TP / (TP + FN) = TP / expected
    const recall = expectedKeys.length > 0 ? truePositives / expectedKeys.length : 1;

    // Calculate precision: TP / (TP + FP) = TP / retrieved
    const precision = retrievedKeys.length > 0 ? truePositives / retrievedKeys.length : 1;

    // Calculate F1 score: 2 * (precision * recall) / (precision + recall)
    const f1Score =
      precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    const measurement: RecallMeasurement = {
      query,
      expectedKeys,
      retrievedKeys,
      similarityThreshold,
      recall,
      precision,
      f1Score,
      timestamp: new Date().toISOString(),
    };

    this.recallMeasurements.push(measurement);
    this.pruneOldMeasurements();

    // Check for alerts
    this.checkRecallAlerts(recall);

    return measurement;
  }

  /**
   * Get aggregated recall statistics
   */
  getRecallStats(): RecallStats {
    const measurements = this.getRecentRecallMeasurements();

    if (measurements.length === 0) {
      return this.createEmptyRecallStats();
    }

    const recalls = measurements.map((m) => m.recall);
    const precisions = measurements.map((m) => m.precision);
    const f1Scores = measurements.map((m) => m.f1Score);

    const meanRecall = this.mean(recalls);
    const stdDevRecall = this.stdDev(recalls, meanRecall);

    return {
      meanRecall,
      stdDevRecall,
      minRecall: Math.min(...recalls),
      maxRecall: Math.max(...recalls),
      meanPrecision: this.mean(precisions),
      meanF1: this.mean(f1Scores),
      sampleCount: measurements.length,
      windowStart: measurements[0]!.timestamp,
      windowEnd: measurements[measurements.length - 1]!.timestamp,
    };
  }

  // ==========================================================================
  // Retrieval Metrics Recording (MRR, Precision@K)
  // ==========================================================================

  /**
   * Record a retrieval measurement for MRR and Precision@K
   */
  recordRetrieval(
    query: string,
    retrievedKeys: string[],
    relevantKey: string
  ): RetrievalMeasurement {
    if (!this.config.enabled) {
      return this.createEmptyRetrievalMeasurement(query, retrievedKeys, relevantKey);
    }

    // Find rank of relevant key (1-indexed, 0 if not found)
    const rankIndex = retrievedKeys.indexOf(relevantKey);
    const rank = rankIndex >= 0 ? rankIndex + 1 : 0;

    // Calculate reciprocal rank
    const reciprocalRank = rank > 0 ? 1 / rank : 0;

    // Check if relevant key is in top K for each K value
    const inTopK: Record<number, boolean> = {};
    for (const k of this.config.precisionKValues) {
      inTopK[k] = rank > 0 && rank <= k;
    }

    const measurement: RetrievalMeasurement = {
      query,
      retrievedKeys,
      relevantKey,
      rank,
      reciprocalRank,
      inTopK,
      timestamp: new Date().toISOString(),
    };

    this.retrievalMeasurements.push(measurement);
    this.pruneOldMeasurements();

    // Check for alerts
    this.checkRetrievalAlerts(reciprocalRank, inTopK);

    return measurement;
  }

  /**
   * Get Mean Reciprocal Rank statistics
   */
  getMRRStats(): MRRStats {
    const measurements = this.getRecentRetrievalMeasurements();

    if (measurements.length === 0) {
      return this.createEmptyMRRStats();
    }

    const reciprocalRanks = measurements.map((m) => m.reciprocalRank);
    const foundCount = measurements.filter((m) => m.rank > 0).length;

    return {
      mrr: this.mean(reciprocalRanks),
      queryCount: measurements.length,
      foundCount,
      hitRate: measurements.length > 0 ? foundCount / measurements.length : 0,
      windowStart: measurements[0]!.timestamp,
      windowEnd: measurements[measurements.length - 1]!.timestamp,
    };
  }

  /**
   * Get Precision@K statistics for all configured K values
   */
  getPrecisionAtKStats(): PrecisionAtKStats[] {
    const measurements = this.getRecentRetrievalMeasurements();

    if (measurements.length === 0) {
      return this.config.precisionKValues.map((k) =>
        this.createEmptyPrecisionAtKStats(k)
      );
    }

    return this.config.precisionKValues.map((k) => {
      const successCount = measurements.filter((m) => m.inTopK[k]).length;

      return {
        k,
        precision: measurements.length > 0 ? successCount / measurements.length : 0,
        queryCount: measurements.length,
        successCount,
        windowStart: measurements[0]!.timestamp,
        windowEnd: measurements[measurements.length - 1]!.timestamp,
      };
    });
  }

  // ==========================================================================
  // Latency Recording
  // ==========================================================================

  /**
   * Record a latency measurement
   */
  recordLatency(
    operation: LatencyMeasurement["operation"],
    durationMs: number,
    success: boolean,
    error?: string,
    itemCount?: number
  ): LatencyMeasurement {
    if (!this.config.enabled) {
      return this.createEmptyLatencyMeasurement(operation, durationMs, success);
    }

    const measurement: LatencyMeasurement = {
      operation,
      durationMs,
      success,
      timestamp: new Date().toISOString(),
    };

    // Only add optional properties if defined (exactOptionalPropertyTypes)
    if (error !== undefined) {
      measurement.error = error;
    }
    if (itemCount !== undefined) {
      measurement.itemCount = itemCount;
    }

    this.latencyMeasurements.push(measurement);
    this.pruneOldMeasurements();

    // Check for alerts
    this.checkLatencyAlerts(operation);

    return measurement;
  }

  /**
   * Get latency statistics for a specific operation or all operations
   */
  getLatencyStats(
    operation?: LatencyMeasurement["operation"]
  ): LatencyStats {
    let measurements = this.getRecentLatencyMeasurements();

    if (operation) {
      measurements = measurements.filter((m) => m.operation === operation);
    }

    if (measurements.length === 0) {
      return this.createEmptyLatencyStats(operation ?? "all");
    }

    const durations = measurements.map((m) => m.durationMs).sort((a, b) => a - b);
    const successCount = measurements.filter((m) => m.success).length;

    const meanValue = this.mean(durations);

    return {
      operation: operation ?? "all",
      p50: this.percentile(durations, 50),
      p75: this.percentile(durations, 75),
      p90: this.percentile(durations, 90),
      p95: this.percentile(durations, 95),
      p99: this.percentile(durations, 99),
      mean: meanValue,
      stdDev: this.stdDev(durations, meanValue),
      min: durations[0]!,
      max: durations[durations.length - 1]!,
      sampleCount: measurements.length,
      successRate: measurements.length > 0 ? successCount / measurements.length : 1,
      windowStart: measurements[0]!.timestamp,
      windowEnd: measurements[measurements.length - 1]!.timestamp,
    };
  }

  // ==========================================================================
  // Report Generation
  // ==========================================================================

  /**
   * Generate a complete metrics report
   */
  generateReport(): MetricsReport {
    const now = new Date().toISOString();
    const windowStart = new Date(
      Date.now() - this.config.windowSizeSeconds * 1000
    ).toISOString();

    const recallStats = this.getRecallStats();
    const mrrStats = this.getMRRStats();
    const precisionAtK = this.getPrecisionAtKStats();

    // Get latency stats for all operation types
    const operations: LatencyMeasurement["operation"][] = [
      "save",
      "get",
      "recall",
      "semanticSearch",
      "delete",
    ];
    const latencyStats = operations.map((op) => this.getLatencyStats(op));

    // Calculate health score
    const healthScore = this.calculateHealthScore(
      recallStats,
      mrrStats,
      precisionAtK,
      latencyStats
    );

    return {
      generatedAt: now,
      windowStart,
      windowEnd: now,
      recallStats,
      mrrStats,
      precisionAtK,
      latencyStats,
      healthScore,
      alerts: [...this.alerts],
    };
  }

  // ==========================================================================
  // Alert Management
  // ==========================================================================

  /**
   * Get all alerts
   */
  getAlerts(): MetricAlert[] {
    return [...this.alerts];
  }

  /**
   * Clear all alerts
   */
  clearAlerts(): void {
    this.alerts = [];
  }

  // ==========================================================================
  // Configuration
  // ==========================================================================

  /**
   * Get current configuration
   */
  getConfig(): Required<MetricsConfig> {
    return { ...this.config };
  }

  /**
   * Check if metrics collection is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Reset all measurements
   */
  reset(): void {
    this.recallMeasurements = [];
    this.retrievalMeasurements = [];
    this.latencyMeasurements = [];
    this.alerts = [];
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  private getRecentRecallMeasurements(): RecallMeasurement[] {
    const cutoff = Date.now() - this.config.windowSizeSeconds * 1000;
    return this.recallMeasurements.filter(
      (m) => new Date(m.timestamp).getTime() >= cutoff
    );
  }

  private getRecentRetrievalMeasurements(): RetrievalMeasurement[] {
    const cutoff = Date.now() - this.config.windowSizeSeconds * 1000;
    return this.retrievalMeasurements.filter(
      (m) => new Date(m.timestamp).getTime() >= cutoff
    );
  }

  private getRecentLatencyMeasurements(): LatencyMeasurement[] {
    const cutoff = Date.now() - this.config.windowSizeSeconds * 1000;
    return this.latencyMeasurements.filter(
      (m) => new Date(m.timestamp).getTime() >= cutoff
    );
  }

  private pruneOldMeasurements(): void {
    // Prune by count
    const max = this.config.maxMeasurements;

    if (this.recallMeasurements.length > max) {
      this.recallMeasurements = this.recallMeasurements.slice(-max);
    }
    if (this.retrievalMeasurements.length > max) {
      this.retrievalMeasurements = this.retrievalMeasurements.slice(-max);
    }
    if (this.latencyMeasurements.length > max) {
      this.latencyMeasurements = this.latencyMeasurements.slice(-max);
    }
    if (this.alerts.length > max) {
      this.alerts = this.alerts.slice(-max);
    }
  }

  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  private stdDev(values: number[], mean: number): number {
    if (values.length < 2) return 0;
    const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
    return Math.sqrt(squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length);
  }

  private percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;
    if (sortedValues.length === 1) return sortedValues[0]!;

    const index = (p / 100) * (sortedValues.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);

    if (lower === upper) {
      return sortedValues[lower]!;
    }

    const fraction = index - lower;
    return sortedValues[lower]! + fraction * (sortedValues[upper]! - sortedValues[lower]!);
  }

  private checkRecallAlerts(recall: number): void {
    const threshold = this.config.alertThresholds.minRecall ?? 0.7;
    if (recall < threshold) {
      this.addAlert("warning", "recall", recall, threshold, "Recall below threshold");
    }
  }

  private checkRetrievalAlerts(
    reciprocalRank: number,
    inTopK: Record<number, boolean>
  ): void {
    const mrrThreshold = this.config.alertThresholds.minMRR ?? 0.7;
    if (reciprocalRank < mrrThreshold) {
      this.addAlert(
        "warning",
        "mrr",
        reciprocalRank,
        mrrThreshold,
        "MRR below threshold"
      );
    }

    const precisionThreshold = this.config.alertThresholds.minPrecisionAt5 ?? 0.8;
    if (inTopK[5] === false) {
      this.addAlert(
        "warning",
        "precision@5",
        0,
        precisionThreshold,
        "Relevant item not in top 5"
      );
    }
  }

  private checkLatencyAlerts(operation: LatencyMeasurement["operation"]): void {
    const stats = this.getLatencyStats(operation);
    const maxP95 = this.config.alertThresholds.maxP95LatencyMs ?? 500;

    if (stats.p95 > maxP95) {
      this.addAlert(
        "warning",
        `latency.${operation}.p95`,
        stats.p95,
        maxP95,
        "P95 latency above threshold"
      );
    }

    const maxErrorRate = this.config.alertThresholds.maxErrorRate ?? 0.05;
    if (1 - stats.successRate > maxErrorRate) {
      this.addAlert(
        "error",
        `error_rate.${operation}`,
        1 - stats.successRate,
        maxErrorRate,
        "Error rate above threshold"
      );
    }
  }

  private addAlert(
    severity: MetricAlert["severity"],
    metric: string,
    currentValue: number,
    threshold: number,
    message: string
  ): void {
    this.alerts.push({
      severity,
      metric,
      message,
      currentValue,
      threshold,
      timestamp: new Date().toISOString(),
    });
  }

  private calculateHealthScore(
    recallStats: RecallStats,
    mrrStats: MRRStats,
    precisionAtK: PrecisionAtKStats[],
    latencyStats: LatencyStats[]
  ): number {
    let score = 100;

    // Penalize low recall (up to -30 points)
    if (recallStats.sampleCount > 0) {
      const recallPenalty = Math.max(0, (0.7 - recallStats.meanRecall) * 30);
      score -= recallPenalty;
    }

    // Penalize low MRR (up to -25 points)
    if (mrrStats.queryCount > 0) {
      const mrrPenalty = Math.max(0, (0.7 - mrrStats.mrr) * 25);
      score -= mrrPenalty;
    }

    // Penalize low Precision@5 (up to -20 points)
    const p5Stats = precisionAtK.find((p) => p.k === 5);
    if (p5Stats && p5Stats.queryCount > 0) {
      const p5Penalty = Math.max(0, (0.8 - p5Stats.precision) * 20);
      score -= p5Penalty;
    }

    // Penalize high latency (up to -15 points)
    for (const stats of latencyStats) {
      if (stats.sampleCount > 0 && stats.p95 > 500) {
        const latencyPenalty = Math.min(15, (stats.p95 - 500) / 100);
        score -= latencyPenalty;
      }
    }

    // Penalize errors (up to -10 points)
    for (const stats of latencyStats) {
      if (stats.sampleCount > 0 && stats.successRate < 1) {
        const errorPenalty = (1 - stats.successRate) * 10;
        score -= errorPenalty;
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  // ==========================================================================
  // Empty Object Factories
  // ==========================================================================

  private createEmptyRecallMeasurement(
    query: string,
    expectedKeys: string[],
    retrievedKeys: string[],
    similarityThreshold: number
  ): RecallMeasurement {
    return {
      query,
      expectedKeys,
      retrievedKeys,
      similarityThreshold,
      recall: 0,
      precision: 0,
      f1Score: 0,
      timestamp: new Date().toISOString(),
    };
  }

  private createEmptyRecallStats(): RecallStats {
    const now = new Date().toISOString();
    return {
      meanRecall: 0,
      stdDevRecall: 0,
      minRecall: 0,
      maxRecall: 0,
      meanPrecision: 0,
      meanF1: 0,
      sampleCount: 0,
      windowStart: now,
      windowEnd: now,
    };
  }

  private createEmptyRetrievalMeasurement(
    query: string,
    retrievedKeys: string[],
    relevantKey: string
  ): RetrievalMeasurement {
    const inTopK: Record<number, boolean> = {};
    for (const k of this.config.precisionKValues) {
      inTopK[k] = false;
    }
    return {
      query,
      retrievedKeys,
      relevantKey,
      rank: 0,
      reciprocalRank: 0,
      inTopK,
      timestamp: new Date().toISOString(),
    };
  }

  private createEmptyMRRStats(): MRRStats {
    const now = new Date().toISOString();
    return {
      mrr: 0,
      queryCount: 0,
      foundCount: 0,
      hitRate: 0,
      windowStart: now,
      windowEnd: now,
    };
  }

  private createEmptyPrecisionAtKStats(k: number): PrecisionAtKStats {
    const now = new Date().toISOString();
    return {
      k,
      precision: 0,
      queryCount: 0,
      successCount: 0,
      windowStart: now,
      windowEnd: now,
    };
  }

  private createEmptyLatencyMeasurement(
    operation: LatencyMeasurement["operation"],
    durationMs: number,
    success: boolean
  ): LatencyMeasurement {
    return {
      operation,
      durationMs,
      success,
      timestamp: new Date().toISOString(),
    };
  }

  private createEmptyLatencyStats(
    operation: LatencyStats["operation"]
  ): LatencyStats {
    const now = new Date().toISOString();
    return {
      operation,
      p50: 0,
      p75: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      mean: 0,
      stdDev: 0,
      min: 0,
      max: 0,
      sampleCount: 0,
      successRate: 1,
      windowStart: now,
      windowEnd: now,
    };
  }
}

// ============================================================================
// Export Default Instance Factory
// ============================================================================

/**
 * Create a new MetricsCollector instance
 */
export function createMetricsCollector(
  config?: Partial<MetricsConfig>
): MetricsCollector {
  return new MetricsCollector(config);
}
