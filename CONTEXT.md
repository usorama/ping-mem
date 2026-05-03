# ping-mem Domain Context

## Structured Knowledge Graph

A product module that stores and answers over typed nodes and edges from codebase
context and agent/customer history. It must distinguish complete-graph answers
from semantic-neighborhood answers and return provenance, source anchors,
relationship paths, and denominator evidence.

## Semantic Neighborhood

A search answer based on relevance, embeddings, BM25, reranking, or partial graph
expansion. Useful for discovery, but not allowed to claim completeness.

## Complete Graph Answer

A graph answer over a declared finite population, such as one project, one
session, one corpus, one issue package, or one typed relationship family. It can
claim completeness only when it returns the denominator and provenance for the
population queried.

## Denominator Evidence

The explicit population used for a deterministic claim: total nodes scanned,
total edges scanned, relationship types included, source roots, ingestion run,
tree hash or corpus hash, and exclusions.

## Source Anchor

A checkable pointer to the originating evidence: file path and line range,
session id and event id, memory id, commit hash, issue path, or corpus inventory
hash.

## Capability Metrics Control Plane

The active restart context is now capability closure, not general feature work.
The scorecard generator at `scripts/capability-scorecard.mjs` produces JSON,
Markdown, and HTML dashboards under
`docs/evidence/ground-up-local-trust/capability-scorecard*/`.

Current live result: `94% yellow`, with relationship-lift evidence green but
live ping-mem discovery red because the approved wrapper and REST codebase
project inventory return `HTTP 503: Ingestion service not configured`.

When the user says "continue from where we left off", resume from:

1. restore live ingestion service readiness and honest health semantics;
2. inventory ping-mem's original capability surface and map every capability to
   objectives, outcomes, features, evidence, and claim boundaries;
3. expand the scorecard so every capability and feature has deterministic
   metrics;
4. fold the metrics dashboard into ping-mem's main UI if the UI exists;
5. rerun a side-by-side `rg` versus ping-mem benchmark that proves relationship
   lift with edges, provenance, freshness, source anchors, and denominator
   evidence.

GitHub tracker: `https://github.com/usorama/ping-mem/issues/135`
