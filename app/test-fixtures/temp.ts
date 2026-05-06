import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerForExitCleanup } from "./exit-cleanup";

// process スコープの temp dir。exit で同期 rmSync するまでを束ねる
export async function makePersistentTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  registerForExitCleanup(dir);
  return dir;
}
