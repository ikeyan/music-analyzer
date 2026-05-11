import type { $ } from "bun";

// $ コマンドを実行し、非0 終了なら label と stderr 抜粋を含む Error を投げる。
// .nothrow() のあとに毎回書く exitCode チェックを集約する
export async function runShell(label: string, cmd: ReturnType<typeof $>): Promise<void> {
  const result = await cmd.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed (exit ${result.exitCode}): ${result.stderr.toString().slice(0, 1000)}`,
    );
  }
}
