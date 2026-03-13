# Static Analysis Tools for TypeScript/JavaScript Import-Export Extraction

**Date**: 2026-03-09
**Status**: Final
**Context**: Evaluating approaches to extract import/export/call relationships from TypeScript and JavaScript files for use in ping-mem's code structural intelligence layer (a Bun-based project).

**Scope**: Import forms to handle:
- `import X from 'Y'` — default import
- `import { X, Y } from 'Z'` — named imports
- `import type { X } from 'Z'` — type-only import (TypeScript)
- `import * as X from 'Y'` — namespace import
- `import 'Y'` — side-effect import
- `import('Y')` — dynamic import expression
- `export * from 'Y'` — re-export all
- `export { X } from 'Y'` — re-export named
- `export { X as Y } from 'Z'` — re-export aliased
- `export default X` — default export
- `export type { X } from 'Y'` — type-only re-export (TypeScript)
- Barrel files (`index.ts` that re-export everything)

---

## Approach: Bun Native (`Bun.Transpiler`)

Bun ships a built-in `Bun.Transpiler` class that operates in-process, requiring zero additional dependencies.

**API surface**:
```typescript
const transpiler = new Bun.Transpiler({ loader: "tsx" });

// Full scan: returns { exports: string[], imports: Import[] }
const { exports, imports } = transpiler.scan(code);

// Fast path: returns Import[] only
const imports = transpiler.scanImports(code);

// Import type returned:
// { path: string, kind: ImportKind }
// ImportKind = "import-statement" | "require-call" | "require-resolve"
//            | "dynamic-import" | "import-rule" | "url-token" | "internal"
```

- Accuracy:
  - Detects all standard ESM `import` forms (`import X`, `import { X }`, `import * as X`, `import 'Y'`), mapping them all to `kind: "import-statement"`.
  - Detects `require()` → `kind: "require-call"`.
  - Detects `import('Y')` → `kind: "dynamic-import"`.
  - **Critical gap**: `import type { X } from 'Z'` is explicitly filtered out — type-only imports are ignored by design. Documented: "Type-only imports and exports are ignored."
  - `.scan()` returns named `exports` as a `string[]` (export names), but does not report `export * from 'Y'` source paths as imports.
  - `.scanImports()` skips the visiting pass — slightly less accurate than `.scan()` on very large files (megabytes), but difference is negligible for typical source files.
  - No export source path reporting: `export { X } from 'Y'` — the `'Y'` path is not surfaced as an import in the result.
  - **No call graph**: cannot extract function call relationships.

- Performance:
  - Extremely fast — runs synchronously in the same thread, no IPC overhead, no deserialization.
  - Bun's transpiler is written in Zig/C++ and is essentially the same parser Bun uses internally for execution. Sub-millisecond per file for typical source.
  - For a 500-file project at ~200 lines/file average: estimated 20–50ms total.

- Bun compatibility:
  - Native to Bun — `Bun.Transpiler` is a first-class global, no import required.
  - Zero dependencies, zero install, ESM native.

- Verdict: VIABLE (with caveats)
  - Suitable for a fast first-pass import scanner when `import type` gaps are acceptable (e.g., for dependency graph purposes where type-only imports create no runtime edge).
  - Not suitable if type-only import paths need to be tracked (e.g., for module boundary analysis).
  - Not suitable for export-source-path tracking (`export { X } from 'Y'` → `Y`).

---

## Approach: @typescript-eslint/parser (via typescript-estree)

The `@typescript-eslint/typescript-estree` package is the underlying parser behind `@typescript-eslint/parser`. It converts TypeScript source into an ESTree-compatible AST without requiring a full `tsc` compilation or type-checking pass.

**Current package.json status**: Not present in `/Users/umasankr/Projects/ping-mem/package.json`. The project has `typescript: ^5.9.3` as a devDependency but no `@typescript-eslint/*` packages.

**API surface** (no type-checking mode):
```typescript
import { parse } from '@typescript-eslint/typescript-estree';

const ast = parse(sourceCode, {
  jsx: true,
  loc: true,
  range: true,
  // No `project` option = no type checker, fast mode
});

// Walk ast.body for ImportDeclaration nodes:
for (const node of ast.body) {
  if (node.type === 'ImportDeclaration') {
    // node.source.value   → import path
    // node.importKind     → 'value' | 'type'
    // node.specifiers     → Array of ImportDefaultSpecifier | ImportNamespaceSpecifier | ImportSpecifier
    // node.assertions     → import assertions (import ... assert { type: 'json' })
  }
  if (node.type === 'ExportNamedDeclaration' && node.source) {
    // node.source.value   → re-export path
    // node.exportKind     → 'value' | 'type'
  }
  if (node.type === 'ExportAllDeclaration') {
    // node.source.value   → export * from path
    // node.exportKind     → 'value' | 'type'
  }
}
```

