## Diagnostics Collector CLI

This CLI is a deterministic, non-LLM capture mechanism. It reads SARIF output,
computes projectId/treeHash deterministically, stores diagnostics in the
DiagnosticsStore, and records a worklog event.

### Command

```
ping-mem collect \
  --projectDir /path/to/project \
  --configHash <hash> \
  --sarifPath /path/to/results.sarif \
  --toolName eslint \
  --toolVersion 9.0.0
```

### Recommended CI usage

1. Run your tool and emit SARIF.
2. Run the collector with the same project directory and config hash.

Example:
```
eslint --format sarif --output-file results.sarif .
ping-mem collect --projectDir . --configHash <hash> --sarifPath results.sarif
```

### Determinism inputs

- `projectId` and `treeHash` computed from local files
- `configHash` supplied by CI/IDE
- tool identity from CLI or SARIF

These ensure the same code state always yields the same analysisId.
