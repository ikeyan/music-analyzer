#!/usr/bin/env bun
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { $ } from "bun";
import { MINIO_IMAGE } from "../app/test-images";
import { installDeps } from "./install-deps";
import { step } from "./log-step";

const root = join(import.meta.dir, "..");

const commandExists = async (command: string) => {
  const result = await $`which ${command}`.quiet().nothrow();
  return result.exitCode === 0;
};

const waitForDockerApi = async (socket: string, attempts = 20) => {
  for (let i = 0; i < attempts; i++) {
    const result = await $`curl --unix-socket ${socket} -fsS http://d/_ping`.quiet().nothrow();
    if (result.exitCode === 0) return true;
    await Bun.sleep(250);
  }
  return false;
};

const ensureDockerApi = async () => {
  if (!(await commandExists("docker"))) return;

  const dockerVersion = await $`docker --version`
    .quiet()
    .text()
    .catch(() => "");
  const usesPodman = dockerVersion.toLowerCase().includes("podman");
  if (!usesPodman) return;
  if (!(await commandExists("podman"))) return;

  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  const socket = join(runtimeDir, "podman/podman.sock");
  const env = { ...process.env, DOCKER_HOST: `unix://${socket}` };

  await $`mkdir -p ${dirname(socket)}`.quiet();
  await $`systemctl --user start podman.socket`.quiet().nothrow();
  if (!(await waitForDockerApi(socket, 4))) {
    spawn("podman", ["system", "service", "--time=0", `unix://${socket}`], {
      detached: true,
      stdio: "ignore",
      env,
    }).unref();
  }

  if (!(await waitForDockerApi(socket))) {
    throw new Error(
      `Docker Compose requires a Docker API socket, but ${env.DOCKER_HOST} did not become ready`,
    );
  }
  process.env.DOCKER_HOST = env.DOCKER_HOST;
};

// sandbox の MITM proxy CA を build context に置き、Dockerfile.app の bun install が
// TLS 検証に使えるようにする。NODE_EXTRA_CA_CERTS が未設定/読めなければ空ファイル
// (bun は空 CA を警告付きで無視し built-in CA にフォールバックする)
const stageProxyCa = async () => {
  const ca = await Bun.file(process.env.NODE_EXTRA_CA_CERTS ?? "")
    .bytes()
    .catch(() => new Uint8Array());
  await Bun.write(join(root, "proxy-ca.crt"), ca);
};

await step`installDeps (bun install / prisma generate)`(() => installDeps(root));
await step`stage proxy CA (NODE_EXTRA_CA_CERTS)`(stageProxyCa);
await step`ensure docker API`(ensureDockerApi);

// node_modules なしで起動した bun プロセスは bun install 後も bare specifier を
// 正しく解決できないためサブプロセスで import する
const REAPER_IMAGE = await step`resolve REAPER_IMAGE`(async () =>
  (
    await $`bun -e ${'console.log((await import("testcontainers/build/reaper/reaper.js")).REAPER_IMAGE)'}`
      .cwd(root)
      .text()
  ).trim(),
);
const authentik = join(root, "e2e/authentik");

const steps = [
  step`docker pull ${MINIO_IMAGE}`(() => $`docker pull ${MINIO_IMAGE}`),
  step`docker pull ${REAPER_IMAGE}`(() => $`docker pull ${REAPER_IMAGE}`),
  // build-only serviceをpull対象から外さないとimage未公開で失敗する
  step`docker compose pull (authentik)`(() =>
    $`docker compose --env-file .env.example pull --ignore-buildable`.cwd(authentik),
  ),
  step`docker compose build music-analyzer`(() =>
    $`docker compose --env-file .env.example build music-analyzer`.cwd(authentik),
  ),
];

const results = await Promise.allSettled(steps);
const failed = results.flatMap((r, i) =>
  r.status === "rejected" ? [{ name: steps[i].name, reason: r.reason }] : [],
);
for (const { name, reason } of failed) console.error(`[setup] ✗ ${name} の失敗理由:`, reason);
if (failed.length > 0) {
  console.error(`[setup] ${failed.length}/${steps.length} ステップが失敗しました`);
  process.exit(1);
}
console.error("[setup] 完了");
