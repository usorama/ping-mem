# Integration Examples

## 1. Claude Code (stdio MCP)

In `~/.claude/mcp.json`:
```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "/Users/umasankr/Projects/ping-mem/dist/mcp/cli.js"],
      "env": {
        "PING_MEM_DB_PATH": "~/.claude/ping-mem.db",
        "PING_MEM_VECTOR_SEARCH": "false"
      }
    }
  }
}
```

## 2. Node.js (REST)

```typescript
import { createRESTClient } from "ping-mem/client";
const client = createRESTClient({ baseUrl: "http://localhost:3003" });
await client.startSession({ name: "my-app-session", projectDir: process.cwd() });
await client.save("user-pref", "dark-mode", { category: "note", priority: "high" });
const results = await client.search({ query: "theme", limit: 10 });
await client.close();
```

## 3. Python (REST API)

```python
import requests
BASE_URL = "http://localhost:3003"
response = requests.post(f"{BASE_URL}/session/start", json={"name": "python-session"})
session_id = response.json()["sessionId"]
requests.post(f"{BASE_URL}/context/save", json={
    "key": "decision", "value": "Use PostgreSQL", "category": "decision", "priority": "high"
}, headers={"X-Session-ID": session_id})
```

## 4. curl

```bash
BASE="http://localhost:3003"
SESSION=$(curl -s -X POST "$BASE/session/start" -H "Content-Type: application/json" \
  -d '{"name":"curl-session"}' | jq -r '.sessionId')
curl -X POST "$BASE/context/save" -H "Content-Type: application/json" -H "X-Session-ID: $SESSION" \
  -d '{"key":"auth-decision","value":"JWT with RS256","category":"decision","priority":"high"}'
curl "$BASE/context/search?query=auth&limit=5" -H "X-Session-ID: $SESSION"
```
