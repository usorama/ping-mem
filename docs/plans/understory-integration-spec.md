---
title: "Understory Integration Enhancement Spec"
version: 1.0.0
date: 2026-03-03
status: draft
author: orchestrator
target_version: "2.0.0"
---

# ping-mem Understory Integration Enhancement Spec

## Overview

This spec defines enhancements to ping-mem to serve as the memory backbone for
Understory, an engineering orchestration platform with 10+ concurrent agents
(Coordinator, Lead, Supervisor, Monitor, Gardener, Scout, Builder, Reviewer,
Security Reviewer, Merger, plus 14 ephemeral agent types).

**Scope**: 8 enhancement areas across agent identity, concurrency, schemas,
pub/sub, compression, knowledge integration, evidence gates, and deployment.

**Current state**: ping-mem v1.5.0 with 36 MCP tools, 3-tier degradable
architecture (SQLite + Neo4j + Qdrant), 5-mode hybrid search, and event-sourced
foundation. Deployed on VPS at `ping-mem.ping-gadgets.com` (streamable-http
transport) and locally (SSE/REST via Docker Compose).

---

## 1. Agent Identity System (CRITICAL)

### Problem

All memories are scoped by `sessionId` only. There is no concept of an agent
identity. When 10+ Understory agents share a ping-mem instance, there is no way
to:

- Isolate one Builder's working memory from another
- Enforce read/write permissions by agent role
- Track which agent wrote a memory
- Prevent runaway agents from exhausting storage

### Current State Analysis

**`src/types/index.ts` (lines 108-133)** — `Memory` interface has `sessionId`
but no `agentId`:

```typescript
export interface Memory {
  id: MemoryId;
  key: string;
  value: string;
  sessionId: SessionId;
  category?: MemoryCategory;
  priority: MemoryPriority;
  privacy: MemoryPrivacy;
  channel?: string;
  createdAt: Date;
  updatedAt: Date;
  embedding?: Float32Array;
  metadata: Record<string, unknown>;
}
```

**`src/types/index.ts` (lines 182-198)** — `EventType` has `AGENT_TASK_STARTED`,
`AGENT_TASK_SUMMARY`, `AGENT_TASK_COMPLETED` but these are just event types with
no agent scoping.

**`src/storage/EventStore.ts` (lines 60-75)** — `Event` interface has
`sessionId` but no `agentId`:

```typescript
export interface Event {
  eventId: string;
  timestamp: Date;
  sessionId: SessionId;
  eventType: EventType;
  payload: SessionEventData | MemoryEventData | WorklogEventData | Record<string, unknown>;
  causedBy?: string;
  metadata: Record<string, unknown>;
}
```

### Specification

#### 1.1 New Types (`src/types/index.ts`)

```typescript
/** Unique agent identifier (format: "{role}-{instance}" e.g. "builder-1") */
export type AgentId = string;

/** Agent roles matching Understory's 10 core agent types */
export type AgentRole =
  | "coordinator"
  | "lead"
  | "supervisor"
  | "monitor"
  | "gardener"
  | "scout"
  | "builder"
  | "reviewer"
  | "security-reviewer"
  | "merger"
  | "ephemeral";

/** Memory visibility scope for agent isolation */
export type AgentMemoryScope =
  | "private"   // Only the owning agent can read/write
  | "role"      // Agents with the same role can read; only owner can write
  | "shared"    // All agents can read; only owner can write
  | "public";   // All agents can read and write

/** Agent identity and permissions */
export interface AgentIdentity {
  /** Unique agent ID (e.g. "builder-1") */
  agentId: AgentId;
  /** Agent's role */
  role: AgentRole;
  /** Memory quota in bytes (0 = unlimited) */
  memoryQuotaBytes: number;
  /** Memory quota in entry count (0 = unlimited) */
  memoryQuotaCount: number;
  /** Categories this agent can write to */
  allowedCategories: MemoryCategory[];
  /** Custom metadata */
  metadata: Record<string, unknown>;
}

/** Per-agent storage usage tracking */
export interface AgentQuotaUsage {
  agentId: AgentId;
  currentBytes: number;
  currentCount: number;
  quotaBytes: number;
  quotaCount: number;
  lastUpdated: Date;
}
```

#### 1.2 Modify `Memory` Interface (`src/types/index.ts`)

Add to the existing `Memory` interface (line 108):

```typescript
export interface Memory {
  // ... existing fields ...

  /** Agent that created this memory (optional for backward compat) */
  agentId?: AgentId;
  /** Agent-level visibility scope (default: "shared") */
  agentScope?: AgentMemoryScope;
}
```

#### 1.3 Modify `Event` Interface (`src/storage/EventStore.ts`)

Add to the existing `Event` interface (line 60):

```typescript
export interface Event {
  // ... existing fields ...

  /** Agent that generated this event (optional for backward compat) */
  agentId?: string;
}
```

#### 1.4 Database Migration — `events` Table

```sql
-- Migration: Add agent_id column to events table
ALTER TABLE events ADD COLUMN agent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);

-- Migration: Add agent columns to memory payloads
-- (No DDL change needed — agent info stored in payload JSON and metadata)
```

#### 1.5 New `agent_quotas` Table (in EventStore DB)

```sql
CREATE TABLE IF NOT EXISTS agent_quotas (
  agent_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  current_bytes INTEGER DEFAULT 0,
  current_count INTEGER DEFAULT 0,
  quota_bytes INTEGER DEFAULT 0,       -- 0 = unlimited
  quota_count INTEGER DEFAULT 0,       -- 0 = unlimited
  allowed_categories TEXT NOT NULL,     -- JSON array
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_agent_quotas_role ON agent_quotas(role);
```

#### 1.6 Files to Modify

| File | Change |
|------|--------|
| `src/types/index.ts` | Add `AgentId`, `AgentRole`, `AgentMemoryScope`, `AgentIdentity`, `AgentQuotaUsage` types; extend `Memory` |
| `src/storage/EventStore.ts` | Add `agent_id` column to schema, extend `Event` interface, update prepared statements |
| `src/memory/MemoryManager.ts` | Add `agentId` to config, enforce scope on reads/writes, quota check on save |
| `src/session/SessionManager.ts` | Accept `agentId` in `SessionConfig`, store in session metadata |
| `src/mcp/PingMemServer.ts` | Add `agentId` param to `context_session_start`, `context_save`; add `agent_register`, `agent_quota_status` tools |
| `src/http/rest-server.ts` | Add `X-Agent-ID` header support, agent registration endpoint |

#### 1.7 New MCP Tools

```typescript
{
  name: "agent_register",
  description: "Register an agent identity with role and quotas",
  inputSchema: {
    type: "object",
    properties: {
      agentId: { type: "string", description: "Unique agent ID (e.g. 'builder-1')" },
      role: {
        type: "string",
        enum: ["coordinator", "lead", "supervisor", "monitor", "gardener",
               "scout", "builder", "reviewer", "security-reviewer", "merger", "ephemeral"],
        description: "Agent role"
      },
      memoryQuotaBytes: { type: "number", description: "Memory quota in bytes (0 = unlimited)" },
      memoryQuotaCount: { type: "number", description: "Memory quota in entry count (0 = unlimited)" },
      allowedCategories: {
        type: "array",
        items: { type: "string" },
        description: "Categories this agent can write to"
      },
    },
    required: ["agentId", "role"],
  },
},
{
  name: "agent_quota_status",
  description: "Get quota usage for an agent or all agents",
  inputSchema: {
    type: "object",
    properties: {
      agentId: { type: "string", description: "Agent ID (omit for all agents)" },
    },
  },
}
```

