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

const setupSandbox = async () => {
  await ensureDocker();
  await $`${process.env.CLAUDE_PROJECT_DIR}/.setup-sandbox.sh`;
};

const pullAgentFiles = async () => {
  if (!existsSync("/root/agent-files")) return;
  await $`git -C /root/agent-files pull --ff-only`;
};

await Promise.all([
  setupSandbox(),
  $`git -C ${process.env.CLAUDE_PROJECT_DIR} remote set-head origin -a`,
  pullAgentFiles(),
]);
