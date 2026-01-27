/**
 * Tests for MetricsCollector
 *
 * @module metrics/__tests__/MetricsCollector.test
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { MetricsCollector, createMetricsCollector } from "../MetricsCollector.js";

describe("MetricsCollector", () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  describe("Initialization", () => {
    it("should create with default configuration", () => {
      expect(collector.isEnabled()).toBe(true);
      const config = collector.getConfig();
      expect(config.windowSizeSeconds).toBe(3600);
      expect(config.precisionKValues).toEqual([1, 3, 5, 10]);
      expect(config.maxMeasurements).toBe(10000);
    });

    it("should create with custom configuration", () => {
      const customCollector = new MetricsCollector({
        enabled: false,
        windowSizeSeconds: 7200,
        precisionKValues: [1, 5, 10, 20],
        alertThresholds: {
          minMRR: 0.8,
        },
      });

      expect(customCollector.isEnabled()).toBe(false);
      const config = customCollector.getConfig();
      expect(config.windowSizeSeconds).toBe(7200);
      expect(config.precisionKValues).toEqual([1, 5, 10, 20]);
      expect(config.alertThresholds.minMRR).toBe(0.8);
    });

    it("should create using factory function", () => {
      const factoryCollector = createMetricsCollector({ enabled: true });
      expect(factoryCollector.isEnabled()).toBe(true);
    });
  });

  describe("Recall Accuracy", () => {
    it("should calculate perfect recall and precision", () => {
      const measurement = collector.recordRecall(
        "test query",
        ["a", "b", "c"],
        ["a", "b", "c"],
        0.8
      );

      expect(measurement.recall).toBe(1);
      expect(measurement.precision).toBe(1);
      expect(measurement.f1Score).toBe(1);
    });

    it("should calculate partial recall", () => {
      const measurement = collector.recordRecall(
        "test query",
        ["a", "b", "c", "d"],
        ["a", "b"],
        0.8
      );

      // Recall: 2/4 = 0.5
      expect(measurement.recall).toBe(0.5);
      // Precision: 2/2 = 1
      expect(measurement.precision).toBe(1);
      // F1: 2 * (0.5 * 1) / (0.5 + 1) = 2/3
      expect(measurement.f1Score).toBeCloseTo(2 / 3);
    });

    it("should calculate partial precision", () => {
      const measurement = collector.recordRecall(
        "test query",
        ["a", "b"],
        ["a", "b", "c", "d"],
        0.8
      );

      // Recall: 2/2 = 1
      expect(measurement.recall).toBe(1);
      // Precision: 2/4 = 0.5
      expect(measurement.precision).toBe(0.5);
      // F1: 2 * (1 * 0.5) / (1 + 0.5) = 2/3
      expect(measurement.f1Score).toBeCloseTo(2 / 3);
    });

    it("should handle zero recall (no matches)", () => {
      const measurement = collector.recordRecall(
        "test query",
        ["a", "b", "c"],
        ["x", "y", "z"],
        0.8
      );

      expect(measurement.recall).toBe(0);
      expect(measurement.precision).toBe(0);
      expect(measurement.f1Score).toBe(0);
    });

    it("should handle empty expected keys", () => {
      const measurement = collector.recordRecall(
        "test query",
        [],
        ["a", "b"],
        0.8
      );

      // When expected is empty, recall is 1 (nothing to find)
      expect(measurement.recall).toBe(1);
      expect(measurement.precision).toBe(0);
    });

    it("should handle empty retrieved keys", () => {
      const measurement = collector.recordRecall(
        "test query",
        ["a", "b"],
        [],
        0.8
      );

      expect(measurement.recall).toBe(0);
      // When retrieved is empty, precision is 1 (no false positives)
      expect(measurement.precision).toBe(1);
    });

    it("should aggregate recall statistics", () => {
      // Record multiple measurements
      collector.recordRecall("q1", ["a", "b"], ["a", "b"], 0.8); // recall = 1
      collector.recordRecall("q2", ["a", "b", "c", "d"], ["a", "b"], 0.8); // recall = 0.5
      collector.recordRecall("q3", ["a", "b", "c"], ["a", "c"], 0.8); // recall = 2/3

      const stats = collector.getRecallStats();

      expect(stats.sampleCount).toBe(3);
      // Mean: (1 + 0.5 + 2/3) / 3 ≈ 0.722
      expect(stats.meanRecall).toBeCloseTo((1 + 0.5 + 2 / 3) / 3, 2);
      expect(stats.minRecall).toBe(0.5);
      expect(stats.maxRecall).toBe(1);
    });

    it("should return empty stats when no measurements", () => {
      const stats = collector.getRecallStats();
      expect(stats.sampleCount).toBe(0);
      expect(stats.meanRecall).toBe(0);
    });
  });

  describe("Retrieval Metrics (MRR, Precision@K)", () => {
    it("should calculate rank and reciprocal rank correctly", () => {
      const measurement = collector.recordRetrieval(
        "test query",
        ["a", "b", "c", "d", "e"],
        "c"
      );

      expect(measurement.rank).toBe(3); // 1-indexed
      expect(measurement.reciprocalRank).toBeCloseTo(1 / 3);
    });

    it("should handle item at first position (rank 1)", () => {
      const measurement = collector.recordRetrieval(
        "test query",
        ["target", "b", "c"],
        "target"
      );

      expect(measurement.rank).toBe(1);
      expect(measurement.reciprocalRank).toBe(1);
      expect(measurement.inTopK[1]).toBe(true);
      expect(measurement.inTopK[5]).toBe(true);
    });

    it("should handle item not found (rank 0)", () => {
      const measurement = collector.recordRetrieval(
        "test query",
        ["a", "b", "c"],
        "missing"
      );

      expect(measurement.rank).toBe(0);
      expect(measurement.reciprocalRank).toBe(0);
      expect(measurement.inTopK[1]).toBe(false);
      expect(measurement.inTopK[5]).toBe(false);
    });

    it("should calculate inTopK correctly", () => {
      // Item at position 3
      const measurement = collector.recordRetrieval(
        "test query",
        ["a", "b", "target", "d", "e", "f"],
        "target"
      );

      expect(measurement.inTopK[1]).toBe(false);
      expect(measurement.inTopK[3]).toBe(true);
      expect(measurement.inTopK[5]).toBe(true);
      expect(measurement.inTopK[10]).toBe(true);
    });

    it("should calculate MRR statistics", () => {
      // Multiple queries with different ranks
      collector.recordRetrieval("q1", ["a", "b", "c"], "a"); // RR = 1
      collector.recordRetrieval("q2", ["a", "b", "c"], "b"); // RR = 0.5
      collector.recordRetrieval("q3", ["a", "b", "c"], "c"); // RR = 1/3
      collector.recordRetrieval("q4", ["a", "b", "c"], "missing"); // RR = 0

      const stats = collector.getMRRStats();

      expect(stats.queryCount).toBe(4);
      expect(stats.foundCount).toBe(3);
      expect(stats.hitRate).toBe(0.75);
      // MRR: (1 + 0.5 + 1/3 + 0) / 4 ≈ 0.458
      expect(stats.mrr).toBeCloseTo((1 + 0.5 + 1 / 3 + 0) / 4, 2);
    });

    it("should calculate Precision@K statistics", () => {
      // 3 queries: 2 have target in top 5, 1 doesn't
      collector.recordRetrieval("q1", ["a", "b", "c", "d", "e"], "a"); // in top 5
      collector.recordRetrieval("q2", ["a", "b", "c", "d", "e"], "d"); // in top 5
      collector.recordRetrieval(
        "q3",
        ["a", "b", "c", "d", "e", "target"],
        "target"
      ); // NOT in top 5

      const stats = collector.getPrecisionAtKStats();
      const p5Stats = stats.find((s) => s.k === 5);

      expect(p5Stats).toBeDefined();
      expect(p5Stats!.queryCount).toBe(3);
      expect(p5Stats!.successCount).toBe(2);
      expect(p5Stats!.precision).toBeCloseTo(2 / 3);
    });

    it("should return empty MRR stats when no measurements", () => {
      const stats = collector.getMRRStats();
      expect(stats.queryCount).toBe(0);
      expect(stats.mrr).toBe(0);
    });
  });

  describe("Latency Metrics", () => {
    it("should record latency measurement", () => {
      const measurement = collector.recordLatency("save", 50, true);

      expect(measurement.operation).toBe("save");
      expect(measurement.durationMs).toBe(50);
      expect(measurement.success).toBe(true);
    });

    it("should record latency with error", () => {
      const measurement = collector.recordLatency(
        "get",
        100,
        false,
        "Connection timeout"
      );

      expect(measurement.success).toBe(false);
      expect(measurement.error).toBe("Connection timeout");
    });

    it("should record latency with item count", () => {
      const measurement = collector.recordLatency(
        "save",
        200,
        true,
        undefined,
        10
      );

      expect(measurement.itemCount).toBe(10);
    });

    it("should calculate percentiles correctly", () => {
      // Add sorted latencies: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
      for (let i = 1; i <= 10; i++) {
        collector.recordLatency("save", i * 10, true);
      }

      const stats = collector.getLatencyStats("save");

      expect(stats.sampleCount).toBe(10);
      expect(stats.min).toBe(10);
      expect(stats.max).toBe(100);
      expect(stats.mean).toBe(55); // (10+20+...+100)/10
      expect(stats.p50).toBeCloseTo(55, 0); // median
      expect(stats.p90).toBeCloseTo(91, 0);
      expect(stats.p95).toBeCloseTo(95.5, 0);
    });

    it("should calculate success rate", () => {
      // 8 successes, 2 failures
      for (let i = 0; i < 8; i++) {
        collector.recordLatency("save", 50, true);
      }
      collector.recordLatency("save", 50, false, "Error 1");
      collector.recordLatency("save", 50, false, "Error 2");

      const stats = collector.getLatencyStats("save");

      expect(stats.sampleCount).toBe(10);
      expect(stats.successRate).toBe(0.8);
    });

    it("should filter by operation", () => {
      collector.recordLatency("save", 50, true);
      collector.recordLatency("save", 60, true);
      collector.recordLatency("get", 20, true);
      collector.recordLatency("recall", 100, true);

      const saveStats = collector.getLatencyStats("save");
      expect(saveStats.sampleCount).toBe(2);
      expect(saveStats.operation).toBe("save");

      const allStats = collector.getLatencyStats();
      expect(allStats.sampleCount).toBe(4);
      expect(allStats.operation).toBe("all");
    });

    it("should return empty stats when no measurements", () => {
      const stats = collector.getLatencyStats("save");
      expect(stats.sampleCount).toBe(0);
      expect(stats.p50).toBe(0);
      expect(stats.successRate).toBe(1);
    });
  });

  describe("Alerts", () => {
    it("should generate alert when recall is below threshold", () => {
      const lowRecallCollector = new MetricsCollector({
        alertThresholds: { minRecall: 0.8 },
      });

      lowRecallCollector.recordRecall("q", ["a", "b", "c", "d"], ["a"], 0.8);

      const alerts = lowRecallCollector.getAlerts();
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts.some((a) => a.metric === "recall")).toBe(true);
    });

    it("should generate alert when MRR is below threshold", () => {
      const mrrCollector = new MetricsCollector({
        alertThresholds: { minMRR: 0.5 },
      });

      // Rank 5 -> RR = 0.2 < 0.5
      mrrCollector.recordRetrieval("q", ["a", "b", "c", "d", "target"], "target");

      const alerts = mrrCollector.getAlerts();
      expect(alerts.some((a) => a.metric === "mrr")).toBe(true);
    });

    it("should generate alert when relevant item not in top 5", () => {
      // Item at position 6
      collector.recordRetrieval(
        "q",
        ["a", "b", "c", "d", "e", "target"],
        "target"
      );

      const alerts = collector.getAlerts();
      expect(alerts.some((a) => a.metric === "precision@5")).toBe(true);
    });

    it("should clear alerts", () => {
      collector.recordRecall("q", ["a", "b", "c", "d"], ["a"], 0.8);
      expect(collector.getAlerts().length).toBeGreaterThan(0);

      collector.clearAlerts();
      expect(collector.getAlerts().length).toBe(0);
    });
  });

  describe("Report Generation", () => {
    it("should generate complete report", () => {
      // Add some measurements
      collector.recordRecall("q1", ["a", "b"], ["a", "b"], 0.8);
      collector.recordRetrieval("q1", ["a", "b", "c"], "a");
      collector.recordLatency("save", 50, true);

      const report = collector.generateReport();

      expect(report.generatedAt).toBeDefined();
      expect(report.windowStart).toBeDefined();
      expect(report.windowEnd).toBeDefined();
      expect(report.recallStats).toBeDefined();
      expect(report.mrrStats).toBeDefined();
      expect(report.precisionAtK).toBeDefined();
      expect(report.latencyStats).toBeDefined();
      expect(report.healthScore).toBeGreaterThanOrEqual(0);
      expect(report.healthScore).toBeLessThanOrEqual(100);
      expect(Array.isArray(report.alerts)).toBe(true);
    });

    it("should calculate health score with good metrics", () => {
      // Perfect recall
      collector.recordRecall("q1", ["a", "b"], ["a", "b"], 0.8);
      // Perfect MRR (rank 1)
      collector.recordRetrieval("q1", ["a", "b", "c"], "a");
      // Good latency
      collector.recordLatency("save", 50, true);

      const report = collector.generateReport();

      // Should be close to 100 with good metrics
      expect(report.healthScore).toBeGreaterThan(90);
    });

    it("should reduce health score with poor metrics", () => {
      // Zero recall
      collector.recordRecall("q1", ["a", "b", "c"], ["x", "y"], 0.8);
      // Low MRR (not found)
      collector.recordRetrieval("q1", ["a", "b", "c"], "missing");
      // High latency
      collector.recordLatency("save", 1000, true);
      // Error
      collector.recordLatency("get", 50, false, "Error");

      const report = collector.generateReport();

      // Should be significantly reduced
      expect(report.healthScore).toBeLessThan(70);
    });
  });

  describe("Disabled Mode", () => {
    it("should not record measurements when disabled", () => {
      const disabledCollector = new MetricsCollector({ enabled: false });

      disabledCollector.recordRecall("q", ["a"], ["a"], 0.8);
      disabledCollector.recordRetrieval("q", ["a"], "a");
      disabledCollector.recordLatency("save", 50, true);

      expect(disabledCollector.getRecallStats().sampleCount).toBe(0);
      expect(disabledCollector.getMRRStats().queryCount).toBe(0);
      expect(disabledCollector.getLatencyStats().sampleCount).toBe(0);
    });

    it("should still return measurement objects when disabled", () => {
      const disabledCollector = new MetricsCollector({ enabled: false });

      const recall = disabledCollector.recordRecall("q", ["a"], ["a"], 0.8);
      expect(recall.query).toBe("q");

      const retrieval = disabledCollector.recordRetrieval("q", ["a"], "a");
      expect(retrieval.query).toBe("q");

      const latency = disabledCollector.recordLatency("save", 50, true);
      expect(latency.operation).toBe("save");
    });
  });

  describe("Reset", () => {
    it("should clear all measurements", () => {
      collector.recordRecall("q", ["a"], ["a"], 0.8);
      collector.recordRetrieval("q", ["a"], "a");
      collector.recordLatency("save", 50, true);

      collector.reset();

      expect(collector.getRecallStats().sampleCount).toBe(0);
      expect(collector.getMRRStats().queryCount).toBe(0);
      expect(collector.getLatencyStats().sampleCount).toBe(0);
      expect(collector.getAlerts().length).toBe(0);
    });
  });

  describe("Measurement Pruning", () => {
    it("should prune measurements beyond max", () => {
      const smallCollector = new MetricsCollector({ maxMeasurements: 5 });

      // Add 10 measurements
      for (let i = 0; i < 10; i++) {
        smallCollector.recordLatency("save", i * 10, true);
      }

      const stats = smallCollector.getLatencyStats();

      // Should only have last 5
      expect(stats.sampleCount).toBe(5);
      // Min should be 50 (the 6th measurement), not 0
      expect(stats.min).toBe(50);
    });
  });
});
