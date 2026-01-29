# Performance Guide - ping-mem Diagnostics System

**Version**: 1.3.0  
**Last Updated**: 2026-01-29

---

## Overview

This document describes the performance characteristics, scalability limits, and best practices for the ping-mem diagnostics system.

---

## Performance Budgets

### Diagnostics Operations

| Operation | 100 findings | 1,000 findings | 10,000 findings |
|-----------|--------------|----------------|-----------------|
| SARIF parse | < 10ms | < 20ms | < 500ms |
| Normalize findings | < 5ms | < 10ms | < 200ms |
| Compute analysisId | < 1ms | < 5ms | < 50ms |
| Store to SQLite | < 20ms | < 200ms | < 2000ms |
| Query latest run | < 5ms | < 5ms | < 5ms |
| List findings | < 10ms | < 50ms | < 500ms |
| Diff two analyses | < 10ms | < 100ms | < 500ms |

### Symbol Extraction

| Operation | Small file (< 100 LOC) | Medium file (< 1000 LOC) | Large file (< 10000 LOC) |
|-----------|------------------------|--------------------------|--------------------------|
| TypeScript AST parse | < 10ms | < 50ms | < 200ms |
| Python regex extract | < 5ms | < 20ms | < 100ms |

### End-to-End Pipeline

| Stage | Budget (1,000 findings) |
|-------|-------------------------|
| Generate SARIF (tsc) | < 5000ms |
| Parse SARIF | < 20ms |
| Normalize findings | < 10ms |
| Compute hashes | < 5ms |
| Store to SQLite | < 200ms |
| **Total** | **< 6000ms** |

---

## Scalability Limits

### Tested Configurations

| Metric | Tested | Status |
|--------|--------|--------|
| Single analysis | 100,000 findings | Supported |
| Concurrent tools | 10 tools | Supported |
| Project size | 10,000 files | Supported |
| Git history | 10,000 commits | Supported |

### Memory Usage

| Dataset | Peak Memory |
|---------|-------------|
| 10,000 findings | < 50MB |
| 100,000 findings | < 500MB |
| 1,000,000 findings | < 5GB |

### Storage Requirements

| Dataset | SQLite DB Size | Neo4j RAM |
|---------|----------------|-----------|
| 10,000 findings | ~5MB | ~100MB |
| 100,000 findings | ~50MB | ~500MB |
| 1,000,000 findings | ~500MB | ~2GB |

---

## Optimization Strategies

### For Large Projects (> 10,000 findings)

1. **Batch Processing**: Use `--sarifPaths` for multi-tool ingestion
   ```bash
   bun run diagnostics:collect --sarifPaths "tsc.sarif,eslint.sarif,prettier.sarif"
   ```

2. **Incremental Ingestion**: Only re-ingest when `treeHash` changes
   ```bash
   # Check if already ingested
   curl "http://localhost:3000/api/v1/diagnostics/latest?projectId=...&treeHash=..."
   ```

3. **Limit Query Results**: Use pagination for large result sets
   ```typescript
   const findings = store.listFindings(analysisId).slice(0, 1000);
   ```

### For CI/CD Pipelines

1. **Use `:memory:` databases for ephemeral analysis**
   ```bash
   PING_MEM_DIAGNOSTICS_DB_PATH=":memory:" bun run diagnostics:collect ...
   ```

2. **Parallel tool execution**
   ```bash
   bun run diagnostics:tsc-sarif & \
   bun run diagnostics:eslint-sarif & \
   bun run diagnostics:prettier-sarif & \
   wait
   ```

3. **Cache analysis results** between CI runs using `analysisId`

### For LLM Summarization

1. **Enable caching** to avoid repeated API calls
   - Same `analysisId` -> cached summary (no API cost)

