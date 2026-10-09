#!/usr/bin/env bash
# Install and verify this worktree's own dependencies.
set -euo pipefail
cd "$(dirname "$0")/.."

npm install --no-audit --no-fund
npm run check
echo "worktree ready: $(pwd)"
