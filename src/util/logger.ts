/**
 * Structured Logger for ping-mem
 *
 * In production (NODE_ENV=production): outputs JSON lines for machine parsing.
 * In development (default): outputs human-readable prefixed messages.
 *
 * @module util/logger
 * @version 1.0.0
 */

// ============================================================================
// Types
// ============================================================================

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  module: string;
  msg: string;
  ts: string;
  data?: Record<string, unknown>;
}

/**
 * Detect if running as MCP stdio server.
 * When true, ALL log output MUST go to stderr to avoid corrupting the JSON-RPC protocol on stdout.
 */
const isMcpStdio = process.argv.some(
  (arg) => arg.includes("mcp/cli") || arg.includes("mcp\\cli"),
);

// ============================================================================
// Logger Class
// ============================================================================

/**
 * Structured logger that outputs JSON in production and human-readable text in development.
 *
 * IMPORTANT: When running as an MCP stdio server, ALL output goes to stderr.
 * stdout is reserved exclusively for JSON-RPC messages.
 */
export class Logger {
  private readonly module: string;
  private readonly isProduction: boolean;

  constructor(module: string) {
    this.module = module;
    this.isProduction = process.env.NODE_ENV === "production";
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log("debug", msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.log("info", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.log("warn", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.log("error", msg, data);
  }

  private log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (this.isProduction) {
      this.logJson(level, msg, data);
    } else {
      this.logHuman(level, msg, data);
    }
  }

  private logJson(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      level,
      module: this.module,
      msg,
      ts: new Date().toISOString(),
    };
    if (data !== undefined) {
      entry.data = data;
    }
    const line = JSON.stringify(entry);
    // MCP stdio mode: ALL output to stderr — stdout is reserved for JSON-RPC
    process.stderr.write(line + "\n");
  }

  private logHuman(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    const prefix = `[${this.module}]`;
    const dataStr = data !== undefined ? " " + JSON.stringify(data) : "";
    const formatted = `${prefix} ${msg}${dataStr}`;

    // MCP stdio mode: ALL output to stderr — stdout is reserved for JSON-RPC
    if (isMcpStdio) {
      process.stderr.write(formatted + "\n");
      return;
    }

    switch (level) {
      case "error":
        console.error(formatted);
        break;
      case "warn":
        console.warn(formatted);
        break;
      case "debug":
        console.debug(formatted);
        break;
      default:
        console.log(formatted);
        break;
    }
  }
}

// ============================================================================
// Factory & Default Singleton
// ============================================================================

/**
 * Create a logger instance for a specific module.
 */
export function createLogger(module: string): Logger {
  return new Logger(module);
}

/**
 * Default singleton logger for general use.
 */
export const logger = createLogger("ping-mem");
