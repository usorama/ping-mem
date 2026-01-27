# ping-mem Client SDK

TypeScript/JavaScript client SDK for accessing ping-mem functionality from your applications.

## Installation

```bash
npm install ping-mem
# or
bun add ping-mem
# or
pnpm add ping-mem
```

## Quick Start

### REST Client (Recommended for most use cases)

```typescript
import { createRESTClient } from "ping-mem/client";

// Create client
const client = createRESTClient({
  baseUrl: "https://ping-mem.example.com",
  apiKey: "your-api-key" // optional
});

// Start a session
await client.startSession({
  name: "my-application-session",
  projectDir: "/path/to/project"
});

// Save memories
await client.save("user-preferences", JSON.stringify({
  theme: "dark",
  language: "en"
}), {
  category: "note",
  priority: "high"
});

// Retrieve memories
const prefs = await client.get("user-preferences");
console.log(prefs.value); // {"theme":"dark","language":"en"}

// Search memories
const results = await client.search({
  query: "theme",
  category: "note",
  limit: 10
});

// Cleanup
await client.close();
```

### SSE Client (Real-time updates)

```typescript
import { createSSEClient } from "ping-mem/client";

// Create client with event handlers
const client = createSSEClient({
  baseUrl: "https://ping-mem.example.com",
  apiKey: "your-api-key",
  eventHandlers: {
    onOpen: () => console.log("Connected to ping-mem"),
    onError: (error) => console.error("Connection error:", error),
    onClose: () => console.log("Disconnected from ping-mem")
  }
});

// Connect to SSE server
await client.connect();

// Use same interface as REST client
await client.startSession({ name: "my-session" });
await client.save("key", "value");

// Close connection when done
await client.close();
```

## Client API

Both `RESTPingMemClient` and `SSEPingMemClient` implement the `PingMemClient` interface:

### Session Management

```typescript
// Start a new session
const session = await client.startSession({
  name: "my-session",
  projectDir: "/path/to/project",     // optional
  continueFrom: "previous-session-id", // optional
  defaultChannel: "main",              // optional
  metadata: { app: "my-app" }          // optional
});

// End current session
await client.endSession();

// List sessions
const sessions = await client.listSessions(10);
```

### Memory Operations

```typescript
// Save a memory
await client.save("key", "value", {
  category: "note",           // optional: task|decision|progress|note|error|warning
  priority: "high",           // optional: high|normal|low
  channel: "feature-abc",     // optional
  metadata: { source: "api" }, // optional
  private: false              // optional
});

// Get a memory by key
const memory = await client.get("key");

// Search memories
const results = await client.search({
  query: "search term",
  category: "note",           // optional filter
  channel: "feature-abc",     // optional filter
  priority: "high",           // optional filter
  limit: 10,                  // optional
  offset: 0,                  // optional
  sort: "relevance"           // optional
});

// Delete a memory
await client.delete("key");
```

### Checkpoint Operations

```typescript
// Create a checkpoint
await client.checkpoint({
  name: "checkpoint-name",
  description: "Before major refactoring", // optional
  includeFiles: true,                      // optional
  includeGitStatus: true                   // optional
});
```

### Status Operations

```typescript
// Get server status
const status = await client.getStatus();
console.log(status);
// {
//   eventStore: { totalEvents: 150 },
//   sessions: { total: 5, active: 2 },
//   currentSession: { id: "...", name: "...", ... }
// }
```

### Session Management

```typescript
// Get current session ID
const sessionId = client.getSessionId();

// Set session ID manually
client.setSessionId("session-id");

// Close client
await client.close();
```

## Configuration

### REST Client Options

```typescript
interface RESTClientConfig {
  baseUrl?: string;        // default: "http://localhost:3000"
  apiKey?: string;         // optional authentication
  timeout?: number;        // default: 30000 (30s)
  sessionId?: string;      // optional default session
  headers?: Record<string, string>; // additional headers
}
```

### SSE Client Options

```typescript
interface SSEClientConfig extends RESTClientConfig {
  sseEndpoint?: string;    // default: "/sse"
  eventHandlers?: {
    onOpen?: () => void;
    onMessage?: (event: MessageEvent) => void;
    onError?: (error: Event) => void;
    onClose?: () => void;
  };
}
```

## Error Handling

The client SDK provides specific error types:

```typescript
import {
  PingMemClientError,
  NetworkError,
  AuthenticationError,
  NotFoundError,
  ValidationError,
  ServerError
} from "ping-mem/client";

try {
  await client.get("non-existent-key");
} catch (error) {
  if (error instanceof NotFoundError) {
    console.error("Memory not found");
  } else if (error instanceof AuthenticationError) {
    console.error("Invalid API key");
  } else if (error instanceof ValidationError) {
    console.error("Invalid input:", error.details);
  } else if (error instanceof NetworkError) {
    console.error("Network error:", error.message);
  } else if (error instanceof ServerError) {
    console.error("Server error:", error.message, error.statusCode);
  }
}
```

## Advanced Usage

### Local Development

```typescript
import { createLocalRESTClient, createLocalSSEClient } from "ping-mem/client";

// Automatically uses http://localhost:3000
const client = createLocalRESTClient();
```

### Universal Client

```typescript
import { createClient } from "ping-mem/client";

// Auto-chooses REST or SSE based on config
const restClient = createClient({
  baseUrl: "https://ping-mem.example.com",
  transport: "rest" // or omit for default
});

const sseClient = createClient({
  baseUrl: "https://ping-mem.example.com",
  transport: "sse",
  eventHandlers: { onOpen: () => console.log("Connected") }
});
```

### Type Imports

```typescript
import type {
  Session,
  Memory,
  MemoryQuery,
  MemoryQueryResult,
  SessionConfig,
  ContextSaveOptions
} from "ping-mem/client";
```

## Browser Usage

The client SDK works in browsers via the fetch API:

```typescript
import { createRESTClient } from "ping-mem/client";

const client = createRESTClient({
  baseUrl: "https://ping-mem.example.com",
  apiKey: "your-api-key"
});

// Use in async function
async function savePreference(key: string, value: string) {
  await client.save(key, value, { category: "note" });
}
```

## Node.js Usage

Works the same in Node.js 18+ (which has native fetch):

```typescript
import { createRESTClient } from "ping-mem/client";

const client = createRESTClient({
  baseUrl: "https://ping-mem.example.com",
  apiKey: process.env.PING_MEM_API_KEY
});

// Use in your backend
app.post("/api/save", async (req, res) => {
  await client.save(req.body.key, req.body.value);
  res.json({ success: true });
});
```

## TypeScript Support

Full TypeScript support with type definitions included:

```typescript
import { createRESTClient, type Memory, type Session } from "ping-mem/client";

const client = createRESTClient();

// Fully typed
const memory: Memory = await client.get("key");
const session: Session = await client.startSession({ name: "test" });
```

## License

MIT
