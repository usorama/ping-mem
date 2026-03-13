/**
 * Tests for AdminStore
 *
 * @module admin/__tests__/AdminStore.test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AdminStore } from "../AdminStore.js";
import type { AdminApiKeyInfo, ProjectRecord } from "../AdminStore.js";

describe("AdminStore", () => {
  let store: AdminStore;

  beforeEach(() => {
    // Set secret key for encryption tests
    process.env.PING_MEM_SECRET_KEY = "test-secret-key-for-admin-store-tests";
    store = new AdminStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
    delete process.env.PING_MEM_SECRET_KEY;
  });

  describe("Schema Initialization", () => {
    test("should create in-memory database without errors", () => {
      // The store was already created in beforeEach — verify it works
      const keys = store.listApiKeys();
      expect(keys).toEqual([]);
    });

    test("should create tables on initialization", () => {
      // Verify tables exist by performing operations on each one
      const keys = store.listApiKeys();
      expect(Array.isArray(keys)).toBe(true);

      const projects = store.listProjects();
      expect(Array.isArray(projects)).toBe(true);

      const config = store.getLLMConfig();
      expect(config).toBeNull();
    });
  });

  describe("Seed API Key", () => {
    test("should seed an API key when no keys exist", () => {
      store.ensureSeedApiKey("seed-key-12345678");
      const keys = store.listApiKeys();
      expect(keys.length).toBe(1);
      expect(keys[0].active).toBe(true);
      expect(keys[0].last4).toBe("5678");
    });

    test("should be idempotent — not create duplicate when keys already exist", () => {
      store.ensureSeedApiKey("seed-key-12345678");
      store.ensureSeedApiKey("different-key-abcdefgh");
      const keys = store.listApiKeys();
      expect(keys.length).toBe(1);
      // First seed key should remain
      expect(keys[0].last4).toBe("5678");
    });
  });

  describe("API Key Create / List / Validate / Deactivate", () => {
    test("should create a new API key and return raw key + info", () => {
      const { key, info } = store.createApiKey();
      expect(key).toBeTruthy();
      expect(key.length).toBe(64); // 32 random bytes hex-encoded
      expect(info.id).toBeTruthy();
      expect(info.last4).toBe(key.slice(-4));
      expect(info.active).toBe(true);
      expect(info.createdAt).toBeTruthy();
    });

    test("should list all API keys", () => {
      store.createApiKey();
      store.createApiKey();
      const keys = store.listApiKeys();
      expect(keys.length).toBe(2);
      for (const k of keys) {
        expect(k.active).toBe(true);
      }
    });

    test("should validate a correct API key", () => {
      const { key } = store.createApiKey();
      expect(store.isApiKeyValid(key)).toBe(true);
    });

    test("should reject an incorrect API key", () => {
      store.createApiKey();
      expect(store.isApiKeyValid("wrong-key")).toBe(false);
    });

    test("should deactivate a specific API key", () => {
      const { key, info } = store.createApiKey();
      store.deactivateApiKey(info.id);

      // Key should no longer validate
      expect(store.isApiKeyValid(key)).toBe(false);

      // Key should still appear in list but be inactive
      const keys = store.listApiKeys();
      const deactivated = keys.find((k: AdminApiKeyInfo) => k.id === info.id);
      expect(deactivated).toBeTruthy();
      expect(deactivated!.active).toBe(false);
    });

    test("should deactivate all old keys when creating with deactivateOld option", () => {
      const { key: key1 } = store.createApiKey();
      const { key: key2 } = store.createApiKey();
      const { key: key3 } = store.createApiKey({ deactivateOld: true });

      expect(store.isApiKeyValid(key1)).toBe(false);
      expect(store.isApiKeyValid(key2)).toBe(false);
      expect(store.isApiKeyValid(key3)).toBe(true);
    });

    test("hasAnyActiveKey returns true when keys exist", () => {
      expect(store.hasAnyActiveKey()).toBe(false);
      store.createApiKey();
      expect(store.hasAnyActiveKey()).toBe(true);
    });

    test("hasAnyActiveKey returns false when all keys are deactivated", () => {
      const { info } = store.createApiKey();
      expect(store.hasAnyActiveKey()).toBe(true);
      store.deactivateApiKey(info.id);
      expect(store.hasAnyActiveKey()).toBe(false);
    });
  });

  describe("Project CRUD", () => {
    test("should upsert and list projects", () => {
      const project: ProjectRecord = {
        projectId: "proj-123",
        projectDir: "/path/to/project",
        treeHash: "abc123",
        lastIngestedAt: new Date().toISOString(),
      };
      store.upsertProject(project);

      const projects = store.listProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].projectId).toBe("proj-123");
      expect(projects[0].projectDir).toBe("/path/to/project");
      expect(projects[0].treeHash).toBe("abc123");
    });

    test("should update existing project on conflict", () => {
      store.upsertProject({
        projectId: "proj-123",
        projectDir: "/path/to/project",
        treeHash: "hash-v1",
      });
      store.upsertProject({
        projectId: "proj-123",
        projectDir: "/path/to/project",
        treeHash: "hash-v2",
        lastIngestedAt: new Date().toISOString(),
      });

      const projects = store.listProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].treeHash).toBe("hash-v2");
    });

    test("should find project by directory", () => {
      store.upsertProject({
        projectId: "proj-456",
        projectDir: "/find/by/dir",
      });
      const found = store.findProjectByDir("/find/by/dir");
      expect(found).not.toBeNull();
      expect(found!.projectId).toBe("proj-456");
    });

    test("should return null for non-existent project directory", () => {
      const found = store.findProjectByDir("/nonexistent");
      expect(found).toBeNull();
    });

    test("should delete project", () => {
      store.upsertProject({
        projectId: "proj-del",
        projectDir: "/delete/me",
      });
      store.deleteProject("proj-del");
      const projects = store.listProjects();
      expect(projects.length).toBe(0);
    });
  });

  describe("LLM Config Encrypt / Decrypt", () => {
    test("should set and get LLM config with encryption round-trip", () => {
      const info = store.setLLMConfig({
        provider: "openai",
        apiKey: "sk-test-key-1234567890",
        model: "gpt-4",
        baseUrl: "https://api.openai.com",
      });

      expect(info.provider).toBe("openai");
      expect(info.model).toBe("gpt-4");
      expect(info.baseUrl).toBe("https://api.openai.com");
      expect(info.hasApiKey).toBe(true);
    });

    test("should retrieve encrypted API key and decrypt correctly", () => {
      store.setLLMConfig({
        provider: "anthropic",
        apiKey: "my-secret-api-key",
      });

      const decryptedKey = store.getLLMApiKey();
      expect(decryptedKey).toBe("my-secret-api-key");
    });

    test("should return null when no LLM config exists", () => {
      expect(store.getLLMConfig()).toBeNull();
      expect(store.getLLMApiKey()).toBeNull();
    });

    test("should clear LLM config", () => {
      store.setLLMConfig({
        provider: "openai",
        apiKey: "key-to-clear",
      });
      store.clearLLMConfig();

      expect(store.getLLMConfig()).toBeNull();
      expect(store.getLLMApiKey()).toBeNull();
    });

    test("should overwrite LLM config on second set", () => {
      store.setLLMConfig({
        provider: "openai",
        apiKey: "first-key",
        model: "gpt-3.5",
      });
      store.setLLMConfig({
        provider: "anthropic",
        apiKey: "second-key",
        model: "claude-3",
      });

      const config = store.getLLMConfig();
      expect(config!.provider).toBe("anthropic");
      expect(config!.model).toBe("claude-3");

      const key = store.getLLMApiKey();
      expect(key).toBe("second-key");
    });
  });

  describe("close()", () => {
    test("should close the database without error", () => {
      // Create a fresh store just for this test
      const tempStore = new AdminStore({ dbPath: ":memory:" });
      tempStore.createApiKey();
      expect(() => tempStore.close()).not.toThrow();
    });

    test("should be idempotent (double close does not throw)", () => {
      const tempStore = new AdminStore({ dbPath: ":memory:" });
      tempStore.close();
      expect(() => tempStore.close()).not.toThrow();
    });

    test("double close does not corrupt state before close", () => {
      // Verify the close guard protects against double-free on the DB handle.
      // bun:sqlite is lenient after close (prepared statements still work),
      // so we verify the important property: data is accessible before close,
      // and close itself doesn't throw or corrupt.
      const tempStore = new AdminStore({ dbPath: ":memory:" });
      tempStore.createApiKey();
      expect(tempStore.listApiKeys().length).toBe(1);
      tempStore.close();
      expect(() => tempStore.close()).not.toThrow();
    });
  });
});
