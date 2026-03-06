/**
 * Tests for MemoryPubSub
 *
 * @module pubsub/__tests__/MemoryPubSub.test
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryPubSub } from "../MemoryPubSub.js";
import type { MemoryEvent, MemoryEventHandler } from "../MemoryPubSub.js";

describe("MemoryPubSub", () => {
  let pubsub: MemoryPubSub;

  beforeEach(() => {
    pubsub = new MemoryPubSub();
  });

  afterEach(() => {
    pubsub.destroy();
  });

  describe("subscribe", () => {
    it("should return a subscription id", () => {
      const id = pubsub.subscribe({}, () => {});
      expect(id).toBeDefined();
      expect(typeof id).toBe("string");
      expect(id.startsWith("sub_")).toBe(true);
    });

    it("should increment subscriber count", () => {
      expect(pubsub.subscriberCount).toBe(0);
      pubsub.subscribe({}, () => {});
      expect(pubsub.subscriberCount).toBe(1);
      pubsub.subscribe({}, () => {});
      expect(pubsub.subscriberCount).toBe(2);
    });
  });

  describe("publish", () => {
    it("should deliver events to subscribers", () => {
      const received: MemoryEvent[] = [];
      pubsub.subscribe({}, (event) => {
        received.push(event);
      });

      const event: MemoryEvent = {
        type: "save",
        key: "test-key",
        timestamp: new Date().toISOString(),
        value: "test-value",
      };
      pubsub.publish(event);

      expect(received).toHaveLength(1);
      expect(received[0].key).toBe("test-key");
      expect(received[0].type).toBe("save");
    });

    it("should deliver to multiple subscribers", () => {
      let count = 0;
      pubsub.subscribe({}, () => { count++; });
      pubsub.subscribe({}, () => { count++; });

      pubsub.publish({
        type: "save",
        key: "k",
        timestamp: new Date().toISOString(),
      });

      expect(count).toBe(2);
    });
  });

  describe("channel filter", () => {
    it("should only deliver events matching the subscriber's channel", () => {
      const receivedA: MemoryEvent[] = [];
      const receivedB: MemoryEvent[] = [];

      pubsub.subscribe({ channel: "alpha" }, (e) => receivedA.push(e));
      pubsub.subscribe({ channel: "beta" }, (e) => receivedB.push(e));

      pubsub.publish({
        type: "save",
        key: "k1",
        channel: "alpha",
        timestamp: new Date().toISOString(),
      });

      pubsub.publish({
        type: "save",
        key: "k2",
        channel: "beta",
        timestamp: new Date().toISOString(),
      });

      expect(receivedA).toHaveLength(1);
      expect(receivedA[0].key).toBe("k1");
      expect(receivedB).toHaveLength(1);
      expect(receivedB[0].key).toBe("k2");
    });

    it("should not deliver events with mismatched channel", () => {
      const received: MemoryEvent[] = [];
      pubsub.subscribe({ channel: "alpha" }, (e) => received.push(e));

      pubsub.publish({
        type: "save",
        key: "k1",
        channel: "beta",
        timestamp: new Date().toISOString(),
      });

      expect(received).toHaveLength(0);
    });
  });

  describe("category filter", () => {
    it("should only deliver events matching the subscriber's category", () => {
      const received: MemoryEvent[] = [];
      pubsub.subscribe({ category: "decision" }, (e) => received.push(e));

      pubsub.publish({
        type: "save",
        key: "k1",
        category: "decision",
        timestamp: new Date().toISOString(),
      });

      pubsub.publish({
        type: "save",
        key: "k2",
        category: "note",
        timestamp: new Date().toISOString(),
      });

      expect(received).toHaveLength(1);
      expect(received[0].key).toBe("k1");
    });
  });

  describe("scope filtering", () => {
    it("should deliver private events only to the owning agent", () => {
      const receivedOwner: MemoryEvent[] = [];
      const receivedOther: MemoryEvent[] = [];

      pubsub.subscribe({ agentId: "agent-1" }, (e) => receivedOwner.push(e));
      pubsub.subscribe({ agentId: "agent-2" }, (e) => receivedOther.push(e));

      pubsub.publish({
        type: "save",
        key: "private-key",
        agentId: "agent-1",
        agentScope: "private",
        timestamp: new Date().toISOString(),
      });

      expect(receivedOwner).toHaveLength(1);
      expect(receivedOther).toHaveLength(0);
    });

    it("should deliver public events to all agents", () => {
      const receivedA: MemoryEvent[] = [];
      const receivedB: MemoryEvent[] = [];

      pubsub.subscribe({ agentId: "agent-1" }, (e) => receivedA.push(e));
      pubsub.subscribe({ agentId: "agent-2" }, (e) => receivedB.push(e));

      pubsub.publish({
        type: "save",
        key: "public-key",
        agentId: "agent-1",
        agentScope: "public",
        timestamp: new Date().toISOString(),
      });

      expect(receivedA).toHaveLength(1);
      expect(receivedB).toHaveLength(1);
    });
  });

  describe("unsubscribe", () => {
    it("should stop delivery after unsubscribe", () => {
      const received: MemoryEvent[] = [];
      const id = pubsub.subscribe({}, (e) => received.push(e));

      pubsub.publish({
        type: "save",
        key: "k1",
        timestamp: new Date().toISOString(),
      });

      expect(received).toHaveLength(1);

      const result = pubsub.unsubscribe(id);
      expect(result).toBe(true);

      pubsub.publish({
        type: "save",
        key: "k2",
        timestamp: new Date().toISOString(),
      });

      // Should still be 1 since we unsubscribed before second publish
      expect(received).toHaveLength(1);
    });

    it("should return false for unknown subscription id", () => {
      const result = pubsub.unsubscribe("sub_nonexistent");
      expect(result).toBe(false);
    });

    it("should decrement subscriber count", () => {
      const id = pubsub.subscribe({}, () => {});
      expect(pubsub.subscriberCount).toBe(1);

      pubsub.unsubscribe(id);
      expect(pubsub.subscriberCount).toBe(0);
    });
  });

  describe("max subscriber limit", () => {
    it("should enforce max subscriber limit", () => {
      const smallPubsub = new MemoryPubSub(3);

      smallPubsub.subscribe({}, () => {});
      smallPubsub.subscribe({}, () => {});
      smallPubsub.subscribe({}, () => {});

      expect(() => {
        smallPubsub.subscribe({}, () => {});
      }).toThrow(/Maximum subscribers.*reached/);

      smallPubsub.destroy();
    });
  });

  describe("destroy", () => {
    it("should clean up all subscriptions", () => {
      pubsub.subscribe({}, () => {});
      pubsub.subscribe({}, () => {});
      pubsub.subscribe({}, () => {});

      expect(pubsub.subscriberCount).toBe(3);

      pubsub.destroy();

      expect(pubsub.subscriberCount).toBe(0);
    });

    it("should stop all event delivery after destroy", () => {
      const received: MemoryEvent[] = [];
      pubsub.subscribe({}, (e) => received.push(e));

      pubsub.destroy();

      pubsub.publish({
        type: "save",
        key: "k1",
        timestamp: new Date().toISOString(),
      });

      expect(received).toHaveLength(0);
    });
  });
});
