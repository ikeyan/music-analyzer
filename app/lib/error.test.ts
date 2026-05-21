import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import { describeError } from "./error";

describe("describeError", () => {
  // 性質: Error 系 (subclass 含む) は message.slice(0, 500)。長短両方を踏むよう maxLength=2000
  it("Error は message.slice(0, 500)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (msg) => {
        expect(describeError(new Error(msg))).toBe(msg.slice(0, 500));
      }),
      { numRuns: 30 },
    );
  });

  // 性質: 非 Error でも throw せず string を返し 500 char 以下に収まる。
  // (toString が壊れた値でも fallback で安全に文字列化することを担保)
  it("非 Error でも throw せず string<=500 を返す", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        fc.pre(!(v instanceof Error));
        const got = describeError(v);
        expect(typeof got).toBe("string");
        expect(got.length).toBeLessThanOrEqual(500);
      }),
      { numRuns: 30 },
    );
  });

  // 性質: 普通に String() できる値は String(v).slice(0, 500) と一致
  it("String() が動く値は String(v).slice(0, 500) と一致", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        fc.pre(!(v instanceof Error));
        let expected: string;
        try {
          expected = String(v).slice(0, 500);
        } catch {
          fc.pre(false);
          return;
        }
        expect(describeError(v)).toBe(expected);
      }),
      { numRuns: 30 },
    );
  });
});