- Accuracy:
  - Full TypeScript AST — correctly handles every import/export form in the scope list above, including `import type`, `export type { X } from`, `export * from`, barrel re-exports.
  - `importKind: 'type'` field on `ImportDeclaration` directly distinguishes type-only imports.
  - Dynamic `import()` expressions appear as `ImportExpression` nodes in the AST body (nested inside expressions/statements), requiring a recursive walk.
  - Handles TSX, decorators, and all TypeScript syntax forms.
  - No call graph out of the box — would require additional AST traversal for `CallExpression` nodes.

- Performance:
  - Parsing without type information (`project` option omitted) is fast — comparable to swc/babel parsing speed since it does not invoke tsc's type checker.
  - Estimated 2–5ms per file for a typical 200-line TypeScript file.
  - For 500 files: ~1–2.5 seconds total (single-threaded). Parallelizable via Bun workers.
  - ESLint's own linting at scale uses this parser on thousands of files, so it is production-proven at scale.

- Bun compatibility:
  - `@typescript-eslint/typescript-estree` is a pure ESM/CJS package with no native addons.
  - Runs without issue under Bun — no node-gyp, no NAPI required.
  - Would be a new dependency (~500KB package + transitive deps including `@typescript-eslint/visitor-keys`, `@typescript-eslint/types`).
  - The project already has `typescript` installed which `typescript-estree` uses internally.

- Verdict: RECOMMENDED (secondary)
  - Most accurate TypeScript-native option without requiring a type checker.
  - Handles every import/export form including `import type`.
  - Moderate dependency footprint (~3 packages, all pure JS).
  - Slightly slower than Bun native or oxc but still fast enough for 500-file projects.

---

## Approach: acorn + acorn-walk

Acorn is a fast, standards-compliant JavaScript parser (ESTree AST). It does not parse TypeScript natively — TypeScript support requires a plugin (`acorn-typescript` or `@sveltejs/acorn-typescript`).

**API surface**:
```typescript
import * as acorn from 'acorn';
import acornTs from '@sveltejs/acorn-typescript';
import { simple } from 'acorn-walk';

const AcornTS = acorn.Parser.extend(acornTs());
const ast = AcornTS.parse(code, {
  sourceType: 'module',
  ecmaVersion: 'latest',
  locations: true  // required by acorn-typescript
});

simple(ast, {
  ImportDeclaration(node) {
    // node.source.value → import path
    // No importKind field — type-only imports require plugin support
  },
  ExportAllDeclaration(node) {
    // node.source.value → re-export source
  },
  ExportNamedDeclaration(node) {
    // node.source?.value → re-export source (if present)
  }
});
```

