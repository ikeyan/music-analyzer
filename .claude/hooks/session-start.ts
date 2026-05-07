#!/usr/bin/env bun
import { $ } from "bun";
import { existsSync, openSync } from "node:fs";
import { tempDir } from "../../app/lib/ffmpeg";

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

// .bun-version pin に合わせて /root/.bun/bin/bun を入れ替える。bun.com/install は
// sandbox から 403 になるので GitHub release zip を直接展開
const ensureBunVersion = async () => {
  const cwd = process.env.CLAUDE_PROJECT_DIR!;
  const target = (await Bun.file(`${cwd}/.bun-version`).text()).trim();
  if (Bun.version === target) return;
  const arch = process.arch === "arm64" ? "aarch64" : "x64";
  const dirName = `bun-linux-${arch}`;
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${target}/${dirName}.zip`;
  await using td = await tempDir(`bun-upgrade-${target}`);
  await $`curl -fsSL ${url} -o ${td.path}/bun.zip`.quiet();
  await $`unzip -q -o ${td.path}/bun.zip -d ${td.path}`.quiet();
  await $`install -m 755 ${td.path}/${dirName}/bun /root/.bun/bin/bun`.quiet();
};

// Bun.WebView 用 Chrome (--no-sandbox 付きの wrapper script 経由)。session 跨ぎで
// 残るよう /opt/chrome-for-testing/<version>/ にインストール。dl.google は 403、
// chrome snap は sandbox 不可なので chrome-for-testing zip を直接展開
const CHROME_VERSION = "141.0.7390.107";
const CHROME_DIR = `/opt/chrome-for-testing/${CHROME_VERSION}`;
const CHROME_WRAP = "/opt/chrome-for-testing/chrome-wrap";
const ensureChrome = async () => {
  if (existsSync(`${CHROME_DIR}/chrome`) && existsSync(CHROME_WRAP)) return;
  const arch = process.arch === "arm64" ? "linux64" : "linux64";
  const dirName = `chrome-${arch}`;
  const url = `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${arch}/${dirName}.zip`;
  await using td = await tempDir(`chrome-${CHROME_VERSION}`);
  await $`curl -fsSL ${url} -o ${td.path}/chrome.zip`.quiet();
  await $`unzip -q -o ${td.path}/chrome.zip -d ${td.path}`.quiet();
  await $`sudo mkdir -p ${CHROME_DIR}`;
  await $`sudo cp -r ${td.path}/${dirName}/. ${CHROME_DIR}/`;
  // root 実行で Chrome の zygote sandbox が動かないため wrapper で --no-sandbox を強制
  await $`sudo tee ${CHROME_WRAP}`
    .stdin(`#!/bin/sh\nexec ${CHROME_DIR}/chrome --no-sandbox "$@"\n`)
    .quiet();
  await $`sudo chmod +x ${CHROME_WRAP}`;
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
// installDeps は新しい bun が要るので ensureBunVersion 完了を待つ
const docker = ensureDocker();
const bun = ensureBunVersion();
await Promise.all([
  docker.then(() => ensureFfmpeg()),
  bun.then(() => installDeps()),
  ensureChrome(),
  $`git -C ${process.env.CLAUDE_PROJECT_DIR} remote set-head origin -a`,
  pullAgentFiles(),
]);
