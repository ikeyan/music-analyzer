// セットアップ各段階の開始/成功/失敗と所要時間を出す。sandbox のログから
// どの段階で失敗したか特定するため
export const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const start = Date.now();
  console.error(`[setup] ▶ ${name}`);
  try {
    const result = await fn();
    console.error(`[setup] ✓ ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    return result;
  } catch (e) {
    console.error(`[setup] ✗ ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    throw e;
  }
};
