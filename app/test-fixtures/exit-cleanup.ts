// process.on("exit") は process 終了時にしか発火せず bun test の coverage では
// 計測不能。registration を専用ファイルに切り出して coveragePathIgnorePatterns
// で1ファイルだけ除外する
import { rmSync } from "node:fs";

const dirs = new Set<string>();

process.on("exit", () => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* exit handler では throw できない */
    }
  }
});

export function registerForExitCleanup(dir: string): void {
  dirs.add(dir);
}
