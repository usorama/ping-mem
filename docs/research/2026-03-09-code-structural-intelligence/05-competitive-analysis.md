# Competitive Analysis: Code Structural Intelligence

**Date**: 2026-03-09
**Author**: Research Agent (claude-sonnet-4-6)
**Purpose**: Inform ping-mem's design choices for code structural intelligence — import graphs, call graphs, impact analysis

---

## 1. Sourcegraph Code Intelligence: SCIP/LSIF

### What It Does

Sourcegraph powers precise code navigation (go-to-definition, find-all-references, find-implementations) through a pre-computed index stored in a format called SCIP (SCIP Code Intelligence Protocol). SCIP replaced LSIF (Language Server Index Format) starting in Sourcegraph 4.6.

### The SCIP Data Model

SCIP is a Protobuf-encoded index organized around three top-level concepts:

**Index**
```
Index {
  metadata: { tool_info, project_root, text_document_encoding }
  documents: [ Document, ... ]
  external_symbols: [ SymbolInformation, ... ]  // cross-repo references
}
```

**Document** (one per source file)
```
Document {
  relative_path: "src/auth.ts"
  occurrences: [ Occurrence, ... ]   // every usage of any symbol in this file
  symbols: [ SymbolInformation, ... ] // symbols DEFINED in this file
}
```

**Occurrence** (the core unit — attaches meaning to a source range)
```
Occurrence {
  range: [start_line, start_col, end_line, end_col]
  symbol: "npm react 18.0.0 `useState`()."   // human-readable symbol ID
  symbol_roles: bitset<DEFINITION | REFERENCE | ...>
  syntax_kind: KEYWORD | IDENTIFIER | ...    // for syntax highlighting
  diagnostics: [ Diagnostic, ... ]           // optional: static analysis findings
}
```

**Symbol string format** — the key innovation over LSIF:
```
<scheme> <package-manager> <package-name> <package-version> <descriptor>...

Example (TypeScript):
  "scip-typescript npm react 18.0.0 `useState`()."

Descriptor types:
  namespace   →  "SomeNamespace/"
  type        →  "#SomeClass."
  term        →  "someVariable."
  method      →  "#SomeClass.someMethod()."
  type-param  →  "[T]"
  parameter   →  "(param)"
```

### Why SCIP Beat LSIF

LSIF used globally-incrementing numeric IDs for every node and edge in a graph. This created:
- Ordering constraints (must emit in topological order)
- Cyclic dependency problems across files
- Opaque IDs that are impossible to debug

SCIP switched to **human-readable string identifiers** per symbol. This unlocks:
- **Incremental indexing**: Only changed files need re-indexing; string IDs do not depend on processing order
- **Cross-repo navigation**: Symbol strings encode package identity, allowing cross-package find-references
- **Cross-language navigation**: Protobuf-generated code and its source can share symbol strings
- **Debuggability**: Indexes can be diff'd and inspected as text

### Storage per File Edge

SCIP does not explicitly store "file A imports file B" edges. Instead, it stores **occurrences with reference roles** pointing at symbols that may be defined in other documents. The resolution from "reference to definition" is done at query time by matching symbol strings across all documents in the index.

For cross-repository symbols, `external_symbols` at the index level carries `SymbolInformation` records that tell Sourcegraph where to route navigation queries (which other repository to look in).

### Size and Performance

- SCIP indexes are approximately 4-5x larger than LSIF when gzip-compressed
- But SCIP can be processed ~3x faster due to its static-typed Protobuf schema
- Incremental indexing means only changed-file deltas need to be re-submitted after each commit

### Key Takeaway for ping-mem

Sourcegraph's approach is **occurrence-centric, not edge-centric**. The fundamental unit is: "at this line/column in this file, symbol X appears with role DEFINITION or REFERENCE." The graph structure emerges implicitly from matching symbol strings. This is a clean model for ping-mem to adopt: store occurrences in SQLite with (file, line, col, symbol_id, role), then derive edges on query.

---

## 2. GitHub Code Navigation: Stack Graphs

### The github/semantic Project (Archived)

GitHub's original code navigation used `github/semantic`, a Haskell library and CLI that:
- Parsed source files into ASTs using tree-sitter grammar definitions
- Generated per-language Haskell syntax types from tree-sitter grammars
- Emitted "symbol lists" (JSON or Protobuf) representing definitions and references
- Was open source but is now **archived and unsupported** (archived April 1, 2025)