#### 1.8 Scope Enforcement Logic (`MemoryManager`)

```typescript
// In MemoryManager.get() — enforce read scope
private canRead(memory: Memory, requestingAgentId?: AgentId): boolean {
  if (!memory.agentId || !memory.agentScope) return true; // backward compat
  if (memory.agentScope === "public" || memory.agentScope === "shared") return true;
  if (memory.agentScope === "private") return memory.agentId === requestingAgentId;
  if (memory.agentScope === "role") {
    // Lookup roles from agent_quotas table
    const ownerRole = this.getAgentRole(memory.agentId);
    const requesterRole = this.getAgentRole(requestingAgentId);
    return ownerRole === requesterRole;
  }
  return false;
}
```

#### 1.9 Backward Compatibility

- `agentId` is optional on all types
- Existing memories without `agentId` are treated as `scope: "public"`
- Existing MCP tools continue to work without `agentId` parameter
- Quota enforcement only applies to registered agents
- No breaking changes to REST API — `X-Agent-ID` header is optional

#### 1.10 Test Requirements

- Agent registration and quota enforcement
- Scope enforcement: private/role/shared/public reads and writes
- Quota exceeded rejection (save returns error, not silent fail)
- Backward compatibility: all existing tests pass unchanged
- Cross-agent memory sharing with explicit opt-in
- 10+ concurrent agent simulation test

---

## 2. Concurrent Write Safety (HIGH)

### Problem

SQLite WAL mode helps concurrent reads but write contention exists. The
`MemoryManager` class uses in-memory `Map<string, Memory>` caches
(`src/memory/MemoryManager.ts` lines 145-147) with no synchronization. When
multiple agents save memories concurrently through separate REST/MCP connections,
writes can conflict.

CLAUDE.md (lines 169-170) explicitly notes: "Race conditions in
MemoryManager/SessionManager" as a pending quality issue.

### Current State Analysis

**`src/storage/EventStore.ts`** — Uses `PRAGMA busy_timeout = 5000` (line 167)
and WAL mode. SQLite transactions are used for batch operations (`appendBatch`
line 373, `createCheckpoint` line 529). However, there is no advisory locking
or write queue.

**`src/memory/MemoryManager.ts`** — All state is in-memory Maps with no
concurrency control:
```typescript
private memories: Map<string, Memory>;        // line 145
private memoriesById: Map<MemoryId, Memory>;  // line 147
```

**`src/http/rest-server.ts`** — Each request runs independently. Two
simultaneous `POST /api/v1/context` calls can create duplicate keys or corrupt
the in-memory Map.

### Specification

#### 2.1 Write Queue Table (SQLite)

```sql
-- Migration: Add write_queue table for advisory locking
CREATE TABLE IF NOT EXISTS write_locks (
  lock_key TEXT PRIMARY KEY,      -- e.g. "memory:{sessionId}:{key}"
  holder_id TEXT NOT NULL,        -- UUIDv7 of the writer
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,       -- Auto-expire after 30s
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_write_locks_expires ON write_locks(expires_at);
```

#### 2.2 New `WriteLockManager` Class (`src/storage/WriteLockManager.ts`)

```typescript
export interface WriteLockManagerConfig {
  db: Database;
  lockTimeoutMs?: number;   // Default: 30000 (30s)
  retryIntervalMs?: number; // Default: 50
  maxRetries?: number;       // Default: 100 (5s total wait)
}

export class WriteLockManager {
  /** Acquire advisory lock. Throws if timeout exceeded. */
  acquire(lockKey: string, holderId: string): void;

  /** Release advisory lock. No-op if not held by holderId. */
  release(lockKey: string, holderId: string): void;

  /** Execute callback under lock. Auto-releases on completion/error. */
  withLock<T>(lockKey: string, fn: () => T | Promise<T>): Promise<T>;

  /** Expire stale locks (called periodically). */
  expireStale(): number;
}
```

#### 2.3 Integration Points

**`src/memory/MemoryManager.ts`** — Wrap `save()`, `update()`, `delete()` in
`writeLockManager.withLock()`:

```typescript
async save(key: string, value: string, options: SaveMemoryOptions = {}): Promise<Memory> {
  const lockKey = `memory:${this.sessionId}:${key}`;
  return this.writeLockManager.withLock(lockKey, async () => {
    // ... existing save logic ...
  });
}
```

**`src/session/SessionManager.ts`** — Wrap `startSession()`, `endSession()` in
locks:

```typescript
async startSession(config: SessionConfig): Promise<Session> {
  const lockKey = `session:start:${config.name}`;
  return this.writeLockManager.withLock(lockKey, async () => {
    // ... existing logic ...
  });
}
```

#### 2.4 Optimistic Concurrency for High-Throughput Paths

For cases where advisory locks would be too heavy (e.g., `ensureTracking` in
`RelevanceEngine`), use optimistic concurrency with version column:

```sql
-- Add version column to memory_relevance (existing table in RelevanceEngine)
ALTER TABLE memory_relevance ADD COLUMN version INTEGER DEFAULT 1;

-- Optimistic update pattern:
UPDATE memory_relevance
SET relevance_score = $score, version = version + 1
WHERE memory_id = $memoryId AND version = $expectedVersion;
-- If rows_affected == 0, retry with fresh read
```

#### 2.5 Files to Modify

| File | Change |
|------|--------|
| `src/storage/WriteLockManager.ts` | **New file** — advisory lock manager |
| `src/storage/EventStore.ts` | Add `write_locks` table to schema |
| `src/memory/MemoryManager.ts` | Accept `WriteLockManager` in config, wrap writes |
| `src/session/SessionManager.ts` | Accept `WriteLockManager` in config, wrap mutations |
| `src/memory/RelevanceEngine.ts` | Add `version` column, optimistic updates |
| `src/mcp/PingMemServer.ts` | Create `WriteLockManager`, pass to MemoryManager |
| `src/http/rest-server.ts` | Create `WriteLockManager`, pass to MemoryManager |

#### 2.6 Performance Requirement

- Single-agent write latency must not increase by more than 5ms (lock
  acquisition overhead)
- Lock contention test: 10 concurrent writers to same session, zero data
  corruption
- Lock timeout test: blocked writer eventually fails with clear error
- Stale lock cleanup every 60 seconds via periodic timer

#### 2.7 Test Requirements

- Concurrent save to same key: only one succeeds, other gets conflict error
- Concurrent save to different keys: both succeed (no false contention)
- Lock expiry: stale lock is cleaned up after timeout
- `withLock` auto-release on exception
- Optimistic concurrency retry for relevance updates
- Single-agent performance regression test (< 5ms overhead)

---

## 3. Structured Memory Schemas (HIGH)

### Problem

All memory values are free-form strings (`value: string` in `Memory` interface).
For Understory workflows, memories carry structured data (PRP decisions, review
findings, build results, knowledge entries) that should be validated at write
time.

### Current State Analysis

**`src/types/index.ts` (line 114)** — `value: string` is the only content field.

**`src/memory/MemoryManager.ts` (line 301)** — `save()` accepts any string.
No validation.

**`package.json` (line 72)** — Zod `^4.3.6` is already a dependency.

