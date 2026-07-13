#!/usr/bin/env bash
# ファイル名は ikeyan/agent-files の setup.sh から呼ばれる規約で固定
set -euo pipefail
exec bun "$(dirname -- "$0")/scripts/setup-sandbox.ts"
