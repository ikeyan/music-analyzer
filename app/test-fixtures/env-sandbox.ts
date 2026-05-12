import { afterEach, beforeEach } from "bun:test";

// 渡された変数名と `${name}_FILE` ペアをテスト前に削除し afterEach で元値に戻す。
// `_FILE` を持たない変数 (NODE_ENV など) を渡しても削除は no-op で害なし
export function useEnvSandbox(names: readonly string[]): void {
  const keys = names.flatMap((n) => [n, `${n}_FILE`]);
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
  });
  afterEach(() => {
    for (const k of keys) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}
