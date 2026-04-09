# Debt Registry — ping-mem

All deferred capability items. Each must have a GitHub issue link. Created 2026-04-09.

## Active Deferrals

| Item | GH Issue | Deferred From | Why Deferred | Priority |
|------|----------|---------------|--------------|----------|
| Consumer for TRANSCRIPT_MINED events (trigger dreaming/indexing on new transcripts) | [GH#101](https://github.com/usorama/ping-mem/issues/101) | Full Capability Activation Plan Phase 2 | Consumer adds scope; Phase 2 delivers audit infrastructure foundation — consumer is follow-on | P2 |
| Consumer for RECALL_MISS events (adaptive recall threshold or context-gap suggestions) | [GH#102](https://github.com/usorama/ping-mem/issues/102) | Full Capability Activation Plan Phase 2 | Same rationale — event infrastructure is prerequisite; consumer is follow-on | P2 |
| LLMEntityExtractor: route DreamingEngine LLM calls through LLMProxy for Ollama fallback (GAP-M1 future fix) | — | Full Capability Activation Plan Phase 4 (docs-only) | DreamingEngine's Claude API dependency requires architectural LLMProxy changes beyond this plan's scope | P3 |
| SSEPingMemServer embeddingProvider field in /health | — | Full Capability Activation Plan Phase 4B | Prod uses REST transport only; SSE mode is dev-local. Parity is cosmetic. | P3 |

## Resolved Deferrals

*(none yet)*
