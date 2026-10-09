#!/usr/bin/env bash
# Bring up this worktree's minimal DSH instance for manual validation.
# The instance home is <worktree>/.dsh-e2e-home; the port comes from acquire-port.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
exec dsh-e2e start --wait-ready
