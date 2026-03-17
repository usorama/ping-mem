/**
 * Auth commands: login, logout
 */

import { defineCommand } from "citty";
import { saveAuth, clearAuth, loadAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import { printOutput, resolveFormat } from "../output.js";
import { outputArgs, serverArgs } from "../shared.js";

const login = defineCommand({
  meta: { name: "login", description: "Store API key for authentication" },
  args: {
    key: { type: "positional", description: "API key", required: true },
    ...outputArgs,
    ...serverArgs,
  },
  async run({ args }) {
    const config = loadConfig();
    const serverUrl = args.server ?? config.serverUrl;
    saveAuth({
      apiKey: args.key,
      serverUrl,
      createdAt: new Date().toISOString(),
    });
    printOutput({ message: "API key saved", serverUrl }, resolveFormat(args));
  },
});

const logout = defineCommand({
  meta: { name: "logout", description: "Clear stored API key" },
  args: {
    ...outputArgs,
  },
  async run({ args }) {
    clearAuth();
    printOutput({ message: "API key removed" }, resolveFormat(args));
  },
});

const whoami = defineCommand({
  meta: { name: "whoami", description: "Show current auth status" },
  args: {
    ...outputArgs,
  },
  async run({ args }) {
    const auth = loadAuth();
    if (!auth) {
      printOutput({ authenticated: false, message: "Not logged in" }, resolveFormat(args));
    } else {
      printOutput({
        authenticated: true,
        serverUrl: auth.serverUrl,
        createdAt: auth.createdAt,
        keyPrefix: auth.apiKey.slice(0, 8) + "...",
      }, resolveFormat(args));
    }
  },
});

export default defineCommand({
  meta: { name: "auth", description: "Authentication management" },
  subCommands: {
    login,
    logout,
    whoami,
  },
});
