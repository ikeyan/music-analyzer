import { describe, expect, it } from "bun:test";
import { parseRange } from "./range";

describe("parseRange", () => {
  const TOTAL = 1000;

  it("returns null when no header", () => {
    expect(parseRange(undefined, TOTAL)).toBeNull();
    expect(parseRange(null, TOTAL)).toBeNull();
    expect(parseRange("", TOTAL)).toBeNull();
  });

  it("parses bytes=start-end", () => {
    expect(parseRange("bytes=0-99", TOTAL)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=100-499", TOTAL)).toEqual({ start: 100, end: 499 });
  });

  it("parses bytes=start- as start..EOF", () => {
    expect(parseRange("bytes=500-", TOTAL)).toEqual({ start: 500, end: 999 });
  });

  it("parses suffix range bytes=-N as last N bytes", () => {
    expect(parseRange("bytes=-100", TOTAL)).toEqual({ start: 900, end: 999 });
    // suffix larger than total clamps start to 0
    expect(parseRange("bytes=-9999", TOTAL)).toEqual({ start: 0, end: 999 });
  });

  it("clamps oversized end to total-1 (RFC 7233 §2.1)", () => {
    expect(parseRange("bytes=0-999999", TOTAL)).toEqual({ start: 0, end: 999 });
  });

  it("returns invalid for malformed header", () => {
    expect(parseRange("items=0-10", TOTAL)).toBe("invalid");
    expect(parseRange("bytes=abc-def", TOTAL)).toBe("invalid");
    expect(parseRange("bytes=", TOTAL)).toBe("invalid");
  });

  it("returns invalid for start >= total", () => {
    expect(parseRange("bytes=1000-1010", TOTAL)).toBe("invalid");
    expect(parseRange("bytes=1500-", TOTAL)).toBe("invalid");
  });

  it("returns invalid for start > end", () => {
    expect(parseRange("bytes=500-100", TOTAL)).toBe("invalid");
  });
});
