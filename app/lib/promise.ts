// Promise.allSettled で結果を待ってから、reject があれば AggregateError でまとめて投げる。
// Promise.all は最初の reject で resolve するが、片肺の cleanup を確実に走らせるため
// 全部 settle させてから例外化したいときに使う
export async function awaitAllOrAggregate<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length}/${results.length} promises rejected`);
  }
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}
