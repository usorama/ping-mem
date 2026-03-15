/**
 * IngestionEventEmitter: Typed event emitter for ingestion progress/status.
 *
 * Separate from MemoryPubSub (EVAL G-05 fix) to avoid coupling
 * ingestion events with memory change events. SSE endpoints subscribe
 * to this emitter to push ingestion progress to clients.
 */

import { EventEmitter } from "events";
import type { IngestionEventData } from "../types/index.js";

export interface IngestionEvent extends IngestionEventData {
  eventType: string;
}

export class IngestionEventEmitter extends EventEmitter {
  emitIngestion(event: IngestionEvent): void {
    this.emit("ingestion", event);
  }

  onIngestion(handler: (event: IngestionEvent) => void): void {
    this.on("ingestion", handler);
  }

  offIngestion(handler: (event: IngestionEvent) => void): void {
    this.off("ingestion", handler);
  }
}
