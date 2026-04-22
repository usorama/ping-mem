/**
 * IngestionQueue: Zero-dependency serial ingestion queue using Promise chain.
 *
 * Ensures at most one ingestion runs at a time. Tracks run history for
 * status polling via REST API. No external dependencies (replaces p-queue).
 */

import * as crypto from "crypto";
import type { IngestionService, IngestProjectOptions, IngestProjectResult } from "./IngestionService.js";
import { sanitizeHealthError } from "../observability/health-probes.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("IngestionQueue");

export type IngestionRunStatus =
  | "queued"
  | "scanning"
  | "chunking"
  | "persisting_neo4j"
  | "indexing_qdrant"
  | "completed"
  | "failed";

export interface IngestionRun {
  runId: string;
  projectDir: string;
  projectId: string | null;
  status: IngestionRunStatus;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  originalError?: Error;
  progress: { phase: string; current: number; total: number } | null;
  result: IngestProjectResult | null;
}

export interface QueueStatus {
  pending: number;
  active: number;
  runs: IngestionRun[];
}

export interface IngestionQueueHooks {
  onCompleted?: (
    options: IngestProjectOptions,
    result: IngestProjectResult | null
  ) => Promise<void> | void;
}

export class IngestionQueue {
  private chain: Promise<void> = Promise.resolve();
  private readonly runs = new Map<string, IngestionRun>();
  private activeCount = 0;
  private pendingCount = 0;
  private readonly maxRunHistory: number;
  private readonly maxQueueDepth: number;

  constructor(
    private readonly ingestionService: IngestionService,
    options?: { maxRunHistory?: number; maxQueueDepth?: number } & IngestionQueueHooks
  ) {
    this.maxRunHistory = options?.maxRunHistory ?? 50;
    this.maxQueueDepth = options?.maxQueueDepth ?? 10;
    this.onCompleted = options?.onCompleted;
  }

  private readonly onCompleted?: IngestionQueueHooks["onCompleted"];

  async enqueue(options: IngestProjectOptions): Promise<string> {
    if (this.pendingCount >= this.maxQueueDepth) {
      throw new Error("Ingestion queue full — try again later");
    }

    const runId = crypto.randomUUID();
    const run: IngestionRun = {
      runId,
      projectDir: options.projectDir,
      projectId: null,
      status: "queued",
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      progress: null,
      result: null,
    };
    this.runs.set(runId, run);
    this.pendingCount++;
    this.pruneHistory();

    this.chain = this.chain.then(async () => {
      this.pendingCount--;
      this.activeCount++;
      try {
        run.status = "scanning";
        log.info(`Starting ingestion run ${runId}`, { projectDir: options.projectDir });

        const result = await this.ingestionService.ingestProject(options);

        if (this.onCompleted) {
          await this.onCompleted(options, result);
        }

        run.status = "completed";
        run.result = result;
        run.projectId = result?.projectId ?? null;
        log.info(`Ingestion run ${runId} completed`, {
          projectId: run.projectId,
          filesIndexed: result?.filesIndexed ?? 0,
        });
      } catch (err) {
        run.status = "failed";
        run.error = sanitizeHealthError(err instanceof Error ? err : new Error(String(err)));
        log.error(`Ingestion run ${runId} failed`, { error: run.error });
      } finally {
        run.completedAt = new Date().toISOString();
        this.activeCount--;
      }
    });

    return runId;
  }

  async enqueueAndWait(options: IngestProjectOptions): Promise<IngestProjectResult | null> {
    if (this.pendingCount >= this.maxQueueDepth) {
      throw new Error("Ingestion queue full — try again later");
    }

    const runId = crypto.randomUUID();
    const run: IngestionRun = {
      runId,
      projectDir: options.projectDir,
      projectId: null,
      status: "queued",
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      progress: null,
      result: null,
    };
    this.runs.set(runId, run);
    this.pendingCount++;
    this.pruneHistory();

    // Create a per-run promise that resolves when THIS run completes
    const done = new Promise<void>((resolve) => {
      this.chain = this.chain.then(async () => {
        this.pendingCount--;
        this.activeCount++;
        try {
          run.status = "scanning";
          log.info(`Starting ingestion run ${runId}`, { projectDir: options.projectDir });
          const result = await this.ingestionService.ingestProject(options);
          if (this.onCompleted) {
            await this.onCompleted(options, result);
          }
          run.status = "completed";
          run.result = result;
          run.projectId = result?.projectId ?? null;
          log.info(`Ingestion run ${runId} completed`, {
            projectId: run.projectId,
            filesIndexed: result?.filesIndexed ?? 0,
          });
        } catch (err) {
          run.status = "failed";
          run.originalError = err instanceof Error ? err : new Error(String(err));
          run.error = sanitizeHealthError(run.originalError);
          log.error(`Ingestion run ${runId} failed`, { error: run.error });
        } finally {
          run.completedAt = new Date().toISOString();
          this.activeCount--;
          resolve();
        }
      });
    });

    await done;
    if (run.status === "failed") {
      throw new Error(run.error ?? "Ingestion failed", { cause: run.originalError });
    }
    return run.result;
  }

  getRun(runId: string): IngestionRun | undefined {
    return this.runs.get(runId);
  }

  getQueueStatus(): QueueStatus {
    return {
      pending: this.pendingCount,
      active: this.activeCount,
      runs: Array.from(this.runs.values()).reverse(),
    };
  }

  private pruneHistory(): void {
    const completed = [...this.runs.entries()]
      .filter(([, r]) => r.status === "completed" || r.status === "failed")
      .sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt));
    while (completed.length > this.maxRunHistory) {
      const entry = completed.shift();
      if (entry) this.runs.delete(entry[0]);
    }
  }
}
