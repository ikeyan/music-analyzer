import { describe, expect, it, mock } from "bun:test";
import { withSlotRetry } from "./prisma-retry";

describe("withSlotRetry", () => {
  it("returns the fn result on first success", async () => {
    const fn = mock(async () => 42);
    expect(await withSlotRetry(fn)).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on P2002 (unique conflict) until success", async () => {
    let calls = 0;
    const fn = mock(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("unique"), { code: "P2002" });
      return "ok";
    });
    expect(await withSlotRetry(fn)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on P2034 (write conflict) until success", async () => {
    let calls = 0;
    const fn = mock(async () => {
      calls++;
      if (calls < 2) throw Object.assign(new Error("write"), { code: "P2034" });
      return "ok";
    });
    expect(await withSlotRetry(fn)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-retriable errors immediately", async () => {
    const fn = mock(async () => {
      throw Object.assign(new Error("other"), { code: "P9999" });
    });
    await expect(withSlotRetry(fn)).rejects.toThrow("other");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rethrows non-coded errors immediately", async () => {
    const fn = mock(async () => {
      throw new Error("plain");
    });
    await expect(withSlotRetry(fn)).rejects.toThrow("plain");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after 5 attempts and rethrows the last retriable error", async () => {
    const fn = mock(async () => {
      throw Object.assign(new Error("still conflicting"), { code: "P2002" });
    });
    await expect(withSlotRetry(fn)).rejects.toThrow("still conflicting");
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("tolerates null thrown values (no `code` access crash)", async () => {
    const fn = mock(async () => {
      throw null;
    });
    await expect(withSlotRetry(fn)).rejects.toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