- Accuracy:
  - Standard JavaScript ESM imports: fully accurate.
  - TypeScript support via plugin: `acorn-typescript` (g-plane's version) handles most TS syntax. The `@sveltejs/acorn-typescript` fork is the actively maintained version as of 2024 (the original `acorn-typescript` by TyrealHu had last release Jan 2024).
  - `import type` handling: the `acorn-typescript` plugin parses the `type` keyword in import declarations, but the `importKind` field may not be reliably populated across plugin versions — requires verification.
  - TSX: supported via plugin option.
  - `export * from 'Y'`: handled as `ExportAllDeclaration`.
  - Dynamic `import()`: represented as `ImportExpression` in the AST — requires separate walk.
  - Plugin maintenance fragmentation (multiple forks: g-plane, TyrealHu, P0lip, @sveltejs) creates selection risk.
  - Cannot handle newer TypeScript features (type assertions, decorators with metadata, `using` declarations) until the plugin catches up.

- Performance:
  - Acorn itself is very fast (~1ms per file for typical JS files). Plugin overhead adds some cost.
  - For 500 TypeScript files: estimated 500ms–1.5 seconds total.
  - acorn-walk adds minimal overhead over the parse step.

- Bun compatibility:
  - acorn and acorn-walk are pure JavaScript, ESM-compatible, zero native addons.
  - Fully compatible with Bun.
  - Two new core dependencies + a TypeScript plugin dependency.

- Verdict: AVOID
  - Plugin fragmentation and uncertain maintenance of TypeScript support creates reliability risk.
  - No clear advantage over `@typescript-eslint/typescript-estree` (which is also pure JS and more accurate on TypeScript).
  - Use acorn only for JavaScript-only projects where no TypeScript plugin is needed.

---

## Approach: Regex-Based Extraction

Regex patterns can approximate import/export extraction without a parser.

**Example patterns**:
```typescript
// Static imports
/^import\s+(?:type\s+)?(?:[\w*{},\s]+\s+from\s+)?['"]([^'"]+)['"]/gm

// Dynamic imports
/import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g

// require()
/require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g

// export * from
/^export\s+(?:type\s+)?\*\s+(?:as\s+\w+\s+)?from\s+['"]([^'"]+)['"]/gm

// export { X } from
/^export\s+(?:type\s+)?{[^}]*}\s+from\s+['"]([^'"]+)['"]/gm
```

- Accuracy:
  - **Precision problems** (false positives):
    - Matches imports inside multiline string literals or template literals.
    - Matches commented-out imports (`// import X from 'Y'` — partially mitigated by anchoring to line start, but block comments spanning lines break this).
    - Matches imports inside JSDoc examples in `/** */` blocks.
  - **Recall problems** (false negatives):
    - Multiline imports break single-line regex: `import {\n  A,\n  B\n} from 'C'` — requires `s` flag and careful boundary matching.
    - Dynamic paths: `import(\`./dir/${name}\`)` — path cannot be statically extracted.
    - Aliases with complex syntax: `export { default as X } from 'Y'` requires careful regex.
    - String concatenation in require: `require('./dir/' + name)` — extractable path is partial only.
    - Import assertions: `import X from 'Y' assert { type: 'json' }` — trailing syntax may confuse patterns.
    - TypeScript path aliases, `export * as ns from 'Y'` (namespace re-export) need explicit patterns.
  - **Estimated precision**: ~85–92% (false positives mainly from string/comment contexts).
  - **Estimated recall**: ~80–88% for real-world TypeScript codebases (multiline and dynamic imports are the main sources of misses).

- Performance:
  - Fastest option — pure string scanning, no AST construction.
  - For 500 files at 200 lines each: ~5–20ms total.

- Bun compatibility:
  - Zero dependencies, works everywhere.

- Verdict: AVOID for production use
  - Precision/recall gaps are unacceptable for a structural intelligence system where correctness matters.
  - Acceptable only as a fast pre-filter or fallback when a parser is unavailable.
  - The multiline import problem alone makes this unreliable for TypeScript codebases that use multi-specifier imports extensively.

---

## Approach: tree-sitter

tree-sitter is an incremental parser generator used by editors (Neovim, Helix, GitHub). It provides concrete syntax trees (CST), not ASTs. The `tree-sitter-typescript` grammar supports TypeScript and TSX.

**Two binding options**:
1. `tree-sitter` (node-tree-sitter) — Node.js native NAPI addon, requires prebuilt binaries.
2. `web-tree-sitter` — WebAssembly bindings, runtime-agnostic.

**API surface** (web-tree-sitter):
```typescript
import Parser from 'web-tree-sitter';
await Parser.init();
const parser = new Parser();
const TypeScript = await Parser.Language.load('tree-sitter-typescript.wasm');
parser.setLanguage(TypeScript);

const tree = parser.parse(code);
// Walk tree.rootNode for import_statement nodes
// node.type === 'import_statement'
// node.childForFieldName('source') → path node
```

- Accuracy:
  - CST is the ground truth for the language — extremely accurate, handles all TypeScript syntax.
  - `import_statement` nodes cover all static import forms.
  - `export_statement` covers `export * from`, `export { }`, etc.
  - `call_expression` where callee is `import` covers dynamic imports.
  - `import type` is represented with a `type` keyword child node — extractable but requires explicit node navigation (no `importKind` property like ESTree).
  - Full TypeScript support — maintained as an official tree-sitter grammar.

- Performance:
  - tree-sitter is fast incrementally, but initial parse for a 500-file project has overhead.
  - `web-tree-sitter` WASM adds initialization overhead (~50–100ms for WASM load) plus per-parse overhead vs native.
  - `node-tree-sitter` native: fast per-file (~0.5–1ms), but Bun NAPI compatibility is the concern.
  - For 500 files (native): ~250–500ms total (excluding WASM init).

- Bun compatibility:
  - **node-tree-sitter** (native addon): Bun has improved NAPI support through 2024–2025, but native addons requiring node-gyp compilation remain fragile. The `tree-sitter` npm package requires prebuilt binaries. Bun's NAPI layer is not 100% compatible with all Node.js native modules. This is a deployment risk.
  - **web-tree-sitter**: WebAssembly runs fine in Bun (Bun has full WASM support). However, loading `.wasm` grammar files requires file system access to grammar artifacts, adding deployment complexity (grammar files must be bundled separately).
  - Neither option is seamless for a Bun project.

- Verdict: AVOID
  - Deployment complexity (native addons or WASM grammar files) outweighs benefits for this use case.
  - CST-level navigation is more verbose than ESTree for import/export extraction.
  - No advantage over `@typescript-eslint/typescript-estree` for import extraction accuracy, with higher setup cost.
  - tree-sitter shines for editor integration and incremental re-parsing — not needed here.

---

## Approach: ts-morph

ts-morph is a TypeScript Compiler API wrapper that provides a higher-level API for navigating TypeScript source files. It wraps the `typescript` package (which ping-mem already has as a devDependency).

**API surface**:
```typescript
import { Project, SyntaxKind } from 'ts-morph';

const project = new Project({ useInMemoryFileSystem: true });
const sourceFile = project.createSourceFile('file.ts', code);

// Get all import declarations
const imports = sourceFile.getImportDeclarations();
for (const imp of imports) {
  imp.getModuleSpecifierValue();  // → import path string
  imp.isTypeOnly();               // → boolean
  imp.getDefaultImport();         // → Identifier | undefined
  imp.getNamespaceImport();       // → Identifier | undefined
  imp.getNamedImports();          // → ImportSpecifier[]
}

// Get re-exports
const exports = sourceFile.getExportDeclarations();
for (const exp of exports) {
  exp.getModuleSpecifierValue();  // → source path (for re-exports)
  exp.isTypeOnly();               // → boolean
  exp.getNamedExports();          // → ExportSpecifier[]
}

// export * from
sourceFile.getExportDeclarations().filter(e => e.hasNamespaceExport());

// Exported declarations map (resolves across barrel files)
sourceFile.getExportedDeclarations(); // → Map<name, Declaration[]>
```

- Accuracy:
  - Highest accuracy of all options — ts-morph uses the TypeScript compiler's own parser (`ts.createSourceFile`), identical to tsc.
  - All import/export forms are handled correctly, including `import type`, `export type`, `export * from`, `export * as ns from`.
  - `getExportedDeclarations()` can follow barrel re-exports across files when files are added to the Project.
  - Dynamic `import()` requires manual AST traversal (ts-morph doesn't surface these as a dedicated API — use `sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)`).

- Performance:
  - **Initialization overhead**: Creating a `new Project()` loads the TypeScript compiler (~50–200ms depending on machine). This is a one-time cost.
  - **Per-file parsing**: ts-morph parses files via `ts.createSourceFile()` — fast (~1–3ms per file). It does not invoke the type checker unless `useDefaultCompilerOptions: true` and type-checked APIs are called.
  - **Memory**: ts-morph holds parsed source files in memory. For 500 files, expect 50–150MB additional memory (the TS compiler AST is verbose).
  - **For 500 files**: ~2–4 seconds total (dominated by per-file parse time, not type checking). ts-morph documentation explicitly warns that manipulations are slow due to repeated reparsing, but read-only analysis is significantly faster.
  - Using `useInMemoryFileSystem: true` avoids disk I/O on the in-memory portion, but file reads still hit disk.

- Bun compatibility:
  - ts-morph uses `typescript` package which is pure JavaScript — no native addons.
  - Fully compatible with Bun.
  - The `typescript` package is already installed as a devDependency.
  - Adding `ts-morph` as a new dependency (~2MB package) but it wraps the already-present compiler.

- Verdict: VIABLE (for analysis workloads, not hot-path scanning)
  - Excellent accuracy and API ergonomics.
  - Memory and initialization overhead make it better suited for project-level analysis (run once on ingest) than file-by-file hot-path scanning.
  - For ping-mem's ingestion pipeline (not a hot path), this overhead is acceptable.
  - The `getExportedDeclarations()` cross-file resolution of barrel files is uniquely powerful.

---

## Approach: OXC (oxc-parser)

OXC (Oxidation Compiler) is a Rust-based JavaScript/TypeScript toolchain. The `oxc-parser` npm package provides JavaScript bindings via NAPI (native prebuilt binaries per platform).

**API surface**:
```typescript
import { parseSync } from 'oxc-parser';

const result = parseSync('file.ts', code, { sourceType: 'module' });

// result.program — full ESTree-compatible AST
// result.module  — pre-extracted ESM module info (no AST walk needed)
// result.errors  — parse errors

// EcmaScriptModule interface:
const { staticImports, staticExports, dynamicImports, importMetas } = result.module;

// StaticImport:
// { start, end, moduleRequest: { start, end, value: string } }
// (specifier details require AST walk on result.program)

// StaticExport:
// { start, end }
// (source path requires AST walk)

// DynamicImport:
// { start, end, moduleRequest?: { start, end, value: string } }
// moduleRequest only present for literal paths (not template literals)
```

- Accuracy:
  - The parser passes all Test262 tests and 99% of Babel/TypeScript parser test suites.
  - AST aligns with `@typescript-eslint/typescript-estree`'s TS-ESTree format with extensions.
  - `import type`, `export type { X } from`, `export * from`, TSX, decorators — all supported.
  - The `result.module.staticImports` provides a zero-walk fast path to get module specifiers for static imports — but **specifier names/kinds are not in the module object**; that requires walking `result.program`.
  - Dynamic imports with non-literal paths (template literals, expressions) appear in `dynamicImports` but `moduleRequest` is absent — path is unavailable without evaluation.
  - **Key serialization cost**: The AST is serialized from Rust to JavaScript via JSON — for large files this deserialization cost increases linearly with file size. For small-to-medium files this is negligible; for files >500KB it becomes measurable.

- Performance:
  - The underlying Rust parser is the fastest available — ~3x faster than swc, ~5x faster than Biome.
  - With serialization overhead, the effective JavaScript-facing speed is reduced but still very fast.
  - For 500 TypeScript files: estimated 100–300ms total (including NAPI call overhead + deserialization).
  - `result.module.staticImports` provides an ultra-fast path if only import paths (not specifier names) are needed.

- Bun compatibility:
  - `oxc-parser` uses NAPI (prebuilt platform-specific binaries: `@oxc-parser/binding-darwin-arm64`, etc.).
  - Bun supports NAPI as of 2024, and bcrypt/argon2 and similar packages work. However, Bun's NAPI layer has had compatibility issues with some packages.
  - **Risk**: Some users have encountered `Cannot find module '@oxc-parser'` errors in non-Node environments (e.g., Nuxt/Cloudflare). These are typically platform binary resolution issues, not fundamental incompatibilities.
  - `@oxc-parser/wasm` is an alternative that uses WebAssembly instead of NAPI — trades some performance for guaranteed cross-runtime compatibility (Bun supports WASM natively).
  - **macOS (darwin-arm64)**: prebuilt binary exists and Bun's NAPI support is strongest on macOS/Linux x64. For ping-mem (macOS development), this should work reliably.

- Verdict: RECOMMENDED (primary for performance-critical paths)
  - Fastest option that handles full TypeScript syntax accurately.
  - `result.module` provides import/export locations without AST traversal for speed.
  - NAPI dependency adds one platform-specific binary but Bun NAPI support is mature enough for macOS development.
  - If NAPI proves problematic, fallback to `@oxc-parser/wasm` at ~30% slower.

---

## Summary Comparison Table

| Approach | Type-only import | `export * from` | Dynamic import path | Call graph | Bun compat | New deps | Est. time (500 files) |
|---|---|---|---|---|---|---|---|
| Bun.Transpiler | Filtered out | Not in imports | Yes (kind) | No | Native | 0 | ~30ms |
| @typescript-eslint/typescript-estree | Yes (importKind) | Yes | Requires walk | No | Pure JS | 3 | ~2s |
| acorn + plugin | Partial (plugin-dependent) | Yes | Requires walk | No | Pure JS | 3+ | ~1s |
| Regex | Partial (pattern-dependent) | Partial | Partial (literals only) | No | 0 | 0 | ~10ms |
| tree-sitter | Yes (node nav) | Yes | Requires walk | No | WASM/fragile NAPI | 2+ | ~300ms |
| ts-morph | Yes | Yes (cross-file) | Requires walk | No | Pure JS (uses ts) | 1 | ~3s |
| oxc-parser | Yes | Yes | Yes (literals) | No | NAPI (good on macOS) | 1 | ~150ms |

---

## Recommendation

**For ping-mem's code structural intelligence layer, use a two-tier approach**:

### Tier 1 (Fast path — per-file import scanning): `oxc-parser`

Use `oxc-parser` (with `@oxc-parser/wasm` as the fallback if NAPI is unavailable) for the hot path during file ingestion. Reasons:

1. **Speed**: ~150ms for 500 files vs ~2–3 seconds for TypeScript-based approaches. Critical for incremental ingestion triggered by git hooks.
2. **Accuracy**: Full TypeScript support including `import type`, `export * from`, `export type`, TSX. Passes 99% of TypeScript parser tests.
3. **Zero AST walk for paths**: `result.module.staticImports` gives import paths directly without walking the full AST — perfect for dependency graph edges.
4. **Bun NAPI**: Works on macOS (primary dev environment) and Linux x64 (Docker). The `@oxc-parser/wasm` fallback covers edge cases.
5. **Future-proof**: oxc is the backbone of Rolldown (Vite's new bundler) and Biome — actively maintained with excellent TypeScript conformance.

**Usage pattern for import/export extraction**:
```typescript
import { parseSync } from 'oxc-parser';

function extractModuleEdges(filePath: string, code: string) {
  const result = parseSync(filePath, code, { sourceType: 'module' });

  return {
    staticImports: result.module.staticImports.map(i => i.moduleRequest.value),
    dynamicImports: result.module.dynamicImports
      .filter(d => d.moduleRequest)
      .map(d => d.moduleRequest!.value),
    // For export source paths and import type discrimination, walk result.program
  };
}
```

### Tier 2 (Deep analysis — project-level): `@typescript-eslint/typescript-estree`

Use `typescript-estree` when full `importKind`/`exportKind` discrimination and specifier details are needed (e.g., distinguishing type-only imports for type-graph vs runtime-graph separation). The project already has `typescript` installed; `@typescript-eslint/typescript-estree` adds minimal new surface area.

### What to Avoid

- **Regex**: False positive/negative rate too high for a structural intelligence system.
- **tree-sitter**: Deployment complexity without accuracy advantage.
- **ts-morph**: Too memory-heavy for per-file streaming ingestion; reserve for project-level cross-file barrel resolution if needed.
- **acorn + plugin**: Plugin fragmentation risk; no advantage over typescript-estree.

### Note on Call Graph

None of the evaluated approaches provide call graph extraction out of the box. Call relationship extraction requires:
- Walking `CallExpression` nodes in the AST (`result.program` from oxc-parser or `ast.body` traversal with typescript-estree).
- Resolving callee identifiers to their import source — this requires binding/scope analysis, which needs either a type checker (ts-morph with type info enabled) or a scope analyzer (e.g., `eslint-scope`).
- This is a separate concern from import/export extraction and should be evaluated independently.

---

**Sources consulted**:
- [Bun Transpiler docs](https://bun.com/docs/runtime/transpiler)
- [Bun Transpiler API Reference](https://bun.com/reference/bun/Transpiler)
- [oxc-parser npm](https://www.npmjs.com/package/oxc-parser)
- [oxc Parser guide](https://oxc.rs/docs/guide/usage/parser.html)
- [oxc Benchmarks](https://oxc.rs/docs/guide/benchmarks)
- [@typescript-eslint/typescript-estree package](https://typescript-eslint.io/packages/typescript-estree/)
- [typescript-eslint AST Spec](https://typescript-eslint.io/packages/typescript-estree/ast-spec/)
- [ts-morph docs](https://ts-morph.com/)
- [ts-morph Performance](https://ts-morph.com/manipulation/performance)
- [acorn npm](https://www.npmjs.com/package/acorn)
- [@sveltejs/acorn-typescript](https://www.npmjs.com/package/@sveltejs/acorn-typescript)
- [tree-sitter npm](https://www.npmjs.com/package/tree-sitter)
- [tree-sitter-typescript](https://www.npmjs.com/package/tree-sitter-typescript)
- [web-tree-sitter npm](https://www.npmjs.com/package/web-tree-sitter)
- [Benchmark: TypeScript Parsers (DEV Community)](https://dev.to/herrington_darkholme/benchmark-typescript-parsers-demystify-rust-tooling-performance-2go8)
- [Bun NAPI issue tracking](https://github.com/oven-sh/bun/issues/158)
