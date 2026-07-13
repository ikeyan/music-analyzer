#!/usr/bin/env bash
# 環境setupから呼ばれるファイル名は固定。実体は scripts/setup-sandbox.ts
set -euo pipefail
exec bun "$(dirname -- "$0")/scripts/setup-sandbox.ts"
