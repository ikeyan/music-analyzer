// bun test 起動時に1度だけ走り、テスト用 SQLite DB を temp に作って schema を push する。
// その後 lib/prisma.ts が import されると process.env.DATABASE_URL を読んで client が
// 生成されるので、すべての test ファイルが同じ test DB を共有する。
// FAST_TESTS=1 のときは skip (純粋 unit のみ走らせたい場合の escape hatch)
import { $ } from "bun";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.FAST_TESTS !== "1") {
  const dir = await mkdtemp(join(tmpdir(), "music-analyzer-test-db-"));
  const url = `file:${join(dir, "test.db")}`;
  process.env.DATABASE_URL = url;

  // process exit 時に temp DB を破棄する。sync fs.rmSync で確実に消す
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* exit handler では throw できない */
    }
  });

  const result = await $`bun run prisma db push --accept-data-loss`
    .env({ ...process.env, DATABASE_URL: url })
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) {
    console.error(result.stderr.toString());
    throw new Error(`prisma db push failed during test preload (exit ${result.exitCode})`);
  }
}
