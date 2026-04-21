#!/bin/bash
set -euo pipefail
echo "[pre-push] Running typecheck..."
bun run typecheck
echo "[pre-push] Running lint..."
bun run lint
echo "[pre-push] Running tests..."
bun test
echo "[pre-push] All checks passed."
