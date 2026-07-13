#!/usr/bin/env bash
set -euo pipefail

if ! command -v podman >/dev/null 2>&1; then
  apt-get update
  apt-get install -y podman uidmap slirp4netns fuse-overlayfs
fi

arch=$(uname -m)
case "$arch" in
  x86_64 | aarch64) ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac

compose=/usr/local/bin/docker-compose
curl -fsSL --retry 3 "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$arch" -o "$compose"
chmod +x "$compose"

mkdir -p /etc/containers/registries.conf.d
cat >/etc/containers/registries.conf.d/000-docker-io.conf <<'CONF'
unqualified-search-registries = ["docker.io"]
short-name-mode = "permissive"
CONF

podman --version
docker-compose version
