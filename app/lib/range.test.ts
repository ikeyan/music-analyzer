import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import { parseRange } from "./range";

describe("parseRange", () => {
  const TOTAL = 1000;

  it("header 不在 (undefined/null/empty) は null", () => {
    for (const h of [undefined, null, ""]) expect(parseRange(h, TOTAL)).toBeNull();
  });

  // 性質: 0 <= a <= b < total な bytes=a-b はそのまま返す。境界 (a=0, b=total-1) も含めるため
  // start/end は同じレンジから引いて preconds で a <= b に絞る
  it("0<=a<=b<total な bytes=a-b は { start: a, end: b } を返す", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: TOTAL - 1 }),
        fc.integer({ min: 0, max: TOTAL - 1 }),
        (a, b) => {
          fc.pre(a <= b);
          expect(parseRange(`bytes=${a}-${b}`, TOTAL)).toEqual({ start: a, end: b });
        },
      ),
      { numRuns: 30 },
    );
  });

  // 性質: bytes=-n は末尾 min(n, total) バイト。n >= total は start=0 に clamp
  it("bytes=-n は末尾 min(n, total) バイトを返す", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: TOTAL * 3 }), (n) => {
        expect(parseRange(`bytes=-${n}`, TOTAL)).toEqual({
          start: Math.max(0, TOTAL - n),
          end: TOTAL - 1,
        });
      }),
      { numRuns: 20 },
    );
  });

  // 性質: bytes=a- (open-ended) は a..total-1。a < total を要求するレンジで生成
  it("bytes=a- (a<total) は { start: a, end: total-1 }", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: TOTAL - 1 }), (a) => {
        expect(parseRange(`bytes=${a}-`, TOTAL)).toEqual({ start: a, end: TOTAL - 1 });
      }),
      { numRuns: 20 },
    );
  });

  // 性質: end >= total は total-1 に clamp (RFC 7233 §2.1)
  it("過大な end は total-1 に clamp", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: TOTAL - 1 }),
        fc.integer({ min: TOTAL, max: TOTAL * 100 }),
        (a, b) => {
          expect(parseRange(`bytes=${a}-${b}`, TOTAL)).toEqual({ start: a, end: TOTAL - 1 });
        },
      ),
      { numRuns: 20 },
    );
  });

  // 性質: start >= total は両形式とも "invalid"
  it("start>=total は invalid", () => {
    fc.assert(
      fc.property(fc.integer({ min: TOTAL, max: TOTAL * 100 }), (a) => {
        expect(parseRange(`bytes=${a}-${a + 10}`, TOTAL)).toBe("invalid");
        expect(parseRange(`bytes=${a}-`, TOTAL)).toBe("invalid");
      }),
      { numRuns: 20 },
    );
  });

  // 性質: a>b (どちらも total 未満) は invalid
  it("start>end は invalid", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: TOTAL - 1 }),
        fc.integer({ min: 0, max: TOTAL - 2 }),
        (a, b) => {
          fc.pre(a > b);
          expect(parseRange(`bytes=${a}-${b}`, TOTAL)).toBe("invalid");
        },
      ),
      { numRuns: 20 },
    );
  });

  it("malformed header は invalid", () => {
    for (const h of ["items=0-10", "bytes=abc-def", "bytes="]) {
      expect(parseRange(h, TOTAL)).toBe("invalid");
    }
  });
});
