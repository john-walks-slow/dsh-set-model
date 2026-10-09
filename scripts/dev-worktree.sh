#!/usr/bin/env bash
# Bring up this worktree's minimal DSH instance for manual validation.
# The instance home is <worktree>/.dsh-e2e-home; the port comes from acquire-port.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
# --patch 会把 e2e/fixture/cordis.patch.yml 播种到 profile 的用户 patch 层：
# 档位模式下才有档位表可看，而且用户层是设置页可写的（覆盖层不行）。
exec dsh-e2e start --wait-ready --patch "$PWD/e2e/fixture/cordis.patch.yml"
