// P2002 (unique) / P2034 (write conflict) の保険リトライ
export async function withSlotRetry<T>(fn: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 5;
  let err: unknown;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      const code = (err as { code?: string } | null)?.code;
      if (code !== "P2002" && code !== "P2034") throw err;
    }
  }
  throw err;
}
