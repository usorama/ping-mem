/**
 * Tests for admin-schemas validation
 *
 * @module validation/__tests__/admin-schemas.test
 */

import { describe, it, expect } from "@jest/globals";
import {
  deleteProjectSchema,
  rotateKeySchema,
  deactivateKeySchema,
  setLLMConfigSchema,
} from "../admin-schemas.js";

describe("admin-schemas", () => {
  // ========================================================================
  // deleteProjectSchema
  // ========================================================================

  describe("deleteProjectSchema", () => {
    it("should accept valid projectDir", () => {
      const result = deleteProjectSchema.safeParse({ projectDir: "/path/to/project" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.projectDir).toBe("/path/to/project");
      }
    });

    it("should accept valid projectId", () => {
      const result = deleteProjectSchema.safeParse({
        projectId: "ping-mem-abc123def456",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.projectId).toBe("ping-mem-abc123def456");
      }
    });

    it("should reject empty projectDir", () => {
      const result = deleteProjectSchema.safeParse({ projectDir: "   " });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("projectDir cannot be empty");
      }
    });

    it("should reject invalid projectId format", () => {
      const result = deleteProjectSchema.safeParse({
        projectId: "invalid-format",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("must start with 'ping-mem-'");
      }
    });

    it("should require either projectDir or projectId", () => {
      const result = deleteProjectSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Either projectDir or projectId is required"
        );
      }
    });

    it("should reject both projectDir and projectId provided", () => {
      const result = deleteProjectSchema.safeParse({
        projectDir: "/path/to/project",
        projectId: "ping-mem-abc123",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Provide only one of projectDir or projectId"
        );
      }
    });

    it("should trim whitespace from projectDir", () => {
      const result = deleteProjectSchema.safeParse({ projectDir: "  /path/to/project  " });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.projectDir).toBe("/path/to/project");
      }
    });
  });

  // ========================================================================
  // rotateKeySchema
  // ========================================================================

  describe("rotateKeySchema", () => {
    it("should accept empty object (deactivateOld defaults to false)", () => {
      const result = rotateKeySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deactivateOld).toBe(false);
      }
    });

    it("should accept deactivateOld: true", () => {
      const result = rotateKeySchema.safeParse({ deactivateOld: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deactivateOld).toBe(true);
      }
    });

    it("should accept deactivateOld: false", () => {
      const result = rotateKeySchema.safeParse({ deactivateOld: false });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deactivateOld).toBe(false);
      }
    });

    it("should reject non-boolean deactivateOld", () => {
      const result = rotateKeySchema.safeParse({ deactivateOld: "true" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("Must be a boolean");
      }
    });

    it("should reject truthy number", () => {
      const result = rotateKeySchema.safeParse({ deactivateOld: 1 });
      expect(result.success).toBe(false);
    });

    it("should reject falsy number", () => {
      const result = rotateKeySchema.safeParse({ deactivateOld: 0 });
      expect(result.success).toBe(false);
    });
  });

  // ========================================================================
  // deactivateKeySchema
  // ========================================================================

  describe("deactivateKeySchema", () => {
    it("should accept valid UUID", () => {
      const result = deactivateKeySchema.safeParse({
        id: "550e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      }
    });

    it("should accept valid hex string", () => {
      const result = deactivateKeySchema.safeParse({
        id: "abc123-def456",
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty string", () => {
      const result = deactivateKeySchema.safeParse({ id: "" });
      expect(result.success).toBe(false);
    });

    it("should reject whitespace-only string", () => {
      const result = deactivateKeySchema.safeParse({ id: "   " });
      expect(result.success).toBe(false);
    });

    it("should reject string with invalid characters", () => {
      const result = deactivateKeySchema.safeParse({ id: "abc$123" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("valid UUID or hex string");
      }
    });

    it("should require id field", () => {
      const result = deactivateKeySchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  // ========================================================================
  // setLLMConfigSchema
  // ========================================================================

  describe("setLLMConfigSchema", () => {
    it("should accept valid config with all fields", () => {
      const result = setLLMConfigSchema.safeParse({
        provider: "OpenAI",
        apiKey: "sk-abc123",
        model: "gpt-4",
        baseUrl: "https://api.openai.com/v1",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.provider).toBe("OpenAI");
        expect(result.data.apiKey).toBe("sk-abc123");
        expect(result.data.model).toBe("gpt-4");
        expect(result.data.baseUrl).toBe("https://api.openai.com/v1");
      }
    });

    it("should accept valid config with only required fields", () => {
      const result = setLLMConfigSchema.safeParse({
        provider: "Anthropic",
        apiKey: "sk-ant-abc123",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.provider).toBe("Anthropic");
        expect(result.data.apiKey).toBe("sk-ant-abc123");
        expect(result.data.model).toBeUndefined();
        expect(result.data.baseUrl).toBeUndefined();
      }
    });

    it("should accept all supported providers", () => {
      const providers = [
        "OpenAI",
        "Anthropic",
        "OpenRouter",
        "zAI",
        "Gemini",
        "Mistral",
        "Groq",
        "Cohere",
        "Together",
        "Perplexity",
        "Azure OpenAI",
        "Bedrock",
        "DeepSeek",
        "xAI",
        "Fireworks",
        "Custom",
      ];

      for (const provider of providers) {
        const result = setLLMConfigSchema.safeParse({
          provider,
          apiKey: "test-key",
        });
        expect(result.success).toBe(true);
      }
    });

    it("should reject invalid provider", () => {
      const result = setLLMConfigSchema.safeParse({
        provider: "InvalidProvider",
        apiKey: "test-key",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("must be one of");
      }
    });

    it("should reject missing provider", () => {
      const result = setLLMConfigSchema.safeParse({
        apiKey: "test-key",
      });
      expect(result.success).toBe(false);
    });

    it("should reject missing apiKey", () => {
      const result = setLLMConfigSchema.safeParse({
        provider: "OpenAI",
      });
      expect(result.success).toBe(false);
    });

    it("should reject empty apiKey", () => {
      const result = setLLMConfigSchema.safeParse({
        provider: "OpenAI",
        apiKey: "",
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid baseUrl", () => {
      const result = setLLMConfigSchema.safeParse({
        provider: "OpenAI",
        apiKey: "test-key",
        baseUrl: "not-a-url",
      });
      expect(result.success).toBe(false);
    });

    it("should accept empty string for baseUrl", () => {
      const result = setLLMConfigSchema.safeParse({
        provider: "OpenAI",
        apiKey: "test-key",
        baseUrl: "",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.baseUrl).toBe("");
      }
    });

    it("should trim whitespace from apiKey", () => {
      const result = setLLMConfigSchema.safeParse({
        provider: "OpenAI",
        apiKey: "  sk-abc123  ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.apiKey).toBe("sk-abc123");
      }
    });

    it("should trim whitespace from model", () => {
      const result = setLLMConfigSchema.safeParse({
        provider: "OpenAI",
        apiKey: "test-key",
        model: "  gpt-4  ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.model).toBe("gpt-4");
      }
    });
  });
});
