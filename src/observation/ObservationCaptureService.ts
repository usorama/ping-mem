import * as crypto from "node:crypto";
import { createLogger } from "../util/logger.js";
import type { EventStore } from "../storage/EventStore.js";
import type { SessionId, EventType } from "../types/index.js";

const log = createLogger("ObservationCapture");

/** Secrets patterns to redact from summaries */
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /\b[A-Za-z0-9]{32,}\b/g, // generic long tokens
  /password\s*=\s*\S+/gi,
  /api[_-]?key\s*[=:]\s*\S+/gi,
];

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export interface ObservationInput {
  sessionId: string;
  toolName: string;
  toolUseId?: string;
  project?: string;
  filesTouched?: string[];
  hookEvent: string; // "PostToolUse" | "Stop"
  claudeSessionId?: string;
  /** Safe summary — NOT raw tool input/output */
  summary?: string;
}

/** Content-hash dedup window */
const DEDUP_WINDOW_MS = 30_000;
const dedupCache = new Map<string, number>();

/** Periodically clean dedup cache */
setInterval(() => {
  const now = Date.now();
  for (const [hash, ts] of dedupCache) {
    if (now - ts > DEDUP_WINDOW_MS * 2) {
      dedupCache.delete(hash);
    }
  }
}, 60_000).unref();

export class ObservationCaptureService {
  constructor(private readonly eventStore: EventStore) {}

  async capture(input: ObservationInput): Promise<{ eventId: string; deduplicated: boolean }> {
    // Build safe summary
    const summary = input.summary
      ? redactSecrets(input.summary.slice(0, 200))
      : `${input.toolName} used`;

    // Content hash for dedup
    const hashInput = `${input.sessionId}:${input.toolName}:${summary}`;
    const contentHash = crypto
      .createHash("sha256")
      .update(hashInput)
      .digest("hex")
      .slice(0, 16);

    // Check dedup window
    const lastSeen = dedupCache.get(contentHash);
    if (lastSeen && Date.now() - lastSeen < DEDUP_WINDOW_MS) {
      log.debug(`Dedup hit for ${input.toolName}: ${contentHash}`);
      return { eventId: "", deduplicated: true };
    }
    dedupCache.set(contentHash, Date.now());

    // Store as event — NEVER store raw tool input/output
    const event = await this.eventStore.createEvent(
      input.sessionId as SessionId,
      "OBSERVATION_CAPTURED" as EventType,
      {
        toolName: input.toolName,
        toolUseId: input.toolUseId,
        project: input.project,
        summary,
        filesTouched: input.filesTouched ?? [],
        contentHash,
        hookEvent: input.hookEvent,
        claudeSessionId: input.claudeSessionId,
      },
    );

    log.debug(`Captured observation: ${input.toolName} -> ${event.eventId}`);
    return { eventId: event.eventId, deduplicated: false };
  }
}
