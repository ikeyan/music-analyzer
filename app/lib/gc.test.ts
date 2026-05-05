import { describe, expect, it } from "bun:test";
import { BASE_RETRY_DELAY_MS, nextRetryDelayMs } from "./gc";

describe("nextRetryDelayMs", () => {
  it("returns base delay range for attempts=0", () => {
    // 0.5..1.0 倍の jitter
    const min = nextRetryDelayMs(0, () => 0);
    const max = nextRetryDelayMs(0, () => 1);
    expect(min).toBe(BASE_RETRY_DELAY_MS * 0.5);
    expect(max).toBe(BASE_RETRY_DELAY_MS);
  });

  it("doubles per attempt", () => {
    expect(nextRetryDelayMs(1, () => 1)).toBe(BASE_RETRY_DELAY_MS * 2);
    expect(nextRetryDelayMs(2, () => 1)).toBe(BASE_RETRY_DELAY_MS * 4);
    expect(nextRetryDelayMs(10, () => 1)).toBe(BASE_RETRY_DELAY_MS * 1024);
  });

  it("clamps to MAX_SAFE_INTEGER for very large attempts", () => {
    const huge = nextRetryDelayMs(200, () => 1);
    expect(Number.isFinite(huge)).toBe(true);
    expect(huge).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });

  it("treats negative attempts as 0", () => {
    expect(nextRetryDelayMs(-5, () => 1)).toBe(BASE_RETRY_DELAY_MS);
  });

  it("rounds non-integer attempts down", () => {
    expect(nextRetryDelayMs(1.9, () => 1)).toBe(BASE_RETRY_DELAY_MS * 2);
  });
});
