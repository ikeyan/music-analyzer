#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname -- "$0")"

bun install --frozen-lockfile
bun run db:generate

minio_image=$(bun -e 'console.log((await import("./app/test-images.ts")).MINIO_IMAGE)')
ryuk_image=$(bun -e 'console.log((await import("testcontainers/build/reaper/reaper.js")).REAPER_IMAGE)')

docker pull "$minio_image" &
minio_pid=$!
docker pull "$ryuk_image" &
ryuk_pid=$!

pushd e2e/authentik > /dev/null
# build-only serviceをpull対象から外さないとimage未公開で失敗する
docker compose --env-file .env.example pull --ignore-buildable &
compose_pull_pid=$!
docker compose --env-file .env.example build music-analyzer &
compose_build_pid=$!
popd > /dev/null

status=0
for pid in "$minio_pid" "$ryuk_pid" "$compose_pull_pid" "$compose_build_pid"; do
  wait "$pid" || status=$?
done
[ "$status" -eq 0 ]
