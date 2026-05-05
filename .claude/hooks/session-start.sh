#!/bin/bash
set -euo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" != "true" ] && exit 0

if ! docker ps >/dev/null 2>&1; then
  sudo dockerd > /tmp/dockerd.log 2>&1 &
  timeout 30 sh -c 'until docker ps >/dev/null 2>&1; do sleep 0.2; done'
fi

git -C "$CLAUDE_PROJECT_DIR" remote set-head origin -a

git -C /root/agent-files pull --ff-only