Semantic supported "find all references within the same repo" but was not designed for cross-repo navigation and did not scale well to large monorepos.

### The Stack Graphs Replacement

GitHub replaced `github/semantic` with **stack graphs**, an open-source framework published in 2021. Stack graphs enable precise code navigation without:
- Repository-owner configuration
- Build process integration
- Language tooling installed on the server

#### How Stack Graphs Work

Stack graphs use a declarative DSL built on top of tree-sitter-graph to define **name binding rules** for a programming language. The rules describe how scoping, imports, and name resolution work in that language.

At index time, each file is analyzed in isolation, producing a partial graph:
- **Definition nodes** (red, double-bordered): represent where a symbol is declared
- **Reference nodes** (blue, single-bordered): represent where a symbol is used
- **Scope edges**: encode the language's scoping rules (block scope, module scope, etc.)
- **Symbol stacks**: push/pop mechanism that enforces correctness during path search

At query time (find-references or go-to-definition), the partial graphs from all files merge into one big graph. The system finds **paths from a reference node to a definition node** where the symbol stack is empty at the destination — that is a valid binding.

#### Per-File Storage

GitHub stores the **partial graph for each file** independently. This is the key design choice:
- When file A changes, only A's partial graph is recomputed
- File B's graph is unchanged
- The merged query-time graph is always fresh without full re-indexing

This avoids the quadratic re-indexing cost when dependencies change.

#### Language Support

Stack graph rules exist for: Python, TypeScript/JavaScript (and they are large, complex .tsg files). Adding a new language requires writing and maintaining these grammar rule files. This is a significant maintenance burden — it is why SWE-agent and OpenHands evaluated but did not fully adopt stack graphs (limited language coverage as of 2025).

### Key Takeaway for ping-mem

Stack graphs are the most correct solution for precise name resolution, but they require per-language grammar rule files that are expensive to write and maintain. For ping-mem's use case (agent memory layer, not a full IDE), this is overkill. The incremental per-file partial graph design principle is worth stealing: **store per-file data independently so that change propagation is O(changed files), not O(total files)**.

---

## 3. CodeScene Hotspot Analysis

### Core Concept: Complexity × Churn

CodeScene's hotspot analysis, developed by Adam Tornhill (based on his book "Your Code as a Crime Scene" and later "Software Design X-Rays"), identifies the most problematic code by intersecting two signals:

- **Complexity proxy**: Lines of code in each file (simple but correlated with maintainability burden). CodeScene also uses **indentation-based complexity** — the number and depth of indentation levels correlates strongly with cyclomatic complexity and is language-agnostic.
- **Churn proxy**: Commit frequency per file (how often is this file modified in git history)

The hotspot score is conceptually:
```
hotspot_score(file) = normalize(complexity(file)) × normalize(churn(file))
```

Files with high complexity AND high churn are the highest-priority technical debt. A complex file that is never touched is low priority. A frequently-changing simple file is also low priority.

### Temporal Coupling (Change Coupling)

The second major feature is **temporal coupling** — identifying files that tend to change together in the same commits, which is a strong signal of hidden architectural dependencies.

**Algorithm** (from CodeScene documentation and code-maat source):

For each pair of files (A, B):
1. Count `shared_revisions(A, B)` = number of commits where both A and B were modified
2. Count `total_revisions(A)` = total number of commits touching A
3. Coupling percentage = `shared_revisions(A, B) / total_revisions(A) × 100`

Default thresholds applied before reporting:
- Minimum 10 revisions per file (filters noise from rarely-changed files)
- At least 10 shared commits between the pair (filters coincidental co-changes)
- Minimum 50% coupling strength (only report strong coupling)
- Maximum 50 files per changeset (filters bulk commits like dependency updates)

**Interpretation**: If file A changes and file B changes together 74% of the time, then B is a hidden dependency of A — even if no static import edge exists between them.

### Graph Representation

CodeScene stores coupling data as a **weighted undirected graph**:
- Nodes: files (identified by path)
- Edges: coupling percentage between each pair
- Displayed as a hierarchical visualization (treemap + force-directed graph)
- Tabular view shows file pairs ranked by coupling strength

The X-Ray feature applies the same analysis at the **function level within a file**, finding methods that must change together even inside a single file.

### Key Takeaway for ping-mem

