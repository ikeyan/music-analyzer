import { describe, expect, it } from "bun:test";
import { Either } from "effect";
import { Hono } from "hono";
import { leftErr, provideEitherJson } from "./either-json";

describe("leftErr", () => {
  it("wraps {status, error} in Either.Left preserving literal status", () => {
    const r = leftErr({ status: 409, error: "conflict" });
    expect(Either.isLeft(r)).toBe(true);
    if (Either.isLeft(r)) {
      // 型レベルでも status: 409 リテラル
      const status: 409 = r.left.status;
      expect(status).toBe(409);
      expect(r.left.error).toBe("conflict");
    }
  });

  it("passes through extra properties on the error payload", () => {
    const r = leftErr({ status: 409, error: "already taken", existingId: "abc" });
    if (Either.isLeft(r)) {
      expect(r.left.existingId).toBe("abc");
    } else {
      throw new Error("expected Left");
    }
  });
});

describe("provideEitherJson", () => {
  function app() {
    return new Hono()
      .use("*", provideEitherJson)
      .get("/left", (c) => c.var.eitherJson(leftErr({ status: 404, error: "not found" })))
      .get("/right", (c) => c.var.eitherJson(Either.right({ ok: true })))
      .get("/left-with-extra", (c) =>
        c.var.eitherJson(leftErr({ status: 409, error: "already aborted", uploadId: "u_1" })),
      );
  }

  it("dispatches Left to c.json with status from e.status and the rest as body", async () => {
    const res = await app().request("/left");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("dispatches Right to c.json at 200", async () => {
    const res = await app().request("/right");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("preserves extra properties of the error payload in the response body", async () => {
    const res = await app().request("/left-with-extra");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already aborted", uploadId: "u_1" });
  });
});
