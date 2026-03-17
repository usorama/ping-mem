/**
 * Thin HTTP client for CLI commands.
 *
 * Reads server URL and API key from config/auth, calls REST endpoints.
 */

import { loadConfig } from "./config.js";
import { loadAuth } from "./auth.js";

export interface ClientOptions {
  serverUrl?: string | undefined;
  apiKey?: string | undefined;
}

export class PingMemClient {
  private serverUrl: string;
  private apiKey: string | undefined;

  constructor(opts?: ClientOptions) {
    const config = loadConfig();
    const auth = loadAuth();
    this.serverUrl = opts?.serverUrl ?? config.serverUrl;
    this.apiKey = opts?.apiKey ?? auth?.apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  async get<T = unknown>(urlPath: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(urlPath, this.serverUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== "") {
          url.searchParams.set(k, v);
        }
      }
    }
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: this.headers(),
    });
    return this.handleResponse<T>(res);
  }

  async post<T = unknown>(urlPath: string, body?: Record<string, unknown>): Promise<T> {
    const url = new URL(urlPath, this.serverUrl);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: this.headers(),
      body: body ? JSON.stringify(body) : null,
    });
    return this.handleResponse<T>(res);
  }

  async delete<T = unknown>(urlPath: string): Promise<T> {
    const url = new URL(urlPath, this.serverUrl);
    const res = await fetch(url.toString(), {
      method: "DELETE",
      headers: this.headers(),
    });
    return this.handleResponse<T>(res);
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return text as T;
    }
    if (!res.ok) {
      const errObj = data as Record<string, unknown>;
      const msg = (errObj.message ?? errObj.error ?? text) as string;
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    return data as T;
  }
}

/**
 * Create a client using config + auth defaults.
 */
export function createClient(opts?: ClientOptions): PingMemClient {
  return new PingMemClient(opts);
}