Temporal coupling is **free to compute from existing git history** — ping-mem already ingests git commit data. The formula is simple: count shared commits vs total commits per file pair. This gives a signal that static analysis tools cannot produce: implicit behavioral coupling between files that look unrelated in the import graph. ping-mem should compute temporal coupling as an output of the existing `GitHistoryReader` pipeline.

---

## 4. Semgrep vs ast-grep: Pattern-Based Code Intelligence

### Semgrep

Semgrep is a multi-language static analysis tool that matches code patterns against augmented ASTs. Key characteristics:

- **Language handling**: Uses tree-sitter parsers plus language-specific AST augmentations (parentheses, tokens from CST are preserved)
- **Pattern matching**: Supports semantic equivalence (`$X + $X` matches `a + a` and `b + b`), deep matching (`...` wildcards), and taint analysis across function boundaries
- **Scope**: Primarily security vulnerability detection (OWASP rules, SAST)
- **Performance**: Relatively slow as a CLI tool (Python-based core, single-threaded by default)
- **No type information**: Semgrep operates at the syntactic level for most languages; it does not resolve types across files

### ast-grep

ast-grep is a Rust-based structural search tool using tree-sitter. Key characteristics:

- **Architecture**: Operates on CST (Concrete Syntax Tree) rather than a fully-abstracted AST. This means it preserves punctuation, whitespace, and all syntactic details
- **Performance**: Multi-threaded using all CPU cores; substantially faster than Semgrep for large codebases
- **Pattern syntax**: Patterns are code snippets where `$VAR` matches any node. Structural search rather than text search
- **Limitations**: No type resolution, no control flow analysis, no data flow analysis, no taint tracking — pure syntax-level matching
- **Use cases**: Codemods, refactoring, lint rules, structural search (not security-critical analysis)

### Trade-off Summary

| Feature | Semgrep | ast-grep |
|---|---|---|
| Speed | Slow (Python) | Fast (Rust, multi-threaded) |
| Semantic depth | Taint/dataflow analysis | Syntax only |
| Equivalence matching | Yes (`$X + $X` forms) | No |
| Type information | Limited | None |
| Best for | Security SAST | Structural search / refactoring |
| Language coverage | 30+ languages | 20+ languages |

### Key Takeaway for ping-mem

Neither Semgrep nor ast-grep is designed as a graph-building tool for agent context. They are query tools (find patterns in code). However, ast-grep's tree-sitter foundation is relevant: ping-mem can use tree-sitter queries to extract import statements, export declarations, and function signatures from source files to build a lightweight structural graph — without needing the full complexity of either Semgrep or ast-grep's pattern engines.

---

## 5. Repomix and Aider Repo-Map: Agent-Oriented Codebase Context

### Repomix: Whole-Repo Packing

Repomix packs an entire repository into a single AI-friendly text file. It is designed for **one-shot context injection** rather than incremental navigation.

**Key features**:
- Respects `.gitignore` and custom ignore patterns
- Multiple output formats: XML, Markdown, JSON, plain text
- Token counting per file and per repository
- Security scanning (Secretlint) before output

**Code compression mode** (`--compress`):
- Uses tree-sitter to extract structural skeleton
- **Keeps**: function/method signatures, interface/type definitions, class structures and properties
- **Removes**: function bodies, loop logic, conditional logic, internal variable declarations
- Replaces removed sections with `⋮----` visual separator
- Achieves approximately **70% token reduction** vs raw source

**Repomix format example** (compressed):
```typescript
export class AuthService {
  constructor(private db: Database) {}
  ⋮----
  async authenticate(token: string): Promise<User | null> {
  ⋮----
  async logout(userId: string): Promise<void> {
  ⋮----
}
```

**Limitation**: Repomix produces a flat dump — all files concatenated. It has no structural intelligence about which files depend on which. It is a brute-force approach: put everything in context and let the LLM figure out relevance.

### Aider Repo-Map: Graph-Ranked Context Selection

Aider's repo-map is a more sophisticated approach. Instead of dumping everything, it builds a dependency graph and uses it to select and rank the most relevant code for the current editing context.

**Construction process**:
1. Parse every file using tree-sitter to extract:
   - All symbol definitions (functions, classes, methods, variables)
   - All symbol references (calls, usages)
2. Build a directed graph where:
   - Nodes = source files
   - Edges = "file A references a symbol defined in file B" (dependency edge)
