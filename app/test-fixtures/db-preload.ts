// bun test 起動時に1度だけ走り、テスト用 SQLite DB を temp に作って schema を push する。
// その後 lib/prisma.ts が import されると process.env.DATABASE_URL を読んで client が
// 生成されるので、すべての test ファイルが同じ test DB を共有する。
// FAST_TESTS=1 のときは skip (純粋 unit のみ走らせたい場合の escape hatch)
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.FAST_TESTS !== "1") {
  const dir = await mkdtemp(join(tmpdir(), "music-analyzer-test-db-"));
  const dbPath = join(dir, "test.db");
  const url = `file:${dbPath}`;
  process.env.DATABASE_URL = url;

  const proc = Bun.spawn(["bun", "run", "prisma", "db", "push", "--accept-data-loss"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DATABASE_URL: url },
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    console.error(stderr);
    throw new Error(`prisma db push failed during test preload (exit ${exitCode})`);
  }
}
