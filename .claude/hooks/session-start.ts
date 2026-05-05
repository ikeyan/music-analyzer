#!/usr/bin/env bun
import { $ } from "bun";
import { openSync } from "node:fs";

if (process.env.CLAUDE_CODE_REMOTE !== "true") process.exit(0);

const dockerReady = async () =>
  (await $`docker ps`.quiet().nothrow()).exitCode === 0;

if (!(await dockerReady())) {
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
}

await $`git -C ${process.env.CLAUDE_PROJECT_DIR} remote set-head origin -a`;
await $`git -C /root/agent-files pull --ff-only`;
