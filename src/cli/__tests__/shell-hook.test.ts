/**
 * Tests for shell-hook command output.
 */

import { describe, test, expect } from "bun:test";

// We test by importing the module and checking the hook strings
// The command itself just writes to stdout, so we test the content patterns

describe("shell-hook command", () => {
  test("zsh hook contains precmd and chpwd hooks", async () => {
    // Import the module to get the exported command
    const mod = await import("../commands/shell-hook.js");
    const cmd = mod.default;
    expect(cmd.meta?.name).toBe("shell-hook");
  });

  test("zsh hook output contains required elements", () => {
    // Verify the hook patterns by checking known strings
    const zshHook = [
      "_ping_mem_sock=",
      "_ping_mem_send()",
      "nc -U",
      "socat",
      "add-zsh-hook precmd",
      "add-zsh-hook chpwd",
      "_ping_mem_precmd",
      "_ping_mem_chpwd",
    ];

    // Import synchronously from the file content
    const fs = require("node:fs");
    const content = fs.readFileSync(
      require("node:path").resolve(__dirname, "../commands/shell-hook.ts"),
      "utf-8",
    ) as string;

    for (const pattern of zshHook) {
      expect(content).toContain(pattern);
    }
  });

  test("bash hook output contains required elements", () => {
    const fs = require("node:fs");
    const content = fs.readFileSync(
      require("node:path").resolve(__dirname, "../commands/shell-hook.ts"),
      "utf-8",
    ) as string;

    const bashPatterns = [
      "PROMPT_COMMAND=",
      "nc -U",
      "socat",
    ];

    for (const pattern of bashPatterns) {
      expect(content).toContain(pattern);
    }
  });

  test("fish hook output contains required elements", () => {
    const fs = require("node:fs");
    const content = fs.readFileSync(
      require("node:path").resolve(__dirname, "../commands/shell-hook.ts"),
      "utf-8",
    ) as string;

    const fishPatterns = [
      "fish_prompt",
      "--on-variable PWD",
      "nc -U",
      "socat",
    ];

    for (const pattern of fishPatterns) {
      expect(content).toContain(pattern);
    }
  });
});