### Specification

#### 3.1 New Schema Module (`src/validation/memory-schemas.ts`)

```typescript
import { z } from "zod";

/** Schema registry — maps category to Zod schema for the memory value */
export const MEMORY_SCHEMAS = new Map<string, z.ZodType>();

/** PRP (Planning Resource Package) memory schema */
export const PRPMemorySchema = z.object({
  prpId: z.string(),
  tier: z.enum(["MINIMAL", "MORE", "A LOT"]),
  taskName: z.string(),
  description: z.string(),
  ptps: z.array(z.object({
    id: z.string(),
    description: z.string(),
    status: z.enum(["pending", "passing", "failing"]),
  })),
  assignedAgent: z.string().optional(),
  estimatedComplexity: z.number().min(1).max(10).optional(),
});

/** Review finding memory schema */
export const ReviewFindingSchema = z.object({
  findingId: z.string(),
  reviewerId: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  category: z.enum(["correctness", "security", "performance", "style", "documentation"]),
  filePath: z.string(),
  lineRange: z.object({ start: z.number(), end: z.number() }).optional(),
  description: z.string(),
  suggestion: z.string().optional(),
  autoFixable: z.boolean().default(false),
});

/** Build/test result memory schema */
export const BuildResultSchema = z.object({
  command: z.string(),
  exitCode: z.number(),
  status: z.enum(["success", "failed", "partial"]),
  durationMs: z.number(),
  output: z.string().max(10000), // Truncate long output
  testsRun: z.number().optional(),
  testsPassed: z.number().optional(),
  testsFailed: z.number().optional(),
  typecheckErrors: z.number().optional(),
  commitHash: z.string().optional(),
});

/** Knowledge entry memory schema (mirrors Understory's KnowledgeEntry) */
export const KnowledgeEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  tags: z.string(), // JSON array
  solution: z.string(),
  root_cause: z.string(),
  module: z.string().nullable().optional(),
  symptoms: z.string().nullable().optional(),
  prevention: z.string().nullable().optional(),
  code_examples: z.string().nullable().optional(),
  related_issues: z.string().nullable().optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).nullable().optional(),
  source_project: z.string(),
  source_agent: z.string().nullable().optional(),
});

/** Decision memory schema (requires rationale) */
export const DecisionMemorySchema = z.object({
  decisionId: z.string(),
  title: z.string(),
  description: z.string(),
  alternatives: z.array(z.object({
    name: z.string(),
    pros: z.array(z.string()),
    cons: z.array(z.string()),
  })).min(1),
  chosen: z.string(),
  rationale: z.string().min(10),
  reversible: z.boolean().default(true),
  decidedBy: z.string(),
});

// Register schemas by category
MEMORY_SCHEMAS.set("prp", PRPMemorySchema);
MEMORY_SCHEMAS.set("review_finding", ReviewFindingSchema);
MEMORY_SCHEMAS.set("build_result", BuildResultSchema);
MEMORY_SCHEMAS.set("knowledge_entry", KnowledgeEntrySchema);
MEMORY_SCHEMAS.set("decision", DecisionMemorySchema);

/** Validate memory value against its category schema.
 *  Returns { valid: true } or { valid: false, errors: string[] }.
 *  Categories without registered schemas always pass (backward compat). */
export function validateMemoryValue(
  category: string | undefined,
  value: string,
  strict: boolean = false
): { valid: boolean; errors: string[] } {
  if (!category) return { valid: true, errors: [] };

  const schema = MEMORY_SCHEMAS.get(category);
  if (!schema) {
    // No schema registered — free-form string is valid
    return { valid: true, errors: [] };
  }

  try {
    const parsed = JSON.parse(value);
    const result = schema.safeParse(parsed);
    if (result.success) return { valid: true, errors: [] };
    return {
      valid: false,
      errors: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`),
    };
  } catch {
    if (strict) {
      return { valid: false, errors: ["Value must be valid JSON for structured categories"] };
    }
    // Non-strict: free-form string is always valid
    return { valid: true, errors: [] };
  }
}
```

#### 3.2 Integration into MemoryManager

**`src/memory/MemoryManager.ts`** — Add validation in `save()`:

```typescript
import { validateMemoryValue } from "../validation/memory-schemas.js";

async save(key: string, value: string, options: SaveMemoryOptions = {}): Promise<Memory> {
  // Validate structured schemas (non-strict by default for backward compat)
  const validation = validateMemoryValue(options.category, value, options.strictSchema);
  if (!validation.valid) {
    throw new MemoryManagerError(
      `Schema validation failed for category '${options.category}': ${validation.errors.join("; ")}`,
      "SCHEMA_VALIDATION_FAILED",
      { category: options.category, errors: validation.errors }
    );
  }
  // ... existing save logic ...
}
```

Add `strictSchema?: boolean` to `SaveMemoryOptions`.

#### 3.3 MCP Tool Update

Add `strictSchema` parameter to `context_save` tool (line 101 in
`PingMemServer.ts`):

```typescript
strictSchema: {
  type: "boolean",
  description: "When true, enforce JSON schema validation for structured categories (default: false)",
},
```

#### 3.4 New MemoryCategory Values

Extend `MemoryCategory` in `src/types/index.ts` (line 85):

```typescript
export type MemoryCategory =
  | "task"
  | "decision"
  | "progress"
  | "note"
  | "error"
  | "warning"
  | "fact"
  | "observation"
  // New structured categories for Understory
  | "prp"
  | "review_finding"
  | "build_result"
  | "knowledge_entry";
```

#### 3.5 Backward Compatibility

- Existing categories (`task`, `decision`, etc.) have NO schema registered by
  default and continue to accept free-form strings
- `strictSchema` defaults to `false` — validation errors are returned but do
  not block saves unless explicitly opted in
- New categories (`prp`, `review_finding`, `build_result`, `knowledge_entry`)
  have schemas but only enforce in strict mode
- The `decision` category schema only enforces when `strictSchema: true`

#### 3.6 Files to Modify

| File | Change |
|------|--------|
| `src/validation/memory-schemas.ts` | **New file** — Zod schemas and registry |
| `src/types/index.ts` | Extend `MemoryCategory` union type |
| `src/memory/MemoryManager.ts` | Add validation call in `save()`, add `strictSchema` to options |
| `src/mcp/PingMemServer.ts` | Add `strictSchema` to `context_save` schema |
| `src/http/rest-server.ts` | Pass `strictSchema` from request body |

#### 3.7 Test Requirements

- Valid structured memory saves pass validation
- Invalid structured memory with `strictSchema: true` rejected with clear errors
- Invalid structured memory with `strictSchema: false` accepted (backward compat)
- Categories without schemas always pass
- Free-form string values for existing categories continue to work
- Schema registry extensibility (register custom schema at runtime)

---

## 4. Memory Pub/Sub for Inter-Agent Coordination (HIGH)

### Problem

Agents have no way to be notified when relevant memories are saved by other
agents. The Coordinator needs to know when a Builder saves a `build_result`. The
Monitor needs to see `error` memories in real-time. Currently, agents must poll.

### Current State Analysis

**`src/storage/EventStore.ts`** — All memory operations generate events (lines
364-406). The event data is available but there is no notification mechanism.

**`docker-compose.yml`** — The local deployment has SSE transport available
(line 57: `PING_MEM_TRANSPORT=sse`). SSE is a natural fit for push
notifications.

**`src/http/rest-server.ts`** — Uses Hono web framework. No SSE streaming
endpoints exist for memory events.

### Specification

#### 4.1 New `MemoryPubSub` Class (`src/pubsub/MemoryPubSub.ts`)

```typescript
/** Subscription filter for memory events */
export interface MemorySubscription {
  /** Unique subscription ID */
  subscriptionId: string;
  /** Filter by memory category */
  categories?: MemoryCategory[];
  /** Filter by channel */
  channels?: string[];
  /** Filter by agent ID */
  agentIds?: AgentId[];
  /** Filter by agent scope (e.g., only "shared" and "public") */
  minScope?: AgentMemoryScope;
  /** Filter by event type */
  eventTypes?: EventType[];
  /** Callback for MCP subscribers */
  callback?: (event: MemoryEvent) => void;
  /** SSE response writer for HTTP subscribers */
  sseWriter?: WritableStreamDefaultWriter;
  /** Webhook URL for async subscribers */
  webhookUrl?: string;
  /** Created timestamp */
  createdAt: Date;
}

