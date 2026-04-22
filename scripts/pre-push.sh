#!/bin/bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
echo "[pre-push] Running typecheck..."
bun run typecheck
echo "[pre-push] Running tests..."
bun test
echo "[pre-push] All checks passed."