3. Apply a **graph ranking algorithm** (aider does not publicly name the algorithm, but it is equivalent to PageRank or similar eigenvector centrality) to score files by how often they are referenced
4. Select the top-N files and their most-referenced symbols within the token budget (default 1k tokens, configurable with `--map-tokens`)

**What the repo-map output looks like**:
```
src/auth/AuthService.ts:
  class AuthService
    constructor(db: Database)
    authenticate(token: string): Promise<User | null>
    logout(userId: string): Promise<void>

src/storage/Database.ts:
  class Database
    query(sql: string, params: unknown[]): Promise<Row[]>
    transaction(fn: (tx: Transaction) => void): Promise<void>
```

**Token budget strategy**:
- Default: 1,024 tokens for the repo-map
- Dynamically expands when no files are open in the chat
- Filters to only the most-referenced symbols, not all symbols
- Prompt caching (Anthropic): repo-map is cached so it does not count against input tokens on subsequent turns

**Key insight from aider**: The most valuable symbols are those **most often referenced by other parts of the code**. High in-degree in the reference graph = high value for agent context. A function called from 20 places is more important to include in context than one called from 1 place.

### LocAgent: Graph-Guided Code Localization (Research)

A 2025 research system (LocAgent, ACL 2025) formalized what aider does informally. LocAgent builds a **heterogeneous directed graph** over a codebase with:

- **Nodes**: directory, file, class, function
- **Edges**:
  - `contain`: hierarchical (directory→file, file→class, class→method)
  - `invoke`: function call / class instantiation
  - `import`: file-level import of function/class
  - `inherit`: class inheritance

Results on SWE-Bench-Lite:
- 92.7% file-level accuracy (Acc@5) with fine-tuned Qwen2.5-32B
- 86% cost reduction compared to Claude-3.5
- 12% improvement in downstream issue resolution (Pass@10)

The graph enables **multi-hop reasoning**: "this issue is about XSS, which suggests the validation utility, which is imported by 14 files, so these 14 files are candidate locations" — a chain of reasoning impossible from flat text search.

### Key Takeaway for ping-mem

The optimal agent context is not a full dump (Repomix) or a full navigation system (Stack Graphs). It is a **ranked selection** of the most structurally central code, expressed as:
- Function/class signatures (not bodies)
- Import/export relationships between files
- Reference counts (which symbols are most-called)

This is exactly the aider repo-map approach, and it is cheap to compute from tree-sitter.

---

## 6. Key Design Insights

### What Agents Actually Need

Based on the research across all five tool categories, the pattern is clear:

Agents navigating code need answers to exactly three questions:

1. **Where is X defined?** (go-to-definition)
   - "I see a call to `parseToken` — where is that function?"
   - Requires: symbol definitions with file + line

2. **What depends on X?** (find-references / reverse import)
   - "If I change `parseToken`'s signature, what breaks?"
   - Requires: reverse index from symbol → all files referencing it

3. **What changed recently and what changed with it?** (temporal coupling)
   - "This file has bugs — what other files are implicitly coupled to it?"
   - Requires: git commit history analysis (co-change frequency)

The LocAgent research confirms this: the four edge types (contain, invoke, import, inherit) with multi-hop graph traversal gave 92.7% accuracy at finding the right file to edit.

### The 80/20 Rule: Minimum Viable Graph

Full-fidelity tools (Sourcegraph SCIP, GitHub Stack Graphs) store every occurrence at every line and column. This gives 100% accuracy but requires large indexes and complex tooling.

The 80% solution for agent use cases is:

**File-level edges are sufficient for most queries:**
```
file_imports[file_a] = [file_b, file_c, ...]    // what does file_a import?
file_imported_by[file_b] = [file_a, file_d, ...] // who imports file_b?
```

**Symbol-level edges are needed for go-to-definition and impact analysis:**
```
symbol_defined_in[symbol_name] = (file, line)
symbol_referenced_in[symbol_name] = [(file_a, line), (file_b, line), ...]
```

**Temporal coupling adds signal unavailable from static analysis:**
```
temporal_coupling[file_a][file_b] = 0.74  // A and B change together 74% of commits
```

**What to skip (until proven necessary):**
- Type resolution across files (requires language server, high complexity)
- Control flow graphs (per-function, large storage cost)
- Data flow / taint analysis (security tool territory)
- Call graphs at function-level granularity (expensive; file-level often sufficient)