/** A memory event notification */
export interface MemoryEvent {
  eventId: string;
  eventType: EventType;
  timestamp: Date;
  sessionId: SessionId;
  agentId?: AgentId;
  memoryKey?: string;
  memoryCategory?: MemoryCategory;
  channel?: string;
  /** Abbreviated value (max 500 chars) to avoid flooding */
  valueSummary?: string;
}

export class MemoryPubSub {
  private subscriptions: Map<string, MemorySubscription> = new Map();

  /** Subscribe to memory events. Returns subscription ID. */
  subscribe(filter: Omit<MemorySubscription, "subscriptionId" | "createdAt">): string;

  /** Unsubscribe by subscription ID. */
  unsubscribe(subscriptionId: string): boolean;

  /** Publish a memory event to all matching subscribers. */
  publish(event: MemoryEvent): Promise<void>;

  /** Get active subscription count. */
  getSubscriptionCount(): number;

  /** List active subscriptions (for diagnostics). */
  listSubscriptions(): MemorySubscription[];
}
```

#### 4.2 Integration — Publish on Memory Operations

**`src/memory/MemoryManager.ts`** — After each save/update/delete event is
written to the EventStore, also publish to the PubSub:

```typescript
// In save(), after eventStore.createEvent():
if (this.pubsub) {
  this.pubsub.publish({
    eventId: event.eventId,
    eventType: "MEMORY_SAVED",
    timestamp: new Date(),
    sessionId: this.sessionId,
    agentId: this.agentId,
    memoryKey: key,
    memoryCategory: options.category,
    channel: memory.channel,
    valueSummary: value.substring(0, 500),
  });
}
```

#### 4.3 SSE Streaming Endpoint

**`src/http/rest-server.ts`** — New endpoint:

```typescript
// GET /api/v1/events/stream — SSE stream for memory events
this.app.get("/api/v1/events/stream", async (c) => {
  const categories = c.req.query("categories")?.split(",") as MemoryCategory[] | undefined;
  const channels = c.req.query("channels")?.split(",");
  const agentIds = c.req.query("agentIds")?.split(",");

  // Set SSE headers
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  return c.stream(async (stream) => {
    const subscriptionId = this.pubsub.subscribe({
      categories,
      channels,
      agentIds,
      sseWriter: stream,
    });

    // Keep connection alive with heartbeat
    const heartbeat = setInterval(() => {
      stream.write(": heartbeat\n\n");
    }, 30000);

    // Cleanup on disconnect
    stream.onAbort(() => {
      clearInterval(heartbeat);
      this.pubsub.unsubscribe(subscriptionId);
    });
  });
});
```

#### 4.4 Webhook Delivery

```typescript
// POST /api/v1/events/webhooks — Register a webhook subscriber
this.app.post("/api/v1/events/webhooks", async (c) => {
  const body = await c.req.json();
  const subscriptionId = this.pubsub.subscribe({
    categories: body.categories,
    channels: body.channels,
    agentIds: body.agentIds,
    webhookUrl: body.url,
  });
  return c.json({ subscriptionId });
});

// DELETE /api/v1/events/webhooks/:id — Remove a webhook
this.app.delete("/api/v1/events/webhooks/:id", async (c) => {
  this.pubsub.unsubscribe(c.req.param("id"));
  return c.json({ message: "Unsubscribed" });
});
```

#### 4.5 MCP Tool for Subscribe

```typescript
{
  name: "memory_subscribe",
  description: "Subscribe to memory events matching filters. Returns subscription ID. Events are delivered via MCP notifications.",
  inputSchema: {
    type: "object",
    properties: {
      categories: { type: "array", items: { type: "string" }, description: "Filter by categories" },
      channels: { type: "array", items: { type: "string" }, description: "Filter by channels" },
      agentIds: { type: "array", items: { type: "string" }, description: "Filter by agent IDs" },
      eventTypes: { type: "array", items: { type: "string" }, description: "Filter by event types" },
    },
  },
},
{
  name: "memory_unsubscribe",
  description: "Unsubscribe from memory events",
  inputSchema: {
    type: "object",
    properties: {
      subscriptionId: { type: "string", description: "Subscription ID to remove" },
    },
    required: ["subscriptionId"],
  },
}
```

#### 4.6 Files to Modify

| File | Change |
|------|--------|
| `src/pubsub/MemoryPubSub.ts` | **New file** — pub/sub manager |
| `src/memory/MemoryManager.ts` | Accept `MemoryPubSub` in config, publish on save/update/delete |
| `src/mcp/PingMemServer.ts` | Create PubSub, add `memory_subscribe`/`memory_unsubscribe` tools |
| `src/http/rest-server.ts` | Add SSE stream endpoint, webhook endpoints |

#### 4.7 Test Requirements

- Subscribe + publish delivers event to subscriber
- Category/channel/agent filters work correctly
- SSE stream delivers events (integration test)
- Webhook delivery with retry (mock HTTP server)
- Unsubscribe stops delivery
- No memory leak: disconnected subscribers are cleaned up
- Heartbeat keeps SSE connections alive

---

## 5. Semantic Compression Pipeline (HIGH)

### Problem

Understory agents generate verbose session transcripts. A single Builder session
can produce 100+ memories with redundant information. The RelevanceEngine
(`src/memory/RelevanceEngine.ts`) handles decay and consolidation, but its
digest creation (line 526-536) is simple string truncation, not semantic
compression.

### Current State Analysis

**`src/memory/RelevanceEngine.ts` (lines 484-566)** — The `consolidate()` method
finds stale memories, groups by channel/category, and creates digest entries.
The digest format is:

```
- key1: truncated_value_200_chars...
- key2: truncated_value_200_chars...
```

This is NOT semantic compression. It is string concatenation with truncation.

**`src/memory/RelevanceEngine.ts` (lines 22-31)** — Config includes
`maxPerDigest` (20) and `maxDigestLength` (2000), but no compression settings.

### Specification

#### 5.1 New `SemanticCompressor` Class (`src/memory/SemanticCompressor.ts`)

```typescript
export interface SemanticCompressorConfig {
  /** LLM provider for compression (defaults to OpenAI) */
  llmProvider?: CompressionLLMProvider;
  /** Target compression ratio (default: 0.2 = 80% reduction) */
  targetRatio?: number;
  /** Maximum input tokens per compression batch (default: 8000) */
  maxInputTokens?: number;
  /** Maximum output tokens per compressed unit (default: 2000) */
  maxOutputTokens?: number;
  /** Compression strategy */
  strategy?: "extract-facts" | "summarize-chain" | "observer-reflector";
}

