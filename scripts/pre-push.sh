#!/bin/bash
set -e

echo "[pre-push] Running typecheck..."
bun run typecheck

echo "[pre-push] Running tests..."
bun test

echo "[pre-push] All checks passed."
