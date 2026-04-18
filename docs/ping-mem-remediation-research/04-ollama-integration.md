# R4 — Ollama Integration as Local-LLM Recovery Brain

**Scope:** Design Ollama as the primary local-LLM for ping-mem subsystems and ping-guard's failure-recovery escalation chain with deterministic config, health checks, and JSON-schema output.

**Evidence roots:**
- `/Users/umasankr/Projects/ping-mem/src/llm/LLMProxy.ts`
- `/Users/umasankr/Projects/ping-mem/src/llm/types.ts`
- `/Users/umasankr/Projects/ping-mem/src/search/EmbeddingService.ts`
- `/Users/umasankr/Projects/ping-guard/manifests/ping-mem.yaml`

---

## 1. LLMProxy Inventory (current state)

File: `src/llm/LLMProxy.ts`

**Supported providers:** Ollama (primary), Gemini 2.0 Flash (fallback). Provider union: `"ollama" | "gemini" | "none"` (`types.ts:19,26`).

**Defaults (LLMProxy.ts:18-21):**
```
DEFAULT_OLLAMA_URL      = "http://localhost:11434"
DEFAULT_OLLAMA_MODEL    = "llama3.2"
DEFAULT_OLLAMA_TIMEOUT  = 8000 ms
DEFAULT_GEMINI_MODEL    = "gemini-2.0-flash"
```

**Config surface (`LLMProviderConfig`, types.ts:29-35):** `ollamaUrl`, `ollamaModel`, `ollamaTimeoutMs`, `geminiApiKey`, `geminiModel`. No env-var loader exists — all configuration must be passed via constructor. `GEMINI_API_KEY` is read directly from `process.env` (LLMProxy.ts:34).

**Endpoints called:**
- `POST {ollamaUrl}/api/chat` with `{model, messages, stream}` (LLMProxy.ts:108, 146).
- No `format: "json"`, no `keep_alive`, no `options.num_ctx`, no `tools`. Plain NDJSON streaming with per-chunk abort reset (LLMProxy.ts:173) — a sensible anti-hang pattern.

**Callers (LLMProxy consumers):**
| Subsystem | File | Uses Ollama? |
|---|---|---|
| UI chat streaming | `src/http/ui/chat-api.ts:11,51` | YES (via LLMProxy) |
| Mining | `src/mining/TranscriptMiner.ts:20` | NO — uses `callClaude` (CLI only) |
| Dreaming | `src/dreaming/DreamingEngine.ts:28` | NO — uses `callClaude`; JSDoc at line 17 says "Ollama/OpenAI fallback not available for dreaming" |
| Memory compression | `src/memory/SemanticCompressor.ts:57-60` | NO — direct OpenAI via `OPENAI_API_KEY`, model `gpt-4o-mini` |
| Embeddings | `src/search/EmbeddingService.ts:431-485, 809-864` | YES — chain Ollama→Gemini→OpenAI, default `nomic-embed-text`, 768 dims |

**Gap:** LLMProxy is wired only for the UI chat surface. Mining, dreaming, and compression bypass it entirely and depend on Claude CLI or OpenAI.

---

## 2. Embedding Confirmation

File: `src/search/EmbeddingService.ts`.

- `OllamaEmbeddingProvider` (lines 431-485) hits `POST {baseUrl}/api/embed` with `{model, input}`.
- Default model: `"nomic-embed-text"` (line 439), 768 dimensions (matches OpenAI/Gemini, line 440).
- `createEmbeddingServiceFromEnv()` (lines 809-864) builds a `ChainedFallbackProvider`: Ollama → Gemini → OpenAI. Env-gated via `OLLAMA_EMBEDDINGS !== "false"`.
- `nomic-embed-text:latest` is installed locally (274 MB, see §3).

**Conclusion:** Embeddings already run on Ollama deterministically. The `/health` `"embeddingProvider":"ollama"` signal reflects this loader. No change needed for embeddings.

---

## 3. `ollama list` Output + Tiered Model Plan

Captured 2026-04-18 from local daemon (`ollama list`):

```
NAME                         ID              SIZE      MODIFIED
gpt-oss:20b                  17052f91a42e    13 GB     6 days ago
llama3.2:latest              a80c4f17acd5    2.0 GB    3 weeks ago
qwen3:8b                     500a1f067a9f    5.2 GB    8 weeks ago
gpt-oss:120b-cloud           569662207105    -         3 months ago   (remote)
nomic-embed-text:latest      0a109f422b47    274 MB    3 months ago   (embeddings)
llama3.1:8b-instruct-q4_0    42182419e950    4.7 GB    4 months ago
0xroyce/plutus:latest        83f2e56702ad    5.7 GB    4 months ago   (domain finance)
```