export interface CompressionLLMProvider {
  compress(input: CompressInput): Promise<CompressOutput>;
}

export interface CompressInput {
  memories: Array<{ key: string; value: string; category?: string; channel?: string }>;
  strategy: string;
  targetTokens: number;
}

export interface CompressOutput {
  /** Compressed content preserving logical structure */
  compressed: string;
  /** Durable facts extracted from the input */
  facts: Array<{ fact: string; confidence: number; sourceKeys: string[] }>;
  /** Token counts for verification */
  inputTokens: number;
  outputTokens: number;
  /** Compression ratio achieved */
  ratio: number;
}

export class SemanticCompressor {
  /** Compress a batch of memories into a compact representation.
   *  NOT summarization — preserves logical structure, extracts durable facts. */
  async compress(memories: Array<{
    key: string;
    value: string;
    category?: string;
    channel?: string;
  }>): Promise<CompressOutput>;

  /** Observer/Reflector pattern: extract facts, then consolidate into
   *  a smaller set when the fact store exceeds threshold. */
  async observeAndReflect(
    newMemories: Array<{ key: string; value: string }>,
    existingFacts: Array<{ fact: string; confidence: number }>
  ): Promise<{ facts: Array<{ fact: string; confidence: number }>; compressed: string }>;
}
```

#### 5.2 LLM Prompt for Semantic Compression

```
System: You are a semantic compressor for engineering memory. Your job is to
extract durable facts and logical structure from verbose session transcripts.

Rules:
- Extract facts, not summaries. "The auth module uses bcrypt for password
  hashing" not "The team discussed auth approaches."
- Preserve causal chains: "X caused Y because Z" must remain intact.
- Preserve decision rationale: "Chose X over Y because Z" must remain intact.
- Remove redundancy: if the same fact appears 5 times, emit it once with
  higher confidence.
- Target {targetTokens} output tokens from {inputTokens} input tokens.
- Output JSON: { compressed: string, facts: [{ fact, confidence, sourceKeys }] }
```

#### 5.3 Integration with RelevanceEngine

**`src/memory/RelevanceEngine.ts`** — Modify `consolidate()` to use
`SemanticCompressor` when available:

```typescript
// In consolidate(), replace the simple digest creation (lines 526-536):
if (this.compressor) {
  const compressed = await this.compressor.compress(
    chunk.map(({ payload }) => ({
      key: payload.key ?? "unknown",
      value: payload.value ?? "",
      category: payload.category,
      channel: payload.channel,
    }))
  );
  digestValue = compressed.compressed;
  // Store extracted facts as separate high-priority memories
  for (const fact of compressed.facts.filter(f => f.confidence >= 0.8)) {
    // Emit fact as new memory via callback
  }
} else {
  // Fallback to existing truncation logic
}
```

#### 5.4 Automatic Compression Trigger

Add a periodic compression job that runs when:
- Session memory count exceeds 100 entries
- Total memory value size exceeds 500KB
- Explicitly triggered via MCP tool

```typescript
{
  name: "memory_compress",
  description: "Trigger semantic compression of stale memories. Extracts durable facts and compresses verbose transcripts.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Session to compress (default: current)" },
      strategy: {
        type: "string",
        enum: ["extract-facts", "summarize-chain", "observer-reflector"],
        description: "Compression strategy (default: extract-facts)"
      },
      targetRatio: { type: "number", description: "Target compression ratio 0.0-1.0 (default: 0.2)" },
    },
  },
}
```

#### 5.5 Files to Modify/Create

| File | Change |
|------|--------|
| `src/memory/SemanticCompressor.ts` | **New file** — compression engine |
| `src/memory/RelevanceEngine.ts` | Accept `SemanticCompressor` in constructor, use in `consolidate()` |
| `src/mcp/PingMemServer.ts` | Add `memory_compress` tool, wire `SemanticCompressor` |

#### 5.6 Test Requirements

- 80%+ token reduction on verbose session transcript (100+ memories)
- Extracted facts are accurate (spot-check against source)
- Causal chains preserved in compressed output
- Decision rationale preserved in compressed output
- Graceful degradation without LLM provider (falls back to truncation)
- Observer/Reflector pattern: fact store stays bounded under repeated compression

---

## 6. Knowledge Integration API (HIGH)

### Problem

Understory's `_understory/knowledge.db` contains engineering knowledge entries
that should be searchable and ingestible via ping-mem. Currently, there is no
REST endpoint for knowledge-specific operations, and Understory's
`KnowledgeEntry` schema does not map directly to ping-mem's `Entity` model.

### Current State Analysis

**Understory `KnowledgeEntry`** (from `src/types.ts` lines 538-566):
```typescript
interface KnowledgeEntry {
  id: string;           // content-hash for dedup
  title: string;
  category: string;
  tags: string;         // JSON array
  module: string | null;
  symptoms: string | null;
  root_cause: string | null;
  solution: string;
  prevention: string | null;
  code_examples: string | null;
  related_issues: string | null;
  severity: EscalationSeverity | null;
  resolution_time: string | null;
  source_project: string;
  source_agent: string | null;
  created_at: string;
  updated_at: string;
  access_count: number;
  updated_count: number;
  usefulness_score: number;
  superseded_by: string | null;
  status: KnowledgeStatus;
}
```

**ping-mem `Entity`** (from `src/types/graph.ts` lines 50-67):
```typescript
interface Entity {
  id: string;
  type: EntityType;
  name: string;
  properties: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  eventTime: Date;
  ingestionTime: Date;
}
```

**Current REST endpoints** (`src/http/rest-server.ts`) — No knowledge-specific
endpoints exist. Codebase search (`GET /api/v1/codebase/search`) searches code
chunks, not knowledge entries.

### Specification

#### 6.1 New REST Endpoints

All endpoints under `/api/v1/knowledge/`:

```typescript
// POST /api/v1/knowledge/search — Semantic search across knowledge entries
// Request body:
{
  query: string;           // Natural language query
  projectId?: string;      // Filter by source project
  category?: string;       // Filter by knowledge category
  severity?: string;       // Filter by severity
  limit?: number;          // Default: 10
  minScore?: number;       // Default: 0.3
}
// Response:
{
  data: {
    results: Array<{
      entry: KnowledgeEntry;
      score: number;
      highlights: string[];
    }>;
    totalCount: number;
  }
}

// POST /api/v1/knowledge/ingest — Ingest Understory knowledge.jsonl
// Request body:
{
  entries: KnowledgeEntry[];  // Array of entries to ingest
  projectId: string;          // Source project identifier
  dedup?: boolean;            // Enable content-hash dedup (default: true)
}
// Response:
{
  data: {
    ingested: number;
    deduplicated: number;
    errors: Array<{ index: number; error: string }>;
  }
}

// GET /api/v1/knowledge/cross-project — Cross-project knowledge search
// Query params:
//   query: string
//   excludeProject?: string   // Exclude source project
//   limit?: number
// Response:
{
  data: {
    results: Array<{
      entry: KnowledgeEntry;
      score: number;
      sourceProject: string;
    }>;
  }
}

