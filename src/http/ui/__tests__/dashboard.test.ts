import { describe, test, expect, beforeEach } from "bun:test";
import { createInMemoryEventStore, type EventStore } from "../../../storage/EventStore.js";
import { SessionManager } from "../../../session/SessionManager.js";
import { renderLayout } from "../layout.js";
import { statCard, eventTypeBadge, badge } from "../components.js";

describe("Dashboard UI", () => {
  let eventStore: EventStore;
  let sessionManager: SessionManager;

  beforeEach(() => {
    eventStore = createInMemoryEventStore();
    sessionManager = new SessionManager({ eventStore });
  });

  describe("renderLayout", () => {
    test("returns valid HTML with DOCTYPE", () => {
      const html = renderLayout({
        title: "Test",
        content: "<p>Hello</p>",
        activeRoute: "dashboard",
      });
      expect(html).toStartWith("<!DOCTYPE html>");
      expect(html).toContain("<title>Test - ping-mem</title>");
      expect(html).toContain("<p>Hello</p>");
    });

    test("includes HTMX script tag", () => {
      const html = renderLayout({
        title: "Test",
        content: "",
        activeRoute: "dashboard",
      });
      expect(html).toContain("/static/htmx.min.js");
    });

    test("includes CSS link", () => {
      const html = renderLayout({
        title: "Test",
        content: "",
        activeRoute: "dashboard",
      });
      expect(html).toContain("/static/styles.css");
    });

    test("marks active route in sidebar", () => {
      const html = renderLayout({
        title: "Test",
        content: "",
        activeRoute: "memories",
      });
      expect(html).toContain('href="/ui/memories" class="active"');
      expect(html).not.toContain('href="/ui" class="active"');
    });

    test("includes theme toggle script", () => {
      const html = renderLayout({
        title: "Test",
        content: "",
        activeRoute: "dashboard",
      });
      expect(html).toContain("ping-mem-theme");
      expect(html).toContain("toggleTheme");
    });

    test("includes sidebar navigation with all routes", () => {
      const html = renderLayout({
        title: "Test",
        content: "",
        activeRoute: "dashboard",
      });
      expect(html).toContain('href="/ui"');
      expect(html).toContain('href="/ui/memories"');
      expect(html).toContain('href="/ui/diagnostics"');
      expect(html).toContain('href="/ui/ingestion"');
    });

    test("escapes title HTML", () => {
      const html = renderLayout({
        title: '<script>alert("xss")</script>',
        content: "",
        activeRoute: "dashboard",
      });
      expect(html).not.toContain("<script>alert");
      expect(html).toContain("&lt;script&gt;");
    });
  });

  describe("components", () => {
    test("statCard renders label and value", () => {
      const html = statCard("Memories", 42, "across all sessions");
      expect(html).toContain("Memories");
      expect(html).toContain("42");
      expect(html).toContain("across all sessions");
    });

    test("badge renders with correct class", () => {
      const html = badge("test", "success");
      expect(html).toContain("badge-success");
      expect(html).toContain("test");
    });

    test("eventTypeBadge renders event types", () => {
      const html = eventTypeBadge("MEMORY_SAVED");
      expect(html).toContain("badge-info");
      expect(html).toContain("MEMORY SAVED");
    });
  });

  describe("EventStore.getRecentEvents", () => {
    test("returns empty array when no events", () => {
      const events = eventStore.getRecentEvents(10);
      expect(events).toEqual([]);
    });

    test("returns events ordered by timestamp DESC", async () => {
      // Create events via session start
      const session = await sessionManager.startSession({ name: "test-session" });

      const events = eventStore.getRecentEvents(10);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].eventType).toBe("SESSION_STARTED");
    });

    test("respects limit parameter", async () => {
      await sessionManager.startSession({ name: "s1" });
      await sessionManager.startSession({ name: "s2" });
      await sessionManager.startSession({ name: "s3" });

      const events = eventStore.getRecentEvents(2);
      expect(events.length).toBe(2);
    });
  });
});
