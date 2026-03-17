/**
 * CLI authentication — stores API key in ~/.ping-mem/auth.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigDir } from "./config.js";

export interface AuthState {
  apiKey: string;
  serverUrl: string;
  createdAt: string;
}

function getAuthPath(): string {
  return path.join(getConfigDir(), "auth.json");
}

export function loadAuth(): AuthState | null {
  try {
    const raw = fs.readFileSync(getAuthPath(), "utf-8");
    return JSON.parse(raw) as AuthState;
  } catch {
    return null;
  }
}

export function saveAuth(auth: AuthState): void {
  const configDir = getConfigDir();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(getAuthPath(), JSON.stringify(auth, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function clearAuth(): void {
  try {
    fs.unlinkSync(getAuthPath());
  } catch {
    // File may not exist — that's fine
  }
}
