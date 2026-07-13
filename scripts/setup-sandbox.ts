#!/usr/bin/env bun
import { join } from "node:path";
import { $ } from "bun";
import { MINIO_IMAGE } from "../app/test-images";
import { installDeps } from "./install-deps";
import { step } from "./log-step";

const root = join(import.meta.dir, "..");

await step("installDeps (bun install / prisma generate)", () => installDeps(root));

// node_modules なしで起動した bun プロセスは bun install 後も bare specifier を
// 正しく解決できないことがあるため、サブプロセスで import する
const REAPER_IMAGE = await step("resolve REAPER_IMAGE", async () =>
  (
    await $`bun -e ${'console.log((await import("testcontainers/build/reaper/reaper.js")).REAPER_IMAGE)'}`
      .cwd(root)
      .text()
  ).trim(),
);
const authentik = join(root, "e2e/authentik");

const steps = [
  { name: `docker pull ${MINIO_IMAGE}`, run: () => $`docker pull ${MINIO_IMAGE}` },
  { name: `docker pull ${REAPER_IMAGE}`, run: () => $`docker pull ${REAPER_IMAGE}` },
  // build-only serviceをpull対象から外さないとimage未公開で失敗する
  {
    name: "docker compose pull (authentik)",
    run: () => $`docker compose --env-file .env.example pull --ignore-buildable`.cwd(authentik),
  },
  {
    name: "docker compose build music-analyzer",
    run: () => $`docker compose --env-file .env.example build music-analyzer`.cwd(authentik),
  },
];

const results = await Promise.allSettled(steps.map((s) => step(s.name, s.run)));
const failed = results.flatMap((r, i) => (r.status === "rejected" ? [{ r, name: steps[i].name }] : []));
for (const { r, name } of failed) console.error(`[setup] ✗ ${name} の失敗理由:`, (r as PromiseRejectedResult).reason);
if (failed.length > 0) {
  console.error(`[setup] ${failed.length}/${steps.length} ステップが失敗しました`);
  process.exit(1);
}
console.error("[setup] 完了");