// GET /api/v1/knowledge/stats — Knowledge base statistics
// Response:
{
  data: {
    totalEntries: number;
    byProject: Record<string, number>;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
  }
}
```

#### 6.2 Knowledge-to-Entity Mapping

Map Understory's `KnowledgeEntry` to ping-mem's graph model:

```typescript
function knowledgeEntryToEntity(entry: KnowledgeEntry): Entity {
  return {
    id: `knowledge:${entry.id}`,
    type: EntityType.FACT,     // Closest match
    name: entry.title,
    properties: {
      category: entry.category,
      tags: entry.tags,
      module: entry.module,
      symptoms: entry.symptoms,
      root_cause: entry.root_cause,
      solution: entry.solution,
      prevention: entry.prevention,
      severity: entry.severity,
      source_project: entry.source_project,
      source_agent: entry.source_agent,
      usefulness_score: entry.usefulness_score,
      status: entry.status,
    },
    createdAt: new Date(entry.created_at),
    updatedAt: new Date(entry.updated_at),
    eventTime: new Date(entry.created_at),
    ingestionTime: new Date(),
  };
}
```

#### 6.3 Knowledge Storage Table (SQLite — Tier 1)

```sql
-- New table in events.db for knowledge entries (SQLite-only, no Neo4j required)
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id TEXT PRIMARY KEY,                -- content-hash from Understory
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT NOT NULL,                  -- JSON array
  module TEXT,
  symptoms TEXT,
  root_cause TEXT,
  solution TEXT NOT NULL,
  prevention TEXT,
  code_examples TEXT,
  related_issues TEXT,
  severity TEXT,
  resolution_time TEXT,
  source_project TEXT NOT NULL,
  source_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  access_count INTEGER DEFAULT 0,
  updated_count INTEGER DEFAULT 0,
  usefulness_score REAL DEFAULT 0.0,
  superseded_by TEXT,
  status TEXT DEFAULT 'active',
  ingested_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge_entries(source_project);
CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_entries(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge_entries(status);
```

#### 6.4 New MCP Tools

```typescript
{
  name: "knowledge_search",
  description: "Semantic search across ingested knowledge entries from Understory and other sources",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      projectId: { type: "string", description: "Filter by project" },
      category: { type: "string", description: "Filter by category" },
      limit: { type: "number", description: "Max results (default: 10)" },
    },
    required: ["query"],
  },
},
{
  name: "knowledge_ingest",
  description: "Ingest knowledge entries (from Understory knowledge.jsonl or other sources)",
  inputSchema: {
    type: "object",
    properties: {
      entries: { type: "array", items: { type: "object" }, description: "Knowledge entries to ingest" },
      projectId: { type: "string", description: "Source project ID" },
      dedup: { type: "boolean", description: "Enable dedup (default: true)" },
    },
    required: ["entries", "projectId"],
  },
}
```

#### 6.5 Tier Behavior

| Feature | SQLite Only | + Neo4j | + Qdrant |
|---------|-------------|---------|----------|
| Knowledge storage | Yes (knowledge_entries table) | Yes + entity graph | Yes + entity graph |
| Keyword search | Yes (FTS5 on title + solution) | Yes | Yes |
| Semantic search | No | No | Yes (vector index) |
| Cross-project graph | No | Yes (REFERENCES edges) | Yes |
| Relationship inference | No | Yes (auto RELATED_TO) | Yes |

#### 6.6 Files to Modify/Create

| File | Change |
|------|--------|
| `src/knowledge/KnowledgeStore.ts` | **New file** — CRUD for knowledge_entries |
| `src/knowledge/KnowledgeMapper.ts` | **New file** — KnowledgeEntry <-> Entity mapping |
| `src/http/rest-server.ts` | Add knowledge REST endpoints |
| `src/mcp/PingMemServer.ts` | Add knowledge MCP tools |
| `src/storage/EventStore.ts` | Add knowledge_entries table to schema |

#### 6.7 Test Requirements

- Ingest 100 knowledge entries, verify dedup works (content-hash)
- Keyword search returns relevant entries
- Cross-project search excludes source project
- Stats endpoint returns accurate counts
- Entity mapping round-trip: KnowledgeEntry -> Entity -> properties -> KnowledgeEntry
- Graceful handling of malformed entries during batch ingest

---

## 7. Evidence-Based Memory Gates (MEDIUM)

### Problem

Agents can save memories with claims that have no supporting evidence. A Builder
might save `{ category: "build_result", value: "all tests pass" }` without
actually running the tests. Low-quality memories pollute the store and mislead
other agents.

### Specification

#### 7.1 Evidence Gate Configuration (`src/validation/evidence-gates.ts`)

```typescript
import { z } from "zod";

/** Evidence requirement for a memory category */
export interface EvidenceGate {
  /** Category this gate applies to */
  category: MemoryCategory;
  /** Required evidence fields in metadata */
  requiredMetadataFields: string[];
  /** Zod schema for metadata validation */
  metadataSchema?: z.ZodType;
  /** Human-readable description of what evidence is needed */
  description: string;
  /** Whether this gate blocks saves or just warns */
  enforcement: "block" | "warn";
}

export const DEFAULT_EVIDENCE_GATES: EvidenceGate[] = [
  {
    category: "build_result",
    requiredMetadataFields: ["command", "exitCode", "output"],
    description: "Build results must include the command run, exit code, and actual output",
    enforcement: "block",
  },
  {
    category: "decision",
    requiredMetadataFields: ["alternatives", "rationale"],
    description: "Decisions must include alternatives considered and rationale",
    enforcement: "warn",
  },
  {
    category: "error",
    requiredMetadataFields: ["stackTrace"],
    description: "Error memories should include a stack trace or error output",
    enforcement: "warn",
  },
  {
    category: "review_finding",
    requiredMetadataFields: ["filePath", "severity"],
    description: "Review findings must specify the file path and severity",
    enforcement: "block",
  },
];
```

#### 7.2 Gate Enforcement in MemoryManager

```typescript
// In MemoryManager.save(), after schema validation:
const gateResult = this.checkEvidenceGate(options.category, value, options.metadata);
if (!gateResult.passed) {
  if (gateResult.enforcement === "block") {
    throw new MemoryManagerError(
      `Evidence gate failed for category '${options.category}': ${gateResult.reason}`,
      "EVIDENCE_GATE_FAILED",
      { category: options.category, missingFields: gateResult.missingFields }
    );
  }
  // "warn" enforcement: save succeeds but metadata.evidenceWarning is set
  options.metadata = {
    ...options.metadata,
    evidenceWarning: gateResult.reason,
    evidenceMissing: gateResult.missingFields,
  };
}
```

#### 7.3 Configurable Per-Deployment

Evidence gates are loaded from config and can be overridden:

```typescript
// Environment variable to disable gates (for development)
// PING_MEM_EVIDENCE_GATES=disabled