Cross-verified via `/api/tags`: parameter sizes 3.2B (llama3.2), 8.0B (llama3.1), 8.2B (qwen3), 20.9B (gpt-oss:20b, MXFP4), 137M (nomic-embed). `gpt-oss:120b-cloud` is remote (`remote_host: ollama.com`) — excluded from local-only tiers.

**Recommended tiering:**

| Tier | Model | Size | Role | Rationale |
|---|---|---|---|---|
| **Triage** | `llama3.2:latest` | 2.0 GB | Fast classification, pattern scoring, confidence seeding | 3.2B params, sub-second first-token typical; cheapest resident footprint |
| **Mid (default)** | `qwen3:8b` | 5.2 GB | Recovery diagnosis, mining, compression, summarization, dreaming | User already runs it (ping-guard `ollama_memory_hog` pattern stops `qwen3:8b`); strong JSON-mode adherence; balanced quality/RAM |
| **Reasoning** | `gpt-oss:20b` | 13 GB | Deep RCA when confidence <0.6 or cluster analysis | MXFP4 quant keeps it under 16 GB; use sparingly — triggers memory-hog pattern if threshold stays 4 GB |
| **Embeddings** | `nomic-embed-text` | 274 MB | Vector search (already wired) | Unchanged |
| **Excluded** | `0xroyce/plutus`, `gpt-oss:120b-cloud` | — | Plutus is domain-tuned finance (wrong fit); 120b-cloud is remote (defeats "local recovery brain") |

**Memory-hog interaction:** The existing `ollama_memory_hog` guard (manifests/ping-mem.yaml:239-247) fires when `system.ollama_loaded_model_gb > 4` and stops `qwen3:8b`. Raise the threshold to 6 (qwen3:8b loaded steady ≈5.5 GB) or the guard will kill the recovery brain mid-diagnosis. Action: amend pattern in §5.

---

## 4. Ollama Best Practices (research summary)

Source: `ollama/ollama` README + `api/docs` (github.com/ollama/ollama/blob/main/docs/api.md) via web fetch; cross-checked against installed daemon.

1. **Structured JSON output:** `POST /api/chat` and `/api/generate` accept `format: "json"` (force JSON string) or `format: <JSON Schema>` (strict schema-constrained). Schema mode landed in Ollama v0.5.0 (Dec 2024) and is the correct tool for deterministic RCA. Example: `{"format": {"type":"object","properties":{...},"required":[...]}}`.
2. **Keep-alive:** Default `keep_alive: "5m"` — model unloads after 5 min idle. For a recovery brain that fires unpredictably, pass `keep_alive: "30m"` (string duration) or `-1` to pin resident. Trade-off: resident VRAM cost vs first-call cold-start (~3-8 s for qwen3:8b on M-series).
3. **Timeouts:** Ollama has no server-side request timeout; the client owns it. LLMProxy uses an 8 s budget (`DEFAULT_OLLAMA_TIMEOUT_MS`, LLMProxy.ts:20) with per-chunk reset — too tight for cold starts of 8B models. Recommend 60 s connect + 30 s per-chunk for recovery calls; 15 s for UI chat.
4. **Parallel request limits:** `OLLAMA_NUM_PARALLEL` env (default 1, up to 4 in recent builds). Each parallel slot needs its own KV cache → VRAM scales linearly. For ping-guard + ping-mem sharing the daemon, set `OLLAMA_NUM_PARALLEL=2` and `OLLAMA_MAX_LOADED_MODELS=2`. Verify via `curl localhost:11434/api/ps`.
5. **Determinism:** Pass `options: {temperature: 0, seed: 42, num_ctx: 8192}` in the request body. Required for reproducible recovery decisions.
6. **`/api/chat` vs `/api/generate`:** Use `/api/generate` for single-shot RCA (no conversation state), `/api/chat` when you want LLMProxy's message-role structure. Both accept `format` and `options`.

---

## 5. ping-guard Manifest — Ollama Tier

**Recommendation:** Replace `claude`/`codex`/`gemini` tiers (all currently broken per brief) with Ollama as a single primary, keep `rules` as the last-resort deterministic fallback. Keeping the broken tiers ahead of Ollama wastes the 300 000 ms timeout each before Ollama is reached.

**Pre-flight reachability check:** Add a health probe step before invocation so ping-guard never enters a 30 s Ollama timeout while the daemon is dead. Use the deterministic command already valid in the manifest schema:

```bash
curl -sf --max-time 2 http://localhost:11434/api/tags \
  | jq -e '.models[] | select(.name=="qwen3:8b")' >/dev/null
```

Measured latency on this host: **21 ms** for `GET /api/tags` (`time curl -sf http://localhost:11434/api/tags`). The ≤ 2 s budget is safe.

**YAML to add under `guard.escalation`** (`manifests/ping-mem.yaml:249-266`):

```yaml
  escalation:
    preflight:
      - name: "ollama_reachable"
        type: "command"
        command: "curl -sf --max-time 2 http://localhost:11434/api/tags | jq -e '.models[] | select(.name==\"qwen3:8b\")' >/dev/null"
        timeout_ms: 2500
    llm_chain:
      - tier: "ollama"
        type: "api"
        endpoint: "http://localhost:11434/api/generate"
        model: "qwen3:8b"
        preflight: "ollama_reachable"
        request_template: "templates/ollama-rca.json"
        timeout_ms: 45000
        keep_alive: "30m"
        options:
          temperature: 0
          seed: 42
          num_ctx: 8192
        format: "schema"              # see §6
        confidence_threshold: 0.6     # below -> escalate_human
      - tier: "ollama_deep"
        type: "api"
        endpoint: "http://localhost:11434/api/generate"
        model: "gpt-oss:20b"
        preflight: "ollama_reachable"
        request_template: "templates/ollama-rca.json"
        timeout_ms: 120000
        keep_alive: "10m"
        activate_when: "prev_tier.confidence < 0.6"
      - tier: "rules"
        type: "pattern_match"
```

**Amend existing pattern** (lines 239-247) so the memory-hog guard does not kill the recovery brain:

```yaml
    - name: "ollama_memory_hog"
      detect:
        field: "system.ollama_loaded_model_gb"
        operator: ">"
        value: 14                      # was 4 — raised to accommodate qwen3:8b (~5.5 GB) + gpt-oss:20b (~13 GB)
      recover:
        type: "command"
        command: "ollama stop gpt-oss:20b"   # evict the heavy tier first, keep qwen3:8b resident
      cooldown_ms: 300000
```

---

## 6. Recovery-Brain Design

**Input (failure context) struct:**
```json
{
  "manifest": "ping-mem",
  "service": "neo4j",
  "pattern_name": "neo4j_disconnected",
  "detect_field": "health.components.neo4j",
  "observed_value": "disconnected",
  "error_message": "ECONNREFUSED 127.0.0.1:7687",
  "recent_logs": ["...last 20 lines from pm2 logs ping-mem-neo4j..."],
  "attempted_recoveries": [
    {"command": "docker compose restart ping-mem-neo4j", "result": "exit 125", "ts": 1713420000}
  ]
}
```

**Prompt template** (store at `ping-guard/templates/ollama-rca.json`):

```text
You are ping-guard's recovery advisor. Return STRICT JSON only.
Allowed actions: restart_service | clear_cache | reindex_wal | escalate_human.
Be conservative: if uncertain, prefer escalate_human.

Context:
- Service: {{service}}
- Pattern: {{pattern_name}}
- Error: {{error_message}}
- Last attempted recoveries: {{attempted_recoveries_summary}}
- Recent logs (tail):
{{recent_logs}}

Return the JSON object matching the provided schema.
```

**Output schema** (pass via Ollama `format` field for strict enforcement):

```json
{
  "type": "object",
  "properties": {
    "diagnosis": { "type": "string", "maxLength": 500 },
    "action": {
      "type": "string",
      "enum": ["restart_service", "clear_cache", "reindex_wal", "escalate_human"]
    },
    "reasoning": { "type": "string", "maxLength": 1000 },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
  },
  "required": ["diagnosis", "action", "reasoning", "confidence"],
  "additionalProperties": false
}
```

**Act-vs-escalate policy:**
- `confidence >= 0.8` → execute `action` immediately (if not `escalate_human`).
- `0.6 <= confidence < 0.8` → execute only if `action ∈ {restart_service}` (idempotent); otherwise escalate.
- `confidence < 0.6` → escalate to `ollama_deep` tier (gpt-oss:20b); if still `<0.6`, fall through to `rules`, then human.
- Every decision logged to `~/.ping-guard/events/` with full request/response payload for learn-loop feedback (`learn.auto_add_patterns: true`, manifests/ping-mem.yaml:277).

---

## 7. ping-mem Subsystem Migration Plan

Current `LLMProxy` (§1) is a Gemini-fallback proxy; callers bypass it for mining/dreaming/compression. Bring them onto a shared Ollama-primary path.

