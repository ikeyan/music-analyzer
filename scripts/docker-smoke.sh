#!/usr/bin/env bash
# Build the prod Dockerfile, boot the container with an empty volume, probe
# the root URL, then tear everything down. Use to sanity-check schema sync,
# server boot, and port 3000 wiring before merging Dockerfile changes.
set -euo pipefail

IMAGE_TAG="music-analyzer:smoke"
CONTAINER="music-analyzer-smoke"
HOST_PORT="${HOST_PORT:-13000}"
DATA_DIR="$(mktemp -d)"

cleanup() {
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

cd "$(dirname "$0")/.."

echo "[build] $IMAGE_TAG"
docker build -q -t "$IMAGE_TAG" .

echo "[run] $CONTAINER on 127.0.0.1:$HOST_PORT (data=$DATA_DIR)"
docker run --rm -d --name "$CONTAINER" \
  -p "127.0.0.1:$HOST_PORT:3000" \
  -v "$DATA_DIR:/data" \
  "$IMAGE_TAG" >/dev/null

echo "[wait] startup (up to 30s)"
status=000
for i in $(seq 1 30); do
  status=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$HOST_PORT/" || echo 000)
  [ "$status" = "200" ] && { echo "[ok] http=200 after ${i}s"; exit 0; }
  sleep 1
done

echo "[fail] no 200 within 30s; last status=$status" >&2
docker logs "$CONTAINER" >&2 || true
exit 1
