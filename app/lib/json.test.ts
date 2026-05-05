import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { bigintReplacer, jsonResponse } from "./json";

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

describe("jsonResponse", () => {
  it("serializes bigint and sets json content-type with status", async () => {
    const app = new Hono().get("/", (c) => jsonResponse(c, { size: 9_000_000_000n }, 201));
    const res = await app.request("/");
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ size: 9_000_000_000 });
  });

  it("defaults to status 200", async () => {
    const app = new Hono().get("/", (c) => jsonResponse(c, { ok: true }));
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