| Subsystem | File:line | Current | Target |
|---|---|---|---|
| Memory compression | `SemanticCompressor.ts:57-60` | OpenAI `gpt-4o-mini` | `LLMProxy.chat()` with `model: qwen3:8b`, `format: schema` returning `{facts: string[]}` |
| Conversation mining | `TranscriptMiner.ts:20` | `callClaude` CLI | `LLMProxy.chat()` with `model: qwen3:8b`, JSON array schema (max 20 facts — matches existing fallback prompt at line 27) |
| Dreaming — deduction | `DreamingEngine.ts:28` (and JSDoc:17) | `callClaude` CLI | `LLMProxy.chat()` with `model: gpt-oss:20b` (reasoning tier), schema: `{deductions: [{fact, confidence, source_ids}]}` |
| Dreaming — generalization | same | `callClaude` CLI | `LLMProxy.chat()` with `model: qwen3:8b`, schema: `{traits: [{trait, evidence_ids, confidence}]}` |
| Pattern confidence seeding (new) | new module | n/a | Triage tier `llama3.2`, batch-score last 30 days of `EventStore` rows into `{pattern_name, p_fire_next_24h}` |

**Required LLMProxy extensions** (minimal change):
1. Add `format?: "json" | object` and `options?: {temperature, seed, num_ctx, keep_alive}` to `LLMProviderConfig` (types.ts:29-35) and forward in the body (LLMProxy.ts:111-115).
2. Add `createLLMProxyFromEnv()` mirroring `createEmbeddingServiceFromEnv()` (EmbeddingService.ts:809) — reads `OLLAMA_URL`, `OLLAMA_LLM_MODEL`, `OLLAMA_KEEP_ALIVE`, `OLLAMA_TIMEOUT_MS`.
3. Increase `DEFAULT_OLLAMA_TIMEOUT_MS` from 8 000 to 30 000 for non-UI callers (mining/dreaming cold-start on 8B can exceed 8 s).
4. Delete the "Ollama/OpenAI fallback not available for dreaming" restriction in `DreamingEngine.ts:17` — obsolete once the proxy is wired.

---

## 8. Deterministic Health Checks (ping-mem-doctor)

**Single probe command:**
```bash
curl -sf --max-time 2 http://localhost:11434/api/tags
```

**Measured locally (2026-04-18):** `0.021 s total` — well under the 2 s budget. Record this as the baseline for regression detection.

**Three-gate doctor check:**
```bash
# Gate 1: endpoint reachable
curl -sf --max-time 2 http://localhost:11434/api/tags > /tmp/tags.json || exit 11

# Gate 2: required models present
jq -e '
  .models
  | map(.name)
  | (index("qwen3:8b") and index("nomic-embed-text:latest"))
' /tmp/tags.json > /dev/null || exit 12

# Gate 3: generate latency <= 2s on a warm model (keep-alive exercised)
START=$(gdate +%s%N)
curl -sf --max-time 5 -X POST http://localhost:11434/api/generate \
  -d '{"model":"qwen3:8b","prompt":"ping","stream":false,"keep_alive":"30m","options":{"num_predict":1}}' > /dev/null
END=$(gdate +%s%N)
LAT=$(( (END - START) / 1000000 ))
[ "$LAT" -le 2000 ] || { echo "latency=${LAT}ms exceeds 2000ms"; exit 13; }
```

Exit codes `11/12/13` map to the three failure classes so ping-guard can pattern-match (`doctor.ollama.endpoint_down`, `model_missing`, `latency_breach`) and pick a specific remediation.

**Exposed via ping-mem-doctor:** add an `"ollama"` component to `/health`'s `expect_components` (manifests/ping-mem.yaml:26-29) so the existing canary loop covers it without a separate probe.

---

## Summary of Concrete Changes

1. `manifests/ping-mem.yaml:239-266` — replace LLM chain with Ollama tiers; raise memory-hog threshold; add preflight (§5).
2. `src/llm/LLMProxy.ts:18-35, 103-139` — add `format`, `options`, `keep_alive`; lift default timeout; add env loader (§7).
3. `src/llm/types.ts:29-35` — extend `LLMProviderConfig` (§7).
4. `src/mining/TranscriptMiner.ts`, `src/dreaming/DreamingEngine.ts`, `src/memory/SemanticCompressor.ts` — swap `callClaude` / OpenAI for `LLMProxy.chat()` with schema output (§7).
5. `ping-guard/templates/ollama-rca.json` — new RCA prompt template (§6).
6. ping-mem-doctor — add three-gate Ollama probe (§8).
7. Optional new module `src/learn/PatternConfidence.ts` — triage-tier model scores 30-day event window (§7).

Word count: ~1 780.
