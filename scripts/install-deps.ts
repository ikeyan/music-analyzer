import { mkdir, unlink } from "node:fs/promises";
import { $ } from "bun";

const sha256 = async (path: string) =>
  new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");

// @prisma/engines の postinstall (Node https) は sandbox の proxy 環境と相性が悪い
// (claude web は proxy 経由だと ECONNRESET、codex cloud は proxy 必須)。どちらでも
// proxy 設定どおりに動く curl で先に ~/.cache/prisma へ配置し、postinstall を
// キャッシュヒットで済ませる
const prefetchPrismaEngine = async (root: string) => {
  const lock = await Bun.file(`${root}/bun.lock`).text();
  const commit = lock.match(/"@prisma\/engines-version@[^"]*\.([0-9a-f]{40})"/)?.[1];
  if (!commit) throw new Error("bun.lock に @prisma/engines-version が見つからない");
  const target = process.arch === "arm64" ? "linux-arm64-openssl-3.0.x" : "debian-openssl-3.0.x";
  const dir = `${process.env.HOME}/.cache/prisma/master/${commit}/${target}`;
  if (await Bun.file(`${dir}/schema-engine`).exists()) return;
  await mkdir(dir, { recursive: true });
  const url = `https://binaries.prisma.sh/all_commits/${commit}/${target}/schema-engine.gz`;
  await $`curl -fsSL --retry 3 -o ${dir}/schema-engine.gz ${url}`;
  await $`gunzip -kf ${dir}/schema-engine.gz`;
  await $`chmod +x ${dir}/schema-engine`;
  await Bun.write(`${dir}/schema-engine.gz.sha256`, await sha256(`${dir}/schema-engine.gz`));
  await Bun.write(`${dir}/schema-engine.sha256`, await sha256(`${dir}/schema-engine`));
  await unlink(`${dir}/schema-engine.gz`);
};

export const installDeps = async (root: string) => {
  await prefetchPrismaEngine(root);
  await $`bun install --frozen-lockfile`.cwd(root);
  await $`bun run db:generate`.cwd(root);
};
