#!/usr/bin/env bun
import { $ } from "bun";
import { existsSync, openSync } from "node:fs";

if (process.env.CLAUDE_CODE_REMOTE !== "true") process.exit(0);

const dockerReady = async () => (await $`docker ps`.quiet().nothrow()).exitCode === 0;

const ensureDocker = async () => {
  if (await dockerReady()) return;
  const log = openSync("/tmp/dockerd.log", "a");
  Bun.spawn(["sudo", "dockerd"], {
    stdin: "ignore",
    stdout: log,
    stderr: log,
  }).unref();
  const deadline = Date.now() + 30_000;
  while (!(await dockerReady())) {
    if (Date.now() > deadline) throw new Error("dockerd not ready in 30s");
    await Bun.sleep(200);
  }
};

// Dockerfile / Dockerfile.app と同じ static-ffmpeg バイナリを /usr/local/bin に展開する。
// ffmpeg を必要とする bun test (ffprobe / transcode 等) で使う。docker 経由で取るので
// docker 起動後に呼ぶ前提
const FFMPEG_IMAGE = "mwader/static-ffmpeg:7.1.1";
const ensureFfmpeg = async () => {
  if ((await $`command -v ffmpeg`.quiet().nothrow()).exitCode === 0) return;
  await $`docker pull ${FFMPEG_IMAGE}`.quiet();
  await $`docker rm -f music-analyzer-ffmpeg-extract`.quiet().nothrow();
  await $`docker create --name music-analyzer-ffmpeg-extract ${FFMPEG_IMAGE}`.quiet();
  await $`sudo docker cp music-analyzer-ffmpeg-extract:/ffmpeg /usr/local/bin/ffmpeg`;
  await $`sudo docker cp music-analyzer-ffmpeg-extract:/ffprobe /usr/local/bin/ffprobe`;
  await $`docker rm music-analyzer-ffmpeg-extract`.quiet();
  await $`sudo chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe`;
};

const installDeps = async () => {
  const cwd = process.env.CLAUDE_PROJECT_DIR!;
  await $`bun install --frozen-lockfile`.cwd(cwd);
  await $`bun run db:generate`.cwd(cwd);
};

const pullAgentFiles = async () => {
  if (!existsSync("/root/agent-files")) return;
  await $`git -C /root/agent-files pull --ff-only`;
};

// docker は ensureFfmpeg だけが必要とするので chain でのみ await。
// installDeps / git remote / agent-files は docker と独立に走らせる
const docker = ensureDocker();
await Promise.all([
  docker.then(() => ensureFfmpeg()),
  installDeps(),
  $`git -C ${process.env.CLAUDE_PROJECT_DIR} remote set-head origin -a`,
  pullAgentFiles(),
]);
