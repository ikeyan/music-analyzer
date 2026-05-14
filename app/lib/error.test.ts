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

  // 性質: 非 Error は String(v).slice(0, 500)。プリミティブ/オブジェクト/null/undefined を網羅
  it("非 Error は String(v).slice(0, 500)", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        fc.pre(!(v instanceof Error));
        expect(describeError(v)).toBe(String(v).slice(0, 500));
      }),
      { numRuns: 30 },
    );
  });
});
