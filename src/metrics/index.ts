/**
 * Metrics module exports
 *
 * @module metrics
 */

export { MetricsCollector, createMetricsCollector } from "./MetricsCollector.js";

export type {
  ISOTimestamp,
  TimestampedValue,
  WindowConfig,
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
  MetricEvent,
  RecallMeasuredEvent,
  RetrievalMeasuredEvent,
  LatencyMeasuredEvent,
  AlertTriggeredEvent,
  MetricEventType,
} from "./types.js";
