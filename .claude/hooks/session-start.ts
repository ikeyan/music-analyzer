#!/usr/bin/env bun
import { $ } from "bun";
import { existsSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tempDir } from "../../app/lib/temp-dir";
import { CHROME_VERSION, installChrome } from "../../scripts/install-chrome";
import { installFfmpeg } from "../../scripts/install-ffmpeg";

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

const ensureFfmpeg = async () => {
  if ((await $`command -v ffmpeg`.quiet().nothrow()).exitCode === 0) return;
  await installFfmpeg("/usr/local/bin");
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

// session 跨ぎで残るよう /opt/chrome-for-testing/<version>/ にインストール
const CHROME_DIR = `/opt/chrome-for-testing/${CHROME_VERSION}`;
const CHROME_WRAP = "/opt/chrome-for-testing/chrome-wrap";
const ensureChrome = async () => {
  if (existsSync(`${CHROME_DIR}/chrome`) && existsSync(CHROME_WRAP)) return;
  await mkdir(CHROME_DIR, { recursive: true });
  await installChrome(CHROME_DIR, CHROME_WRAP);
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