### Token Budget Considerations

Aider's default repo-map budget is 1,024 tokens. This fits approximately:
- 50-80 file summaries (filename + exported symbols)
- Or a full import graph for a medium-sized project (100-200 files)

The practical limit for agent context windows is roughly:
- **Small project** (<100 files): full file-level import graph fits in ~500 tokens
- **Medium project** (100-1,000 files): ranked top-50 files by in-degree fits in ~1,000 tokens
- **Large project** (>1,000 files): need graph traversal from seed files — "give me the N-hop neighborhood of this file"

The key design choice: **store the full graph in the database, expose a ranked/filtered slice to the agent**. Do not try to fit the full graph in a single prompt.

---

## 7. Recommended Minimal Feature Set for ping-mem v1

Based on this competitive analysis, the minimum viable code structural intelligence feature for ping-mem should include exactly these capabilities:

### Layer 1: File-Level Import Graph (Essential, Low Cost)

**What to store** (SQLite table, per-file):
```sql
CREATE TABLE file_imports (
  file_id     TEXT NOT NULL,   -- SHA-256 of (project_id + relative_path)
  imports     TEXT NOT NULL,   -- JSON array of relative paths this file imports
  exports     TEXT NOT NULL,   -- JSON array of symbol names this file exports
  project_id  TEXT NOT NULL,
  indexed_at  INTEGER NOT NULL
);
```

**How to extract**: tree-sitter queries for `import_statement`, `export_declaration`, `require()` calls — supported for TypeScript, JavaScript, Python today. No language server required.

**What it enables**:
- "What does file X depend on?" (direct query)
- "What will break if I change file X?" (reverse lookup of who imports X)
- Impact radius: BFS/DFS from modified file through reverse-import edges

**Cost**: One tree-sitter parse per file, already done during ingestion. Near-zero incremental cost.

### Layer 2: Symbol Definitions and Reference Counts (High Value, Medium Cost)

**What to store** (SQLite table, per-symbol):
```sql
CREATE TABLE symbol_definitions (
  symbol_id   TEXT NOT NULL,   -- hash of (project_id + file_path + symbol_name)
  name        TEXT NOT NULL,   -- "authenticate", "AuthService", "parseToken"
  kind        TEXT NOT NULL,   -- "function" | "class" | "interface" | "variable"
  file_id     TEXT NOT NULL,
  line        INTEGER NOT NULL,
  project_id  TEXT NOT NULL
);

CREATE TABLE symbol_references (
  symbol_id       TEXT NOT NULL,
  referencing_file TEXT NOT NULL,
  line            INTEGER NOT NULL,
  project_id      TEXT NOT NULL
);
```

