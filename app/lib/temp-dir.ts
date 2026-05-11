import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type DisposableTempDir = { path: string } & AsyncDisposable;

// await using でスコープ終了時に rm するテンポラリディレクトリ
export async function tempDir(prefix: string): Promise<DisposableTempDir> {
  const path = await mkdtemp(join(tmpdir(), `${prefix}-`));
  return {
    path,
    [Symbol.asyncDispose]: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}