// Per-tool override in context_save:
{
  skipEvidenceGate: {
    type: "boolean",
    description: "Skip evidence gate checks (for migration/bulk import)",
  },
}
```

#### 7.4 Files to Modify/Create

| File | Change |
|------|--------|
| `src/validation/evidence-gates.ts` | **New file** — gate definitions and checker |
| `src/memory/MemoryManager.ts` | Call evidence gate check in `save()` |
| `src/mcp/PingMemServer.ts` | Add `skipEvidenceGate` to `context_save` |

#### 7.5 Test Requirements

- `build_result` without command/exitCode/output is blocked
- `decision` without alternatives triggers warning but saves
- `skipEvidenceGate: true` bypasses all gates
- `PING_MEM_EVIDENCE_GATES=disabled` disables all gates
- Custom gate registration and enforcement

---

## 8. Deployment Sync (Local <-> VPS)

### Current Deployment State

**VPS (Production)** — `docker-compose.prod.yml`:
- Transport: `streamable-http` on port 3000 (behind Cloudflare)
- No port exposure to host for Neo4j/Qdrant (internal network only)
- Higher memory allocation (Neo4j: 2G heap, 1G pagecache)
- Credentials from environment variables (not hardcoded)
- URL: `https://ping-mem.ping-gadgets.com`

**Local (Development)** — `docker-compose.yml`:
- Transport: `sse` on port 3000 (primary), `rest` on port 3003 (optional)
- Neo4j ports exposed: 7474 (HTTP), 7687 (Bolt)
- Qdrant ports exposed: 6333 (HTTP), 6334 (gRPC)
- Volume mount: `/Users/umasankr/Projects:/projects:rw`
- Hardcoded Neo4j password in dev compose

**Key difference**: VPS uses `streamable-http`, local uses `sse`. The VPS does
not expose the `/projects` volume mount (no local filesystem access on VPS).

### Specification

#### 8.1 Environment Parity Matrix

| Feature | Local (MCP stdio) | Local (Docker REST) | VPS (streamable-http) |
|---------|-------------------|---------------------|----------------------|
| Agent Identity (sec 1) | Yes | Yes | Yes |
| Write Locks (sec 2) | Yes (same-process) | Yes (SQLite file lock) | Yes (SQLite file lock) |
| Structured Schemas (sec 3) | Yes | Yes | Yes |
| Pub/Sub SSE (sec 4) | N/A (no HTTP) | Yes | Yes |
| Pub/Sub MCP (sec 4) | Yes (notifications) | N/A | N/A |
| Compression (sec 5) | Yes (needs OPENAI_API_KEY) | Yes | Yes |
| Knowledge API (sec 6) | Via MCP tools | Via REST | Via REST |
| Evidence Gates (sec 7) | Yes | Yes | Yes |
| Codebase Ingest (existing) | Yes | Yes | No (no /projects mount) |

#### 8.2 Docker Compose Updates

**`docker-compose.yml`** (local) — Add new environment variables:

```yaml
# Under ping-mem service environment:
- PING_MEM_AGENT_QUOTAS_ENABLED=true
- PING_MEM_EVIDENCE_GATES=enabled
- PING_MEM_COMPRESSION_ENABLED=false  # Requires OPENAI_API_KEY
```

**`docker-compose.prod.yml`** (VPS) — Add new environment variables:

```yaml
# Under ping-mem service environment:
- PING_MEM_AGENT_QUOTAS_ENABLED=true
- PING_MEM_EVIDENCE_GATES=enabled
- PING_MEM_COMPRESSION_ENABLED=${PING_MEM_COMPRESSION_ENABLED:-false}
```

#### 8.3 Deployment Pipeline

1. **Build**: `bun run typecheck && bun run build && bun test`
2. **Docker build**: `docker compose build ping-mem`
3. **Deploy to VPS**: `docker compose -f docker-compose.prod.yml up -d`
4. **Health check**: `curl -s https://ping-mem.ping-gadgets.com/health`
5. **Verify new tools**: `curl -s https://ping-mem.ping-gadgets.com/api/v1/knowledge/stats`

#### 8.4 Migration Script

```bash
#!/bin/bash
# scripts/migrate-v2.sh — Run schema migrations for v2.0.0
# Safe to run multiple times (all DDL uses IF NOT EXISTS)

PING_MEM_DB=${PING_MEM_DB_PATH:-$HOME/.ping-mem/events.db}

sqlite3 "$PING_MEM_DB" <<'SQL'
-- Agent identity
ALTER TABLE events ADD COLUMN agent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);

-- Write locks
CREATE TABLE IF NOT EXISTS write_locks (
  lock_key TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  metadata TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_write_locks_expires ON write_locks(expires_at);

-- Agent quotas
CREATE TABLE IF NOT EXISTS agent_quotas (
  agent_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  current_bytes INTEGER DEFAULT 0,
  current_count INTEGER DEFAULT 0,
  quota_bytes INTEGER DEFAULT 0,
  quota_count INTEGER DEFAULT 0,
  allowed_categories TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_agent_quotas_role ON agent_quotas(role);

-- Knowledge entries
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT NOT NULL,
  module TEXT,
  symptoms TEXT,
  root_cause TEXT,
  solution TEXT NOT NULL,
  prevention TEXT,
  code_examples TEXT,
  related_issues TEXT,
  severity TEXT,
  resolution_time TEXT,
  source_project TEXT NOT NULL,
  source_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  access_count INTEGER DEFAULT 0,
  updated_count INTEGER DEFAULT 0,
  usefulness_score REAL DEFAULT 0.0,
  superseded_by TEXT,
  status TEXT DEFAULT 'active',
  ingested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge_entries(source_project);
CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_entries(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge_entries(status);

-- Optimistic concurrency for relevance
-- (ALTER TABLE ADD COLUMN is safe to run if column exists — SQLite ignores duplicate)
-- Note: This will error if column exists. Use try-catch in actual migration code.
SQL

echo "Migration complete for $PING_MEM_DB"
```

**Note**: The `ALTER TABLE ... ADD COLUMN` for `agent_id` and `version` will
fail if the column already exists. The actual implementation in `EventStore.ts`
should use a migration table to track applied migrations:

