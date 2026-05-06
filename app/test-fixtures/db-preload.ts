// bunfig.toml preload。FAST_TESTS=1 で skip (純粋 unit のみ走らせる escape hatch)
import { $ } from "bun";
import { join } from "node:path";
import { makePersistentTempDir } from "./temp";

if (process.env.FAST_TESTS !== "1") {
  const dir = await makePersistentTempDir("music-analyzer-test-db-");
  const url = `file:${join(dir, "test.db")}`;
  process.env.DATABASE_URL = url;

  const result = await $`bun run prisma db push --accept-data-loss`
    .env({ ...process.env, DATABASE_URL: url })
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) {
    console.error(result.stderr.toString());
    throw new Error(`prisma db push failed during test preload (exit ${result.exitCode})`);
  }
}
