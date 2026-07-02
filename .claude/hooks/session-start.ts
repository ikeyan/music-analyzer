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

// .bun-version pin に合わせて /root/.bun/bin/bun を入れ替える。bun.com/install も
// GitHub release も sandbox の egress policy で 403 になるため、allowlist 済みの
// npm registry から platform tarball (package/bin/bun) を取る
const ensureBunVersion = async () => {
  const cwd = process.env.CLAUDE_PROJECT_DIR!;
  const target = (await Bun.file(`${cwd}/.bun-version`).text()).trim();
  if (Bun.version === target) return;
  const pkg = process.arch === "arm64" ? "bun-linux-aarch64" : "bun-linux-x64";
  const url = `https://registry.npmjs.org/@oven/${pkg}/-/${pkg}-${target}.tgz`;
  await using td = await tempDir(`bun-upgrade-${target}`);
  await $`curl -fsSL ${url} -o ${td.path}/bun.tgz`.quiet();
  await $`tar xzf ${td.path}/bun.tgz -C ${td.path}`.quiet();
  await $`install -m 755 ${td.path}/package/bin/bun /root/.bun/bin/bun`.quiet();
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
  // Prisma のエンジン取得は proxy 経由の Node https が転送途中で ECONNRESET する。
  // binaries.prisma.sh は直結が速く確実なのでこのホストだけ proxy を迂回する
  const noProxy = `binaries.prisma.sh,${process.env.NO_PROXY ?? ""}`;
  const env = { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy };
  await $`bun install --frozen-lockfile`.cwd(cwd).env(env);
  await $`bun run db:generate`.cwd(cwd).env(env);
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
