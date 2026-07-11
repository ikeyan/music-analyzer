#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname -- "$0")"

# Prisma のエンジン取得は Node の CONNECT トンネル上 TLS を使うが、agent proxy 経由だと
# 転送が途中で切れる (ECONNRESET)。binaries.prisma.sh へは直結が速く確実なので、この
# ホストだけ proxy を迂回させて install の postinstall と db:generate を通す
export NO_PROXY="binaries.prisma.sh,${NO_PROXY:-}"
export no_proxy="binaries.prisma.sh,${no_proxy:-}"

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