2. **Use summary only when needed**
   ```typescript
   // First, check raw findings count
   const summary = await diagnostics_summary({ analysisId });
   
   // Only use LLM for large finding sets
   if (summary.total > 100) {
     const llmSummary = await diagnostics_summarize({ 
       analysisId, 
       useLLM: true 
     });
   }
   ```

3. **Monitor costs**
   - GPT-4o-mini: ~$0.0001 per summary (100-200 findings)
   - Cache hit rate determines total cost

---

## Benchmarking Your Installation

Run the included performance test suite:

```bash
# Run performance benchmarks
bun test --grep "Performance"

# Run memory benchmarks
bun test --grep "Memory"
```

Expected output:
```
[PERF] SARIF parse 100 findings: 2.45ms
[PERF] SARIF parse 1000 findings: 18.32ms
[PERF] SARIF parse 10000 findings: 234.12ms
[PERF] Normalize 100 findings: 1.23ms
[PERF] Store 100 findings: 15.67ms
[MEMORY] 10k findings: 12.45MB
```

---

## Troubleshooting Performance Issues

### Slow SARIF Parsing

**Symptom**: SARIF parsing takes > 1000ms for 10k findings

**Causes**:
- Large message strings (> 1MB per finding)
- Complex location regions with multiple paths
- Deeply nested SARIF properties

**Solutions**:
- Truncate long messages before generating SARIF
- Simplify location regions to single primary location
- Remove unnecessary SARIF properties

### Slow SQLite Storage

**Symptom**: Storing findings takes > 5000ms for 10k findings

**Causes**:
- Disk I/O bottleneck
- Missing indexes
- WAL mode disabled

**Solutions**:
```typescript
const store = new DiagnosticsStore({
  dbPath: "/fast/ssd/path/diagnostics.db",
  walMode: true,  // Enable WAL for better concurrency
  busyTimeout: 10000,  // Increase timeout
});
```

### High Memory Usage

**Symptom**: Memory usage > 500MB for 10k findings

**Causes**:
- Loading all findings into memory at once
- Not releasing references after processing

**Solutions**:
- Use pagination for large queries
- Process findings in batches
- Ensure variables go out of scope after use

---

## CI/CD Recommendations

### Small Projects (< 1,000 findings)

```yaml
- run: bun run diagnostics:tsc-sarif
- run: bun run diagnostics:eslint-sarif
- run: bun run diagnostics:prettier-sarif
- run: bun run diagnostics:collect --sarifPaths "tsc.sarif,eslint.sarif,prettier.sarif"
```

**Expected time**: < 30 seconds

### Medium Projects (1,000 - 10,000 findings)

```yaml
- run: bun run diagnostics:collect --sarifPaths "..." --diagnosticsDbPath /tmp/diagnostics.db
```

**Expected time**: < 2 minutes

### Large Projects (> 10,000 findings)

```yaml
- run: bun run diagnostics:collect --sarifPaths "..."
- uses: actions/cache@v3
  with:
    path: /tmp/ping-mem-diagnostics.db
    key: diagnostics-${{ hashFiles('src/**') }}
```

**Expected time**: < 5 minutes

---

## Performance Monitoring

### Key Metrics to Track

1. **Ingestion Throughput**: Findings per second
2. **Storage Growth**: DB size over time
3. **Query Latency**: p50, p95, p99 for common queries
4. **Cache Hit Rate**: For LLM summaries

### Prometheus Metrics (Future)

```typescript
// Example metrics to export
ping_mem_diagnostics_ingest_duration_ms
ping_mem_diagnostics_findings_total
ping_mem_diagnostics_store_size_bytes
ping_mem_diagnostics_query_duration_ms
ping_mem_llm_summary_cache_hit_rate
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.3.0 | 2026-01-29 | Initial performance documentation |

---

**Related Documents**:
- [DIAGNOSTICS_IMPLEMENTATION.md](../DIAGNOSTICS_IMPLEMENTATION.md)
- [CLAUDE.md](../CLAUDE.md)
