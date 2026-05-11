// bunfig.toml preload。FAST_TESTS=1 で skip (純粋 unit のみ走らせる escape hatch)
import { $ } from "bun";
import { join } from "node:path";
import { runShell } from "../lib/shell";
import { makePersistentTempDir } from "./temp";

if (process.env.FAST_TESTS !== "1") {
  const dir = await makePersistentTempDir("music-analyzer-test-db-");
  const url = `file:${join(dir, "test.db")}`;
  process.env.DATABASE_URL = url;

  await runShell(
    "prisma db push (test preload)",
    $`bun run db:push --accept-data-loss`.env({ ...process.env, DATABASE_URL: url }),
  );
}
