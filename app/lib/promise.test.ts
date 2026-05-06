import { describe, expect, it } from "bun:test";
import { awaitAllOrAggregate } from "./promise";

describe("awaitAllOrAggregate", () => {
  it("returns values in order when all resolve", async () => {
    const result = await awaitAllOrAggregate([Promise.resolve(1), Promise.resolve(2)]);
    expect(result).toEqual([1, 2]);
  });

  it("returns [] for empty input", async () => {
    expect(await awaitAllOrAggregate([])).toEqual([]);
  });

  it("waits for all to settle even when some reject early", async () => {
    let lateResolved = false;
    const late = new Promise<number>((resolve) => {
      setTimeout(() => {
        lateResolved = true;
        resolve(2);
      }, 20);
    });
    try {
      await awaitAllOrAggregate([Promise.reject(new Error("early")), late]);
    } catch {
      /* expected */
    }
    expect(lateResolved).toBe(true);
  });

  it("throws AggregateError that carries all rejection reasons in order", async () => {
    const err1 = new Error("a");
    const err2 = new Error("b");
    let caught: unknown;
    try {
      await awaitAllOrAggregate([Promise.reject(err1), Promise.resolve(1), Promise.reject(err2)]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const agg = caught as AggregateError;
    expect(agg.errors).toEqual([err1, err2]);
    expect(agg.message).toContain("2/3");
  });
});
