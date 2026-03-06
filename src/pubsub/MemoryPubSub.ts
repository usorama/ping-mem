/**
 * Scope-aware in-process event bus for memory changes.
 *
 * Publishes memory save/update/delete events and delivers them to
 * subscribers respecting agent scope, channel, and category filters.
 *
 * @module pubsub/MemoryPubSub
 */

import { EventEmitter } from "node:events";
import type { AgentMemoryScope } from "../types/index.js";

// ============================================================================
// Types
// ============================================================================

export interface MemoryEvent {
  type: "save" | "update" | "delete";
  key: string;
  category?: string;
  channel?: string;
  agentId?: string;
  agentScope?: AgentMemoryScope;
  timestamp: string;
  /** Included for save/update, omitted for delete */
  value?: string;
}

export type MemoryEventHandler = (event: MemoryEvent) => void;

export interface SubscriptionOptions {
  /** Filter by channel */
  channel?: string;
  /** Filter by category */
  category?: string;
  /** Subscriber's agent ID (for scope filtering) */
  agentId?: string;
  /** Subscriber's role (for scope filtering) */
  agentRole?: string;
}

// ============================================================================
// MemoryPubSub
// ============================================================================

export class MemoryPubSub {
  private emitter: EventEmitter;
  private subscriptions: Map<string, { handler: MemoryEventHandler; options: SubscriptionOptions }>;
  private nextId: number = 0;
  private maxSubscribers: number;

  constructor(maxSubscribers: number = 50) {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(maxSubscribers + 10);
    this.subscriptions = new Map();
    this.maxSubscribers = maxSubscribers;
  }

  /**
   * Subscribe to memory events. Returns subscription ID.
   */
  subscribe(options: SubscriptionOptions, handler: MemoryEventHandler): string {
    if (this.subscriptions.size >= this.maxSubscribers) {
      throw new Error(`Maximum subscribers (${this.maxSubscribers}) reached`);
    }
    const id = `sub_${++this.nextId}`;
    const wrappedHandler: MemoryEventHandler = (event) => {
      // Scope filtering: private memories only delivered to owning agent
      if (event.agentScope === "private" && event.agentId !== options.agentId) return;

      // Strip value from role/shared scope events for non-owner subscribers
      let deliveredEvent = event;
      if (event.agentScope && event.agentScope !== "public" && event.agentId !== options.agentId) {
        const { value, ...rest } = event;
        deliveredEvent = rest as MemoryEvent;
      }

      // Channel filter
      if (options.channel && deliveredEvent.channel !== options.channel) return;

      // Category filter
      if (options.category && deliveredEvent.category !== options.category) return;

      try {
        handler(deliveredEvent);
      } catch (err) {
        console.error("[MemoryPubSub] Subscriber handler threw:", err instanceof Error ? err.message : String(err));
      }
    };
    this.subscriptions.set(id, { handler: wrappedHandler, options });
    this.emitter.on("memory", wrappedHandler);
    return id;
  }

  /**
   * Unsubscribe by subscription ID.
   */
  unsubscribe(subscriptionId: string): boolean {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) return false;
    this.emitter.off("memory", sub.handler);
    this.subscriptions.delete(subscriptionId);
    return true;
  }

  /**
   * Publish a memory event to all matching subscribers.
   */
  publish(event: MemoryEvent): void {
    this.emitter.emit("memory", event);
  }

  /**
   * Get active subscription count.
   */
  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Clean up all subscriptions.
   */
  destroy(): void {
    const ids = [...this.subscriptions.keys()];
    for (const id of ids) {
      this.unsubscribe(id);
    }
  }
}
