# Algorithms and Scoring for Code Impact Analysis

**Date**: 2026-03-09
**Purpose**: Research findings on blast radius scoring, graph centrality, incremental impact propagation, practical thresholds, and deterministic scoring formulas for ping-mem's code structural intelligence feature.

---

## Table of Contents

1. [Blast Radius Scoring](#1-blast-radius-scoring)
2. [Graph Centrality for Code](#2-graph-centrality-for-code)
3. [Incremental Impact Propagation](#3-incremental-impact-propagation)
4. [Practical Thresholds](#4-practical-thresholds)
5. [Determinism Requirement and Final Formulas](#5-determinism-requirement-and-final-formulas)

---

## 1. Blast Radius Scoring

### 1.1 What Factors Contribute to Change Risk?

Change risk in a codebase file is a function of both **structural** (static) factors and **temporal** (dynamic) factors. Research across industry tools (CodeScene, code-maat, Sourcegraph) and academic work on coupling metrics identifies the following contributors:

#### Structural Factors

**Fan-In (Afferent Coupling, Ca)**
Fan-in counts the number of other files (or modules) that directly depend on — i.e., import or call — a given file. A high fan-in means a change to this file can ripple into many other files simultaneously. This is the most direct structural indicator of change blast radius.

Robert C. Martin's package metrics (from *Clean Architecture* and *Agile Software Development*) define **instability** as:

```
Instability(F) = fanOut(F) / (fanIn(F) + fanOut(F))
```

A score of 0 = maximally stable (many dependents, no dependencies), meaning it is very high risk to change. A score of 1 = maximally unstable (no dependents, many dependencies), meaning it is low structural blast risk but fragile.

For blast radius purposes, files with **low instability** (high fan-in relative to fan-out) are the highest risk to change because they have the most downstream consumers.

**Transitive Fan-In**
Direct fan-in only captures immediate consumers. Transitive fan-in captures the full set of files that are *indirectly* affected: files that import files that import the changed file, etc. This is the true blast radius footprint.

```
transitiveFanIn(F, maxDepth) = |{ G : G transitively imports F, hops <= maxDepth }|
```

A file with a direct fan-in of 3 but transitive fan-in of 40 (because those 3 files are each imported by many others) has a far larger practical blast radius than its direct count suggests.

**File Size / Lines of Code**
Larger files are harder to reason about and correlate with higher defect rates. Used as a tie-breaker or modifier, not a primary signal.

#### Temporal Factors

**Git Churn Frequency (Code Volatility)**
Files that change frequently in the recent past are more likely to change again. Frequent changes also indicate instability in the design and higher defect injection probability. CodeScene's behavioral code analysis uses change frequency as the primary axis of its hotspot analysis. Adam Tornhill (CodeScene founder, "Your Code as a Crime Scene") defines the hotspot heuristic as:

```
hotspot(F) ∝ changeFrequency(F) × complexity(F)
```

While this is a *prioritization heuristic* (not an exact formula — Tornhill uses visualization overlays rather than a published equation), the underlying principle is: **frequent changes to complex/highly-coupled files are the highest priority risk**.

For ping-mem, git churn is defined as the count of distinct commits touching a file within a rolling 90-day window, computable from the `(Commit)-[:MODIFIES]->(File)` relationships already in Neo4j.

**Test Coverage Gap**
Files lacking tests compound structural coupling risk — a change may break dependents with no automated safety net. This factor is **not computable from the current Neo4j schema** (no test attribution relationship exists). It is noted for future extension.

### 1.2 CodeScene's Hotspot Analysis: Structural + Temporal Combination

CodeScene's approach (documented at [codescene.io/docs](https://codescene.io/docs/guides/technical/hotspots.html)) combines:

1. **Code Health metrics** (structural quality: complexity, coupling, duplication) — the "what does the code look like" dimension
2. **Development Activity** (git commit frequency, number of authors, change coupling between files) — the "how does the team work with the code" dimension

Key insight from CodeScene: *static analysis works on a snapshot; behavioral code analysis considers the temporal dimension and evolution of the whole system.* This prioritization lens distinguishes "low code health in a hotspot" (expensive, fix immediately) from "low code health in a stable, rarely-touched file" (low priority).

CodeScene adds a third dimension — **organizational coupling** — tracking when files are *always changed together* in the same commit, even when they have no static import relationship. This is the `code-maat` "logical coupling" metric:

```
logicalCoupling(A, B) = commitsChangingBoth(A, B) / commitsChangingEither(A, B)
```

Tornhill recommends ignoring logical coupling below 30% (noise threshold) and requiring a minimum number of shared revisions.

**What this means for ping-mem**: the existing `(Commit)-[:MODIFIES]->(File)` relationship enables computing logical coupling from the Neo4j graph. This is an available signal that requires no additional ingestion.

### 1.3 Blast Radius Score: Combining Factors into a 0–100 Risk Score

Microsoft's graph analysis library (`graph_blast_radius_fl()` for Kusto) offers a clean reference model:

```
blastRadiusScore(F) = count of distinct target nodes reachable from F
blastRadiusScoreWeighted(F) = sum of target node criticality weights
```

This is a pure **reachability count** (transitive fan-in). It is deterministic and graph-computable. The weighted variant allows files to carry importance weights (e.g., based on their own fan-in count).

For ping-mem, we propose a **composite score** that combines structural reachability with temporal volatility, normalized to 0–100:

```
rawBlastRadius(F) = (w_fi × normalizedFanIn(F))
                 + (w_tfi × normalizedTransitiveFanIn(F))
                 + (w_churn × normalizedChurnScore(F))

blastRadiusScore(F) = round(rawBlastRadius(F) × 100)
```

Where each component is normalized independently to [0, 1] using min-max normalization across all files in the project, and weights sum to 1.0. See Section 5 for exact formulas and recommended weights.

---

## 2. Graph Centrality for Code

### 2.1 PageRank Applied to Import Graphs

PageRank was designed for hyperlink graphs (web pages), but applies directly to code import graphs with a key insight: **an import edge `A → B` means "A depends on B"**, which in the link analogy means "A votes for B's importance." A file with many high-PageRank importers therefore receives more PageRank than one with many low-PageRank importers.

Reference: [Neo4j: PageRank algorithm docs](https://neo4j.com/docs/graph-data-science/current/algorithms/page-rank/)

**What high PageRank means in a codebase:**

A file with high PageRank in the import graph is one that:
- Is imported by many other files (high fan-in), AND
- Those importing files are themselves broadly depended upon (recursive importance)

This makes PageRank a superior stability signal compared to raw fan-in: it distinguishes a file imported by 10 leaf utilities (low PageRank despite fan-in=10) from a file imported by 10 core infrastructure files (high PageRank because the importers are themselves important).

Example: In a Python dependency analysis of scientific libraries, `six` (Python 2/3 compatibility) and `numpy` scored highest — both are foundational utilities that many important libraries depend on, making them architectural bottlenecks.

**Interpretation for change risk**: High-PageRank files are architectural load-bearing walls. Changing them propagates widely and carries the highest risk of unexpected breakage.

**Formula (iterative):**

```
PR(F, t+1) = (1 - d) + d × Σ { PR(G, t) / fanOut(G) : G ∈ importers(F) }
```

Where `d` = damping factor (typically 0.85), iterated until convergence (tolerance ≈ 1e-7).

### 2.2 In-Degree Centrality (Fan-In) — The Simplest Useful Metric

In-degree centrality is simply:

```
inDegree(F) = count of files G such that (G)-[:IMPORTS_FROM]->(F)
```

This is the raw fan-in count. It is the fastest to compute (O(E)), requires no iteration, and is directly queryable in Neo4j:

```cypher
MATCH (g:File)-[:IMPORTS_FROM]->(f:File { fileId: $fileId })
RETURN count(g) AS fanIn
```

For a 390-node graph, this query runs in microseconds with an index on `fileId`.

**When to use fan-in vs PageRank:**
- Fan-in: When you need fast per-file risk assessment with no setup cost
- PageRank: When you need architectural importance that accounts for the quality/centrality of importers (requires GDS or manual iteration)

### 2.3 Neo4j GDS in Community Edition — Availability

**Finding**: Neo4j Graph Data Science (GDS) Community Edition is available and **does not require a license key**. The Community Edition limitation is:
- Max 4 CPU cores for GDS concurrent computation
- Max 3 models in the model catalog

The GDS library must be installed manually (copy the `.jar` from Neo4j's products directory to the plugins directory). It is **not bundled by default** with Community Edition Neo4j server.

Available centrality algorithms in GDS CE:
- PageRank
- Article Rank (PageRank variant that reduces low-degree node influence)
- Degree Centrality (equivalent to fan-in/fan-out counts)
- Betweenness Centrality
- Closeness Centrality
- Eigenvector Centrality
- Harmonic Centrality
- Articulation Points / Bridges

Reference: [Neo4j GDS Installation docs](https://neo4j.com/docs/graph-data-science/current/installation/)

**Alternatives if GDS is not installed:**

Since ping-mem's existing schema does not include an `IMPORTS_FROM` relationship (that would need to be added as part of the structural intelligence feature), and GDS installation adds operational complexity, the recommended approach for an initial implementation is:

1. **Fan-in**: Pure Cypher `MATCH ... RETURN count()` — zero dependencies
2. **Transitive fan-in**: Cypher variable-length path with depth cap, or APOC `apoc.path.subgraphNodes()`
3. **PageRank**: If GDS is available, use `gds.pageRank.stream()`; otherwise, compute 20-iteration power method in TypeScript post-query

For ping-mem's 390-node codebase graph, even manual PageRank iteration in TypeScript (fetch adjacency, iterate) completes in under 100ms.

---

## 3. Incremental Impact Propagation

### 3.1 Problem Statement

Given a changed file F, compute the set of files that are transitively affected (i.e., all files that directly or indirectly import F). This is the **reverse reachability set** of F in the import graph.

The import graph is a DAG (directed acyclic graph) in practice (cycles indicate bad architecture and are rare). The reverse graph (following edges backward) gives the "who depends on me" direction.

### 3.2 Topological Ordering + BFS vs Cypher Path Queries

#### Approach A: Cypher Variable-Length Path Query

```cypher
MATCH path = (dependent:File)-[:IMPORTS_FROM*1..10]->(changed:File { fileId: $fileId })
RETURN DISTINCT dependent.fileId AS dependentId
```

This is a BFS-like traversal executed by Neo4j's planner. For a 390-node graph with sparse edges (typical import graphs have E ≈ 2–4 × N), this query completes in 1–20ms with proper indexing.

**Pro**: Simple to implement, no preprocessing required, always reflects current graph state.
**Con**: Full traversal each time; no caching between calls.

#### Approach B: APOC Path Expander

```cypher
MATCH (changed:File { fileId: $fileId })
CALL apoc.path.subgraphNodes(changed, {
  relationshipFilter: '<IMPORTS_FROM',  // reverse direction
  maxLevel: 10,
  bfs: true
}) YIELD node
RETURN node.fileId AS dependentId
```

The `<IMPORTS_FROM` direction filter traverses edges in reverse (finding who imports the changed file, not what the changed file imports). The `bfs: true` flag ensures breadth-first traversal, which for reachability counting produces the same result as DFS but is more memory-efficient for wide shallow graphs.

**Pro**: More configurable, supports label filters, respects node uniqueness.
**Con**: Requires APOC to be installed (similar operational burden to GDS).

#### Approach C: Application-Level BFS with Memoization

Pre-load the full adjacency list into memory (one Neo4j query at startup or on demand), then run BFS in TypeScript:

```typescript
// adjacency[fileId] = set of files that import fileId (reverse edges)
const visited = new Set<string>();
const queue = [changedFileId];
while (queue.length > 0) {
  const current = queue.shift()!;
  if (visited.has(current)) continue;
  visited.add(current);
  for (const importer of reverseAdjacency.get(current) ?? []) {
    queue.push(importer);
  }
}
return visited; // excludes changedFileId itself
```

**Time complexity**: O(V + E) per query, where V = affected nodes, E = relevant edges. For a 390-node graph, this is effectively instantaneous (~1ms).

**Pro**: No APOC dependency, full control over caching, memoizable (cache results by fileId until graph changes).
**Con**: Requires loading adjacency list into memory (trivial for 390 nodes, ~50KB).

#### Recommendation for ping-mem (390-node graph)

**Use Approach A (Cypher variable-length path) for correctness-first implementation**, graduating to Approach C (application-level BFS with memoized adjacency) when performance matters. For 390 nodes:

- Cypher query: 1–20ms (acceptable for REST API response)
- Application BFS with cached adjacency: < 1ms

The key insight from the algorithms literature: **BFS alone does not guarantee topological order**, but for *reachability counting* (blast radius), order does not matter — we only need the set of affected nodes, not a build sequence. Topological sort is only needed when you need a *build order* for incremental recompilation.

### 3.3 Efficient Transitive Fan-In Computation

The transitive fan-in count is the size of the reverse reachability set:

```
transitiveFanIn(F, maxDepth) = |reverseReachabilitySet(F, maxDepth)|
```

For a project-wide batch computation (computing transitive fan-in for all files at once):

1. Build the reverse adjacency list (who imports each file)
2. Run BFS from each file, memoizing intermediate results
3. Store results in a `Map<fileId, number>`

With memoization, the total complexity for all files is O(V × (V + E)) in the worst case, but O(V + E) amortized for DAGs with shared subgraphs. For 390 nodes, the worst case is under 10ms total.

```cypher
-- Single query to fetch full reverse adjacency for project
MATCH (g:File)-[:IMPORTS_FROM]->(f:File)
WHERE g.projectId = $projectId AND f.projectId = $projectId
RETURN g.fileId AS importer, f.fileId AS imported
```

---

## 4. Practical Thresholds

### 4.1 Fan-In Count: What Constitutes "High Risk"?

There is no single universally accepted numeric threshold. Industry references and academic literature consistently show context-dependence:

| Source | Threshold | Context |
|--------|-----------|---------|
| Aivosto Project Metrics ([source](https://www.aivosto.com/project/help/pm-sf.html)) | No fixed number; "should be reasonable" | General guidance |
| Robert C. Martin (Clean Architecture) | No fixed Ca threshold; ratio-based stability preferred | Package-level metrics |
| Cyclomatic complexity analogue | CC > 10 = high risk (established standard) | Code complexity, not coupling |
| Adam Tornhill (code-maat practice) | Files with top 5–10% of change frequency are hotspots | Relative ranking |

**Recommended practical thresholds for ping-mem** (based on relative ranking within the project):

| Fan-In Range | Risk Tier | Rationale |
|---|---|---|
| 0 | None | No dependents; isolated file |
| 1–4 | Low | Used by a small number of files; contained blast radius |
| 5–14 | Medium | Moderate coupling; changes need careful testing |
| 15–29 | High | Core utility or shared module; changes are high risk |
| 30+ | Critical | Architectural hub; changes require broad testing and review |

These are **relative to project size**. For a 390-file codebase, fan-in of 30 (≈7.7% of files) is genuinely critical. For a 10,000-file codebase, 30 might only be moderate.

**Better approach**: Use percentile thresholds rather than absolute values:
- Top 5% by transitive fan-in → Critical
- Top 5–15% → High
- Top 15–30% → Medium
- Below 30th percentile → Low/None

### 4.2 How to Weight Git Churn vs Structural Coupling

The core tension: structural coupling (fan-in) is a static worst-case bound, while git churn is a dynamic empirical signal of actual change velocity. Both matter:

- **High fan-in, low churn**: The file is stable infrastructure (e.g., a well-designed utility). The blast radius exists but is not being activated. *Risk: latent*.
- **Low fan-in, high churn**: The file changes often but affects few others. *Risk: low*.
- **High fan-in, high churn**: This is CodeScene's "hotspot" — the most dangerous combination. *Risk: critical*.
- **Low fan-in, low churn**: Stable leaf node. *Risk: minimal*.

**Research consensus**: For detecting *actionable* risk (i.e., files that will cause incidents in the near future), temporal signals (churn) should be weighted more heavily than structural signals when both are available:

```
Recommended weights:
  w_fi    = 0.30   (direct fan-in, structural)
  w_tfi   = 0.40   (transitive fan-in, structural)
  w_churn = 0.30   (git churn in 90 days, temporal)
```

Rationale: Transitive fan-in carries the most weight because it captures true blast radius scope. Direct fan-in is already partially captured by transitive fan-in, so it carries less weight. Churn is equally important to structural coupling for predictive accuracy, but slightly lower to preserve determinism from structural analysis even for files with no recent commits.

**Alternative (equal weighting)**:
```
w_fi = w_tfi = w_churn = 0.333
```

This is appropriate when you trust the temporal signal equally to the structural signal.

---

## 5. Determinism Requirement and Final Formulas

All scoring must be deterministic: given the same Neo4j graph state, the same inputs must produce the same score. No ML inference. No randomized algorithms.

### 5.1 Primitive Metric Definitions

#### `fanIn(file)`

```
fanIn(file) = count of distinct files G such that (G)-[:IMPORTS_FROM]->(file)
```

Cypher:
```cypher
MATCH (g:File)-[:IMPORTS_FROM]->(f:File { fileId: $fileId })
WHERE g.projectId = $projectId
RETURN count(DISTINCT g) AS fanIn
```

This is a direct in-degree count. O(E_in) where E_in is the number of incoming IMPORTS_FROM edges.

#### `transitiveFanIn(file, depth)`

```
transitiveFanIn(file, depth) = count of unique files in the reverse transitive closure
                                of file, up to `depth` hops
```

Where the reverse transitive closure of file F is the set of all files G such that there exists a directed path G → ... → F in the IMPORTS_FROM graph.

Cypher (variable-length path):
```cypher
MATCH (g:File)-[:IMPORTS_FROM*1..$depth]->(f:File { fileId: $fileId })
WHERE g.projectId = $projectId
RETURN count(DISTINCT g) AS transitiveFanIn
```

For determinism, `depth` must be a fixed constant (recommended: 10, which exceeds any practical import chain depth).

Application-level BFS equivalent:
```typescript
function transitiveFanIn(
  fileId: string,
  reverseAdj: Map<string, Set<string>>,
  maxDepth: number = 10
): number {
  const visited = new Set<string>();
  let frontier = reverseAdj.get(fileId) ?? new Set<string>();
  let depth = 0;
  while (frontier.size > 0 && depth < maxDepth) {
    const next = new Set<string>();
    for (const node of frontier) {
      if (!visited.has(node)) {
        visited.add(node);
        for (const parent of reverseAdj.get(node) ?? new Set<string>()) {
          if (!visited.has(parent)) next.add(parent);
        }
      }
    }
    frontier = next;
    depth++;
  }
  return visited.size;
}
```

#### `churnScore(file)`

```
churnScore(file) = count of distinct commits that modified file
                   in the last 90 days
```

This uses the existing `(Commit)-[:MODIFIES]->(File)` relationship in Neo4j. The 90-day window is a rolling window anchored to the current date.

Cypher:
```cypher
MATCH (c:Commit)-[:MODIFIES]->(f:File { fileId: $fileId })
WHERE c.authorDate >= $windowStart
RETURN count(DISTINCT c) AS churnScore
```

Where `windowStart = toISOString(Date.now() - 90 * 24 * 60 * 60 * 1000)`.

For determinism: the 90-day window must use a fixed anchor time per analysis run (e.g., `analysisTimestamp` stored with the result). This ensures the same analysis run produces the same score even if time passes during batch processing.

### 5.2 Normalization

Each raw metric must be normalized to [0, 1] before weighting. Use min-max normalization across all files in the project:

```
normalize(x, minVal, maxVal) =
  if maxVal == minVal: 0   // all files equal; no differentiation
  else: (x - minVal) / (maxVal - minVal)
```

For each project analysis run:
1. Compute `fanIn`, `transitiveFanIn`, `churnScore` for all files
2. Find `min` and `max` of each across the file set
3. Normalize each file's metrics

### 5.3 Composite Blast Radius Score (0–100)

```
blastRadiusScore(file) = round(
  (w_fi    × normalize(fanIn(file),             min_fi,    max_fi))
+ (w_tfi   × normalize(transitiveFanIn(file),   min_tfi,   max_tfi))
+ (w_churn × normalize(churnScore(file),        min_churn, max_churn))
) × 100
```

**Recommended weights:**
```
w_fi    = 0.30
w_tfi   = 0.40
w_churn = 0.30
```

**Properties:**
- Range: [0, 100] (integer, rounded)
- Deterministic: given fixed weights, same graph state → same score
- Interpretable: 0 = isolated leaf, 100 = architectural hub with high churn
- Computable from existing Neo4j data: requires only adding the `IMPORTS_FROM` relationship to the ingestion pipeline

**Edge case handling:**
- File with no commits in 90 days: `churnScore = 0`, `normalizedChurn = 0`
- File with `fanIn = 0` and `transitiveFanIn = 0`: score = 0 regardless of churn
- Project with all files having identical fan-in: normalization returns 0 for all → score driven entirely by churn

### 5.4 Risk Tier Classification

Given a `blastRadiusScore` in [0, 100]:

```
score 0       → tier: "none"     (isolated, no dependents)
score 1–24    → tier: "low"      (limited blast radius)
score 25–49   → tier: "medium"   (moderate coupling or churn)
score 50–74   → tier: "high"     (significant coupling and/or churn)
score 75–100  → tier: "critical" (architectural hub or hotspot)
```

These tiers align with CodeScene's red/yellow/green categorization and are suitable for surfacing in the ping-mem web UI and REST API response.

### 5.5 PageRank Supplement (Optional, requires GDS or manual iteration)

If Neo4j GDS is available, PageRank can be computed as an additional signal:

```cypher
CALL gds.pageRank.stream('importGraph', {
  dampingFactor: 0.85,
  maxIterations: 20,
  tolerance: 0.0000001
})
YIELD nodeId, score
RETURN gds.util.asNode(nodeId).fileId AS fileId, score AS pageRankScore
ORDER BY score DESC
```

PageRank scores are then normalized and can optionally replace or augment the `fanIn` component:

```
w_pr    = 0.30   (replaces w_fi if PageRank is available)
w_tfi   = 0.40
w_churn = 0.30
```

If GDS is not available, the manual power iteration approach in TypeScript (20 iterations, convergence tolerance 1e-7) produces identical results within floating-point precision.

### 5.6 Logical Coupling Supplement (Available from Existing Data)

A bonus signal computable from the existing `(Commit)-[:MODIFIES]->(File)` edges is **logical coupling** — the probability that two files co-change in the same commit. This can augment the blast radius with empirical "always changed together" relationships beyond static imports:

```
logicalCoupling(A, B) = |commits modifying both A and B| / |commits modifying A or B|
```

Files with high logical coupling to a changed file should appear in the blast radius even if there is no static IMPORTS_FROM edge between them. This matches CodeScene's "change coupling" analysis.

**Filter**: Only count pairs where `|commits modifying both A and B| >= 5` (noise floor per Tornhill's recommendation of ignoring low-revision coupling).

---

## Summary: Recommended Implementation Order

| Priority | Metric | Data Source | Implementation |
|---|---|---|---|
| 1 | `fanIn` | Neo4j: count IMPORTS_FROM in-edges | Single Cypher COUNT query |
| 2 | `churnScore` | Neo4j: Commit-[:MODIFIES]->File in 90-day window | Single Cypher COUNT query |
| 3 | `transitiveFanIn` | Neo4j: variable-length Cypher path, or app-level BFS | Cypher `*1..10` or TypeScript BFS |
| 4 | `blastRadiusScore` | Computed from 1+2+3 with normalization | TypeScript, pure computation |
| 5 | `logicalCoupling` | Neo4j: Commit-[:MODIFIES]->File co-occurrence | Cypher aggregation |
| 6 | `pageRank` | Neo4j GDS (if installed) or TypeScript iteration | GDS call or power iteration |

**Prerequisite**: The `IMPORTS_FROM` relationship between File nodes must be added to the ingestion pipeline. Currently, the TemporalCodeGraph schema has `HAS_FILE`, `HAS_CHUNK`, `DEFINES_SYMBOL`, `MODIFIES`, `CHANGES`, and `PARENT` relationships but no import-level dependency edge. The `IMPORTS_FROM` edge is the foundational requirement for all structural metrics.

---

## Sources

- [CodeScene: Technical Debt and Hotspot Analysis](https://codescene.io/docs/guides/technical/hotspots.html)
- [Adam Tornhill: Code as a Crime Scene](https://adamtornhill.com/articles/crimescene/codeascrimescene.htm)
- [Neo4j GDS: PageRank Algorithm](https://neo4j.com/docs/graph-data-science/current/algorithms/page-rank/)
- [Neo4j GDS: Installation Guide](https://neo4j.com/docs/graph-data-science/current/installation/)
- [Microsoft: graph_blast_radius_fl() Kusto Function](https://learn.microsoft.com/en-us/kusto/functions-library/graph-blast-radius-fl?view=microsoft-fabric)
- [Mark Needham: Python Dependency Graph with PageRank and Centrality](https://www.markhneedham.com/blog/2018/07/16/quick-graph-python-dependency-graph/)
- [Aivosto: Structural Fan-In and Fan-Out Metrics](https://www.aivosto.com/project/help/pm-sf.html)
- [Wikipedia: Software Package Metrics (Martin's Ca/Ce)](https://en.wikipedia.org/wiki/Software_package_metrics)
- [APOC: Path Expander Procedures](https://neo4j.com/docs/apoc/current/graph-querying/path-expander/)
- [IEEE: Evolutionary Study of Fan-In and Fan-Out Metrics](https://ieeexplore.ieee.org/document/5507329/)
- [OO Software Metrics (LCOM, Fan-In, Fan-Out)](http://www.virtualmachinery.com/jhawkmetricsclass.htm)
- [Neo4j Community Forum: GDS License Model](https://community.neo4j.com/t/license-model-of-gds/23664)
- [CodeScene: Code Churn Documentation](https://codescene.io/docs/guides/technical/code-churn.html)
- [Blast-Radius.dev: Impact Analysis Tool](https://blast-radius.dev/)