```sql
CREATE TABLE IF NOT EXISTS migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

---

## Phased Implementation Plan

### Phase 1: Foundation (Week 1-2)

**Goal**: Agent identity + concurrent write safety. These are prerequisites for
multi-agent operation.

| Task | Files | Effort |
|------|-------|--------|
| 1.1 Add types (`AgentId`, `AgentRole`, etc.) | `src/types/index.ts` | 0.5d |
| 1.2 Extend `Memory` and `Event` interfaces | `src/types/index.ts`, `src/storage/EventStore.ts` | 0.5d |
| 1.3 Schema migration (agent_id, agent_quotas, write_locks) | `src/storage/EventStore.ts` | 1d |
| 1.4 Implement `WriteLockManager` | `src/storage/WriteLockManager.ts` (new) | 1d |
| 1.5 Wire agent identity into MemoryManager | `src/memory/MemoryManager.ts` | 1d |
| 1.6 Wire agent identity into SessionManager | `src/session/SessionManager.ts` | 0.5d |
| 1.7 Add MCP tools: `agent_register`, `agent_quota_status` | `src/mcp/PingMemServer.ts` | 1d |
| 1.8 Update REST endpoints with X-Agent-ID | `src/http/rest-server.ts` | 0.5d |
| 1.9 Write tests | `src/*/__tests__/` | 2d |
| **Total** | | **8d** |

### Phase 2: Data Quality (Week 3)

**Goal**: Structured schemas + evidence gates. Ensure high-quality memory data.

| Task | Files | Effort |
|------|-------|--------|
| 2.1 Implement Zod memory schemas | `src/validation/memory-schemas.ts` (new) | 1d |
| 2.2 Integrate schema validation into MemoryManager | `src/memory/MemoryManager.ts` | 0.5d |
| 2.3 Implement evidence gates | `src/validation/evidence-gates.ts` (new) | 1d |
| 2.4 Integrate evidence gates into MemoryManager | `src/memory/MemoryManager.ts` | 0.5d |
| 2.5 Update MCP/REST with new parameters | `src/mcp/PingMemServer.ts`, `src/http/rest-server.ts` | 0.5d |
| 2.6 Write tests | `src/*/__tests__/` | 1.5d |
| **Total** | | **5d** |

### Phase 3: Integration (Week 4)

**Goal**: Knowledge API + pub/sub. Connect ping-mem to Understory's knowledge
system and enable real-time coordination.

| Task | Files | Effort |
|------|-------|--------|
| 3.1 Implement KnowledgeStore | `src/knowledge/KnowledgeStore.ts` (new) | 1.5d |
| 3.2 Implement KnowledgeMapper | `src/knowledge/KnowledgeMapper.ts` (new) | 0.5d |
| 3.3 Add knowledge REST endpoints | `src/http/rest-server.ts` | 1d |
| 3.4 Add knowledge MCP tools | `src/mcp/PingMemServer.ts` | 0.5d |
| 3.5 Implement MemoryPubSub | `src/pubsub/MemoryPubSub.ts` (new) | 1.5d |
| 3.6 Add SSE stream endpoint | `src/http/rest-server.ts` | 0.5d |
| 3.7 Add webhook delivery | `src/pubsub/MemoryPubSub.ts` | 0.5d |
| 3.8 Wire pub/sub into MemoryManager | `src/memory/MemoryManager.ts` | 0.5d |
| 3.9 Write tests | `src/*/__tests__/` | 2d |
| **Total** | | **8.5d** |

### Phase 4: Intelligence (Week 5-6)

**Goal**: Semantic compression + deployment. Enable intelligent memory
management and ensure everything works in production.

| Task | Files | Effort |
|------|-------|--------|
| 4.1 Implement SemanticCompressor | `src/memory/SemanticCompressor.ts` (new) | 2d |
| 4.2 Integrate with RelevanceEngine | `src/memory/RelevanceEngine.ts` | 1d |
| 4.3 Add `memory_compress` MCP tool | `src/mcp/PingMemServer.ts` | 0.5d |
| 4.4 Update Docker Compose files | `docker-compose.yml`, `docker-compose.prod.yml` | 0.5d |
| 4.5 Migration script | `scripts/migrate-v2.sh` (new) | 0.5d |
| 4.6 Deploy and verify on VPS | - | 1d |
| 4.7 Write tests | `src/*/__tests__/` | 1.5d |
| 4.8 Integration test: 10-agent simulation | `src/__tests__/integration/` | 2d |
| **Total** | | **9d** |

### Total Estimate: 30.5 developer-days

---

## New MCP Tools Summary

| Tool | Phase | Description |
|------|-------|-------------|
| `agent_register` | 1 | Register agent with role and quotas |
| `agent_quota_status` | 1 | Check agent quota usage |
| `memory_subscribe` | 3 | Subscribe to memory events |
| `memory_unsubscribe` | 3 | Unsubscribe from memory events |
| `memory_compress` | 4 | Trigger semantic compression |
| `knowledge_search` | 3 | Semantic search knowledge entries |
| `knowledge_ingest` | 3 | Ingest Understory knowledge entries |

Total: 7 new MCP tools (36 existing + 7 = 43 total).

---

## New REST Endpoints Summary

| Method | Endpoint | Phase |
|--------|----------|-------|
| POST | `/api/v1/agents/register` | 1 |
| GET | `/api/v1/agents/quotas` | 1 |
| GET | `/api/v1/events/stream` | 3 |
| POST | `/api/v1/events/webhooks` | 3 |
| DELETE | `/api/v1/events/webhooks/:id` | 3 |
| POST | `/api/v1/knowledge/search` | 3 |
| POST | `/api/v1/knowledge/ingest` | 3 |
| GET | `/api/v1/knowledge/cross-project` | 3 |
| GET | `/api/v1/knowledge/stats` | 3 |

Total: 9 new REST endpoints.

---

## New Files Summary

| File | Purpose | Phase |
|------|---------|-------|
| `src/storage/WriteLockManager.ts` | Advisory lock manager | 1 |
| `src/validation/memory-schemas.ts` | Zod schemas for structured memories | 2 |
| `src/validation/evidence-gates.ts` | Evidence gate definitions | 2 |
| `src/knowledge/KnowledgeStore.ts` | Knowledge entry CRUD | 3 |
| `src/knowledge/KnowledgeMapper.ts` | KnowledgeEntry <-> Entity mapping | 3 |
| `src/pubsub/MemoryPubSub.ts` | Pub/sub for memory events | 3 |
| `src/memory/SemanticCompressor.ts` | LLM-powered semantic compression | 4 |
| `scripts/migrate-v2.sh` | Schema migration script | 4 |

Total: 8 new files.

---

## Backward Compatibility Requirements

1. **All existing MCP tools** continue to work without modification
2. **All existing REST endpoints** continue to work without modification
3. **All existing tests** pass without changes (zero regressions)
4. **Agent identity is optional** — omitting `agentId` treats memories as public
5. **Schema validation is opt-in** — `strictSchema` defaults to `false`
6. **Evidence gates are configurable** — can be disabled via environment variable
7. **Pub/sub is additive** — no existing behavior changes
8. **Compression is optional** — requires `OPENAI_API_KEY` to function
9. **Knowledge endpoints are new** — no collision with existing routes
10. **Migration is idempotent** — `IF NOT EXISTS` on all DDL

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Write lock contention under 10+ agents | Medium | High | Configurable lock timeout, per-key granularity, stale lock cleanup |
| LLM compression costs at scale | Medium | Medium | Compression is opt-in, batch processing, cache compressed results |
| Schema validation breaking existing workflows | Low | High | `strictSchema` defaults to `false`, backward compat is non-negotiable |
| SSE connection limits on VPS | Low | Medium | Connection pooling, max 50 concurrent SSE connections, webhook fallback |
| Migration failure on existing data | Low | Critical | Idempotent DDL, migration table tracking, backup before migrate |
| SQLite concurrent writers across Docker containers | Medium | High | Single writer container (ping-mem), readers via REST only |

---

## Dependencies on Existing Pending Work

The CLAUDE.md (lines 162-180) lists several pending issues. This spec has
dependencies on some of them:

| Pending Issue | Dependency | Action |
|--------------|------------|--------|
| Race conditions in MemoryManager/SessionManager | **Direct** — Section 2 resolves this | Fix as part of Phase 1 |
| SQL injection in EventStore.deleteSessions() | **Resolved** — parameterized queries already in place (lines 457-481) | No action needed |
| 20+ `any` types to eliminate | **Indirect** — new code must not introduce `any` | Enforce in code review |
| Missing rate limiting on HTTP endpoints | **Prerequisite for pub/sub** — SSE connections need limits | Add rate limiting in Phase 3 |
| CORS too permissive | **Resolved** — fixed in commit e4be720 | No action needed |
| Neo4j session leaks | **Indirect** — new knowledge graph operations must handle sessions | Use try-finally pattern in KnowledgeMapper |
| Input validation (Zod schemas) | **Synergy** — Section 3 adds Zod validation for memory schemas | Extend to all inputs |
