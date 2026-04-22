# ping-mem UAT Skill

## Purpose

Systematic UAT for ping-mem against a target codebase. Tests all features: semantic search, token reduction, context engineering, timeline, knowledge store, agent registration, health monitoring, and project integrity.

## Trigger

Use when the user says `/ping-mem-uat`, "UAT ping-mem", "test ping-mem features", or "verify ping-mem against [project]".

---

## Prerequisites

- ping-mem REST server running on port 3003
- Docker containers healthy: `docker ps | grep ping-mem`
- Target codebase already ingested (or run ingest first)

---

## Step 0: Setup & Configuration

```bash
# Confirm server health
curl -s http://localhost:3003/health

# Find target project ID from manifest
cat /path/to/project/.ping-mem/manifest.json | python3 -c "import sys,json; d=json.load(sys.stdin); print('projectId:', d['projectId']); print('files:', len(d['files']))"
```

If project not yet ingested:
```bash
curl -s -X POST http://localhost:3003/api/v1/codebase/ingest \
  -H "Content-Type: application/json" \
  -d '{"projectDir":"/projects/my-project","forceReingest":false}'
```

---

## Step 1: Health Check

```bash
curl -s http://localhost:3003/health | python3 -m json.tool
```

**Pass criteria**: `status: "ok"`, all components healthy (sqlite, neo4j, qdrant)

---

## Step 2: Project Integrity Verify

```bash
curl -s -X POST http://localhost:3003/api/v1/codebase/verify \
  -H "Content-Type: application/json" \
  -d '{"projectDir":"/projects/my-project"}' | python3 -m json.tool
```

**Pass criteria**: `valid: true`, `manifestTreeHash == currentTreeHash`

---

## Step 3: Semantic Code Search (3 queries)

```bash
PROJ_ID="<project-id>"

# Query 1: Core domain feature
curl -s "http://localhost:3003/api/v1/codebase/search?query=<feature-keyword>&limit=5&projectId=$PROJ_ID"

# Query 2: Infrastructure/data layer
curl -s "http://localhost:3003/api/v1/codebase/search?query=<data-layer-keyword>&limit=5&projectId=$PROJ_ID"

# Query 3: Error handling/edge cases
curl -s "http://localhost:3003/api/v1/codebase/search?query=error+exception+handling&limit=5&projectId=$PROJ_ID"
```

**Pass criteria**:
- Returns 5 results per query
- Top result score > 0.05 (deterministic vectorizer)
- Top-1 result is semantically related to the query (manual check)
- **Note**: Deterministic n-gram hash vectors work best with exact code identifiers. For semantic reasoning, use OpenAI/Gemini embeddings via `OPENAI_API_KEY`.

**Quality tiers**:
- Top-1 file contains query keywords → **good**
- Top-1 file is plausibly related → **acceptable**
- Top-1 file is unrelated → **finding** (document score + filePath)

---

## Step 4: Token Reduction Measurement

```python
import subprocess, json, urllib.request, urllib.parse, os

proj_id = "YOUR_PROJ_ID"
project_dir = "/path/to/project"
query = "authentication login token"  # adapt to domain

# Raw approach: count files containing keyword
result = subprocess.run(
    ["grep", "-r", "-l", query.split()[0], "--include=*.kt", "--include=*.swift",
     "--include=*.py", "--include=*.ts", project_dir],
    capture_output=True, text=True
)
raw_files = [f for f in result.stdout.strip().split("\n") if f]
raw_tokens = sum(len(open(f).read().split()) for f in raw_files if os.path.exists(f))

# ping-mem approach
url = f"http://localhost:3003/api/v1/codebase/search?query={urllib.parse.quote(query)}&limit=5&projectId={proj_id}"
with urllib.request.urlopen(url) as resp:
    data = json.loads(resp.read())
results = data.get("data", {}).get("results", [])
pm_tokens = sum(len(r.get("content","").split()) for r in results)

reduction = (1 - pm_tokens/raw_tokens)*100 if raw_tokens > 0 else 0
compression = raw_tokens/pm_tokens if pm_tokens > 0 else 0
print(f"Raw tokens: {raw_tokens:,} | ping-mem tokens: {pm_tokens:,}")
print(f"Token reduction: {reduction:.1f}% | Compression: 1:{compression:.0f}x")
```

**Pass criteria**: Token reduction > 80%, compression ratio > 5:1

---

## Step 5: Timeline (Commit History)

