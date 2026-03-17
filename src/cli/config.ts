/**
 * CLI configuration management
 *
 * Reads/writes config from ~/.ping-mem/config.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface PingMemConfig {
  serverUrl: string;
  defaultProject: string | null;
  outputFormat: "json" | "table" | "quiet";
}

const DEFAULT_CONFIG: PingMemConfig = {
  serverUrl: "http://localhost:3000",
  defaultProject: null,
  outputFormat: "table",
};

export function getConfigDir(): string {
  return path.join(os.homedir(), ".ping-mem");
}

function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

export function loadConfig(): PingMemConfig {
  const configPath = getConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PingMemConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Partial<PingMemConfig>): void {
  const configDir = getConfigDir();
  fs.mkdirSync(configDir, { recursive: true });
  const existing = loadConfig();
  const merged = { ...existing, ...config };
  fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2) + "\n");
}