**What it enables**:
- Go-to-definition for any named symbol
- "Find all references" for impact analysis
- Reference count → importance ranking (aider's core insight: high-reference-count symbols are most valuable in context)

**Cost**: One tree-sitter pass per file extracting `function_declaration`, `class_declaration`, `identifier` nodes. Higher than Layer 1 but still O(file size).

### Layer 3: Temporal Coupling from Git History (Unique Value, Free)

**What to store** (SQLite table, derived from existing commit data):
```sql
CREATE TABLE temporal_coupling (
  file_a      TEXT NOT NULL,
  file_b      TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  shared_commits  INTEGER NOT NULL,
  total_commits_a INTEGER NOT NULL,
  coupling_pct    REAL NOT NULL,   -- shared / total_a × 100
  window_days     INTEGER NOT NULL, -- analysis window (default: 90 days)
  computed_at     INTEGER NOT NULL
);
CREATE INDEX idx_tc_file_a ON temporal_coupling(project_id, file_a, coupling_pct DESC);
```

**Algorithm** (from code-maat):
1. Group commits by changeset (each commit = one changeset)
2. For each file pair (A, B) that appears in the same commit:
   - Increment `shared_commits(A, B)`
3. Count `total_commits(A)` = number of commits touching A
4. `coupling_pct(A→B) = shared_commits(A,B) / total_commits(A) × 100`
5. Filter: minimum 10 shared commits, minimum 50% coupling, exclude changesets >50 files

**What it enables**:
- Discover hidden architectural dependencies not visible in import graphs
- "This file has bugs — what other files are implicitly coupled?"
- Hotspot detection: files with high coupling_pct to many others are architectural load-bearers

**Cost**: One pass over already-ingested commit data. Recomputed on demand (not per-commit).

### Agent-Facing MCP Tools to Expose

Based on what LocAgent, aider, and Engines.dev identified as the tools agents actually call:

| Tool | Query | Answer |
|---|---|---|
| `graph_imports` | `file_path, depth=1` | Files this file imports (direct) |
| `graph_importers` | `file_path, depth=1` | Files that import this file (reverse) |
| `graph_impact` | `file_path, depth=N` | Full BFS impact radius (who breaks?) |
| `symbol_definition` | `symbol_name, project_id` | File + line where symbol is defined |
| `symbol_references` | `symbol_name, project_id` | All files + lines referencing this symbol |
| `temporal_coupling` | `file_path, min_pct=50` | Files that change together with this file |
| `hotspots` | `project_id, limit=20` | Top files by complexity × churn score |
| `repo_map` | `seed_files[], token_budget` | Ranked structural skeleton (aider-style) |

### What to Explicitly NOT Build in v1

- Type resolution (requires language server per language — high complexity, fragile)
- Function-level call graphs (useful but expensive; file-level sufficient for 80% of agent queries)
- Full SCIP/LSIF indexing pipeline (overkill — ping-mem is a memory layer, not Sourcegraph)
- Stack graph DSL files per language (requires indefinite maintenance per language)
- Control flow graphs (security-tool territory, not agent navigation)

### Design Principle: Store Full Graph, Serve Slices

The consistent lesson across all tools: **the full graph is too large to fit in an LLM context window, but it is cheap to store in a database**. The design pattern is:
1. Index the full graph at ingest time (file imports, symbol defs, temporal coupling)
2. At query time, serve a ranked slice: N-hop neighborhood of seed files, ranked by reference count or coupling strength
3. Express the slice in compressed form: filenames + exported symbol signatures, not full source

This is exactly what aider's repo-map does, and it achieves the 80% solution with a 1,024-token budget.

---

## Sources

- [SCIP - a better code indexing format than LSIF](https://sourcegraph.com/blog/announcing-scip)
- [sourcegraph/scip on GitHub](https://github.com/sourcegraph/scip)
- [Precise Code Navigation - Sourcegraph docs](https://sourcegraph.com/docs/code-search/code-navigation/precise_code_navigation)
- [Writing an indexer - Sourcegraph docs](https://sourcegraph.com/docs/code_navigation/explanations/writing_an_indexer)
- [Introducing stack graphs - GitHub Blog](https://github.blog/open-source/introducing-stack-graphs/)
- [github/semantic - archived Haskell library](https://github.com/github/semantic)
- [Stack graphs name resolution at scale (arxiv)](https://arxiv.org/pdf/2211.01224)
- [CodeScene Temporal Coupling documentation](https://docs.enterprise.codescene.io/versions/2.4.2/guides/technical/temporal-coupling.html)
- [CodeScene hotspot analysis](https://codescene.io/docs/guides/technical/hotspots.html)
- [code-maat by Adam Tornhill](https://github.com/adamtornhill/code-maat)
- [Your Code as a Crime Scene (Adam Tornhill)](https://adamtornhill.com/articles/crimescene/codeascrimescene.htm)
- [ast-grep tool comparison](https://ast-grep.github.io/advanced/tool-comparison.html)
- [ast-grep introduction](https://ast-grep.github.io/guide/introduction.html)
- [aider repository map documentation](https://aider.chat/docs/repomap.html)
- [aider repo-map with tree-sitter blog post](https://aider.chat/2023/10/22/repomap.html)
- [repomix code compression](https://repomix.com/guide/code-compress)
- [repomix GitHub](https://github.com/yamadashy/repomix)
- [LocAgent: Graph-Guided LLM Agents for Code Localization (ACL 2025)](https://arxiv.org/html/2503.09089v1)
- [Code Navigation for AI SWEs - Engines.dev](https://www.engines.dev/blog/code-navigation)
- [OpenHands stack graphs issue](https://github.com/All-Hands-AI/OpenHands/issues/742)
- [SWE-agent smart code search issue](https://github.com/SWE-agent/SWE-agent/issues/38)
- [Augment Code microservices impact analysis](https://www.augmentcode.com/tools/microservices-impact-analysis)