```bash
curl -s "http://localhost:3003/api/v1/codebase/timeline?projectId=$PROJ_ID&limit=5" | python3 -c "
import sys,json
raw=json.load(sys.stdin)
events = raw if isinstance(raw, list) else raw.get('data', raw.get('events', []))
if isinstance(events, dict): events = events.get('events', [])
print(f'Commits: {len(events)}')
for e in events[:5]:
    print(f'  {e.get(\"commitHash\",\"\")[:8]} | {e.get(\"date\",\"\")[:10]} | {e.get(\"message\",\"\")[:70]}')
"
```

**Pass criteria**: Returns commits with hash, date, message; no empty fields

---

## Step 6: Agent Registration & Quotas

```bash
# Register
curl -s -X POST http://localhost:3003/api/v1/agents/register \
  -H "Content-Type: application/json" \
  -d '{"agentId":"uat-test-001","role":"tester","ttlMs":3600000}' | python3 -m json.tool

# Check quota
curl -s "http://localhost:3003/api/v1/agents/quotas?agentId=uat-test-001" | python3 -m json.tool

# Deregister
curl -s -X DELETE http://localhost:3003/api/v1/agents/uat-test-001 | python3 -m json.tool
```

**Pass criteria**: Register returns `agentId` + `expiresAt`; quota shows `current_bytes: 0`; delete returns `quotaRowsDeleted: 1`

---

## Step 7: Knowledge Store

```bash
# Ingest a knowledge entry
curl -s -X POST http://localhost:3003/api/v1/knowledge/ingest \
  -H "Content-Type: application/json" \
  -d "{\"projectId\":\"$PROJ_ID\",\"title\":\"UAT Test Entry\",\"solution\":\"Test solution for UAT verification\",\"tags\":[\"uat\",\"test\"]}"

# Search (single-word FTS5 query works best)
curl -s -X POST http://localhost:3003/api/v1/knowledge/search \
  -H "Content-Type: application/json" \
  -d '{"query":"UAT","limit":3}' | python3 -m json.tool
```

**Pass criteria**: Ingest returns entry ID; search returns the ingested entry.

**Known limitation**: FTS5 multi-word queries may return 0 results — use single-word queries for reliable search. Multi-word FTS5 requires `"word1 word2"` syntax.

---

## Step 8: SSE Event Stream

```bash
timeout 2 curl -s "http://localhost:3003/api/v1/events/stream" 2>/dev/null | head -3 \
  || echo "SSE stream accessible (timeout expected for empty stream)"
```

**Pass criteria**: Endpoint responds (timeout expected for idle stream, not connection refused)

---

## Results Summary Template

```
=== ping-mem UAT Results — [DATE] ===
Target: [project-name] ([N] files)
Server: http://localhost:3003

PASS  Health Check     — sqlite/neo4j/qdrant all healthy
PASS  Project Verify   — valid=true, hashes match
PASS  Semantic Search  — [top-1 relevance notes]
PASS  Token Reduction  — XX.X% reduction, 1:Xx compression
PASS  Timeline         — N commits, dates YYYY-MM-DD to YYYY-MM-DD
PASS  Agent Reg/Quota  — register/quota/delete roundtrip ok
PASS  Knowledge Store  — ingest+search roundtrip ok
PASS  SSE Stream       — endpoint accessible

Known Limitations:
- Deterministic vectorizer (n-gram hash): best for exact code terms, not semantic reasoning
- Knowledge FTS5: multi-word queries unreliable; use single-word queries
- Session/context API: only exposed on MCP server (port 3000), not REST (port 3003)

Token Reduction Details:
- Query: "[query]"
- Raw (grep all files): X,XXX tokens across N files
- ping-mem (5 chunks): X,XXX tokens
- Reduction: XX.X% | Compression: 1:Xx
```

---

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| 503 on codebase endpoints | IngestionService not configured | Restart ping-mem-rest container |
| Empty search results | Project not ingested | Run `codebase/ingest` with `forceReingest: true` |
| `valid: false` on verify | Files changed since last ingest | Re-ingest project |
| Knowledge search returns 0 | Multi-word FTS5 query | Use single-word query |
| Session endpoints 404 | Session API is on MCP server, not REST | Use port 3000 (MCP/SSE) for sessions |
| Score < 0.05 on all results | Query has no code-identifier n-gram overlap | Include exact function/class names in query |

---

## Port Reference

| Port | Server | Features |
|------|--------|---------|
| 3003 | ping-mem-rest | codebase/*, agents/*, knowledge/*, health, events/stream |
| 3000 | ping-mem (MCP/SSE) | session/*, context/*, MCP stdio transport |
| 7687 | Neo4j Bolt | Direct graph queries |
| 6333 | Qdrant REST | Direct vector queries |
