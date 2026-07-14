// セットアップ各段階の開始/成功/失敗と所要時間を出す。sandbox のログから
// どの段階で失敗したか特定するため。step`name`(fn) で使い、返る Promise に name が
// 乗るので Promise.allSettled の結果と対応付けられる
const secs = (start: number) => ((performance.now() - start) / 1000).toFixed(1);

export const step = (strings: TemplateStringsArray, ...subs: unknown[]) => {
  const label = String.raw(strings, ...subs);
  return <T>(fn: () => Promise<T>): Promise<T> & { name: string } => {
    const run = (async () => {
      const start = performance.now();
      console.error(`[setup] ▶ ${label}`);
      try {
        const result = await fn();
        console.error(`[setup] ✓ ${label} (${secs(start)}s)`);
        return result;
      } catch (e) {
        console.error(`[setup] ✗ ${label} (${secs(start)}s)`);
        throw e;
      }
    })();
    return Object.assign(run, { name: label });
  };
};
