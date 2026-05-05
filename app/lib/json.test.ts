import { describe, expect, it } from "bun:test";
import { bigintReplacer } from "./json";

describe("bigintReplacer", () => {
  it("converts bigint to number", () => {
    const out = JSON.stringify({ size: 123n }, bigintReplacer);
    expect(out).toBe('{"size":123}');
  });

  it("preserves non-bigint values", () => {
    const out = JSON.stringify({ a: 1, b: "x", c: null, d: true }, bigintReplacer);
    expect(out).toBe('{"a":1,"b":"x","c":null,"d":true}');
  });

  it("handles nested bigint", () => {
    const out = JSON.stringify({ list: [{ size: 7n }, { size: 8n }] }, bigintReplacer);
    expect(JSON.parse(out)).toEqual({ list: [{ size: 7 }, { size: 8 }] });
  });

  it("does not mutate global BigInt prototype", () => {
    const proto = BigInt.prototype as unknown as { toJSON?: unknown };
    expect(proto.toJSON).toBeUndefined();
    expect(() => JSON.stringify(123n)).toThrow();
  });
});
