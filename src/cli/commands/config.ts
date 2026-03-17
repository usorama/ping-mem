/**
 * Config commands: get, set, show
 */

import { defineCommand } from "citty";
import { loadConfig, saveConfig, type PingMemConfig } from "../config.js";
import { printOutput, resolveFormat } from "../output.js";
import { outputArgs } from "../shared.js";

const VALID_KEYS = new Set<keyof PingMemConfig>(["serverUrl", "defaultProject", "outputFormat"]);

const get = defineCommand({
  meta: { name: "get", description: "Get a config value" },
  args: {
    key: { type: "positional", description: "Config key (serverUrl, defaultProject, outputFormat)", required: true },
    ...outputArgs,
  },
  async run({ args }) {
    const config = loadConfig();
    const key = args.key as keyof PingMemConfig;
    if (!VALID_KEYS.has(key)) {
      console.error(`Unknown config key: ${args.key}. Valid: ${[...VALID_KEYS].join(", ")}`);
      process.exit(1);
    }
    printOutput({ key, value: config[key] }, resolveFormat(args));
  },
});

const set = defineCommand({
  meta: { name: "set", description: "Set a config value" },
  args: {
    key: { type: "positional", description: "Config key", required: true },
    value: { type: "positional", description: "Config value", required: true },
    ...outputArgs,
  },
  async run({ args }) {
    const key = args.key as keyof PingMemConfig;
    if (!VALID_KEYS.has(key)) {
      console.error(`Unknown config key: ${args.key}. Valid: ${[...VALID_KEYS].join(", ")}`);
      process.exit(1);
    }
    if (key === "outputFormat" && !["json", "table", "quiet"].includes(args.value)) {
      console.error(`Invalid output format: ${args.value}. Valid: json, table, quiet`);
      process.exit(1);
    }
    saveConfig({ [key]: args.value });
    printOutput({ key, value: args.value, message: "Config updated" }, resolveFormat(args));
  },
});

const show = defineCommand({
  meta: { name: "show", description: "Show all config values" },
  args: {
    ...outputArgs,
  },
  async run({ args }) {
    const config = loadConfig();
    printOutput(config, resolveFormat(args));
  },
});

export default defineCommand({
  meta: { name: "config", description: "Configuration management" },
  subCommands: {
    get,
    set,
    show,
  },
});
