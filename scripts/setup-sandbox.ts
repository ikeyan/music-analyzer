#!/usr/bin/env bun
import { join } from "node:path";
import { $ } from "bun";
import { MINIO_IMAGE } from "../app/test-images";
import { installDeps } from "./install-deps";

const root = join(import.meta.dir, "..");

const commandExists = async (command: string) =>
  (await $`which ${command}`.quiet().nothrow()).exitCode === 0;

const getContainerRuntime = async () => {
  const runtime = process.env.SETUP_SANDBOX_CONTAINER_RUNTIME;
  if (runtime) {
    if (await commandExists(runtime)) return runtime;
    throw new Error(`${runtime} が見つかりません`);
  }
  if (await commandExists("docker")) return "docker";
  if (await commandExists("podman")) return "podman";
  throw new Error("docker も podman も見つかりません");
};

await installDeps(root);

// node_modules なしで起動した bun プロセスは bun install 後も bare specifier を
// 正しく解決できないことがあるため、サブプロセスで import する
const REAPER_IMAGE = (
  await $`bun -e ${'console.log((await import("testcontainers/build/reaper/reaper.js")).REAPER_IMAGE)'}`
    .cwd(root)
    .text()
).trim();
const authentik = join(root, "e2e/authentik");
const containerRuntime = await getContainerRuntime();
const results = await Promise.allSettled([
  $`${containerRuntime} pull ${MINIO_IMAGE}`,
  $`${containerRuntime} pull ${REAPER_IMAGE}`,
  // build-only serviceをpull対象から外さないとimage未公開で失敗する
  $`${containerRuntime} compose --env-file .env.example pull --ignore-buildable`.cwd(authentik),
  $`${containerRuntime} compose --env-file .env.example build music-analyzer`.cwd(authentik),
]);
const failed = results.filter((r) => r.status === "rejected");
for (const f of failed) console.error(f.reason);
if (failed.length > 0) process.exit(1);
