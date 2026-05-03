# S017 Structured Knowledge Graph Evidence

Date: 2026-05-03

## Outcome

S017 is complete for a finite codebase graph population.

The implementation adds a Structured Knowledge Graph answer module that returns
two explicitly different answer kinds:

- `complete_graph`: requires a declared population and returns denominator
  evidence before making any completeness claim.
- `semantic_neighborhood`: returns discovery-oriented relationship context and
  blocks completeness language.

## Implemented Surfaces

- `src/graph/StructuredKnowledgeGraph.ts`
- `src/validation/api-schemas.ts`
- `src/http/rest-server.ts`
- `src/cli/agent-trust.ts`
- `src/cli/commands/agent.ts`
- `src/graph/__tests__/StructuredKnowledgeGraph.test.ts`
- `src/http/__tests__/agent-rest.test.ts`
- `src/cli/__tests__/agent-trust.test.ts`

## Evidence Files

- `docs/evidence/ground-up-local-trust/S017-structured-knowledge-graph/complete_graph-answer.json`
- `docs/evidence/ground-up-local-trust/S017-structured-knowledge-graph/semantic_neighborhood-answer.json`

## Verification

Structural check:

```sh
rg -n 'complete_graph|semantic_neighborhood|denominator|sourceAnchors|provenance|Structured Knowledge Graph' src docs
```

Focused tests:

```sh
bun test src/graph/__tests__/StructuredKnowledgeGraph.test.ts
bun test src/http/__tests__/agent-rest.test.ts
bun test src/cli/__tests__/agent-trust.test.ts
```

Acceptance test sweep:

```sh
bun test src/graph src/http src/cli
```

Result: `635 pass, 0 fail`.

Typecheck:

```sh
bun run typecheck
```

Result: pass.

Live approved CLI proof was run against a source REST server on
`http://127.0.0.1:4317` so the new route was present:

```sh
bun run src/cli/index.ts agent graph answer --agent codex-local --project /Users/umasankr/Projects/ping-mem --mode complete_graph --json --server http://127.0.0.1:4317 --evidence-dir docs/evidence/ground-up-local-trust/S017-structured-knowledge-graph
```

Result: `ok: true`, `answerKind: complete_graph`, `nodeCount: 4`,
`edgeCount: 3`, `relationshipTypes: ["RELATED_TO"]`, and all source anchors
had `diskChecked: true`.

```sh
bun run src/cli/index.ts agent graph answer --agent codex-local --project /Users/umasankr/Projects/ping-mem --mode semantic_neighborhood --json --server http://127.0.0.1:4317 --evidence-dir docs/evidence/ground-up-local-trust/S017-structured-knowledge-graph
```

Result: `ok: true`, `answerKind: semantic_neighborhood`, no denominator, and
blocked claims explicitly state that the result is intentionally incomplete.

## Claim Boundary

Allowed claim: ping-mem can answer a complete graph relationship question over a
declared finite codebase population with denominator evidence, provenance,
relationship paths, freshness state, and disk-checked source anchors.

Blocked claim: this does not prove all repos, all languages, all agent/customer
history, optional MCP proxy graph usage, or exhaustive Neo4j-backed traversal.
