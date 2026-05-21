import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { withAutoContentLength } from "./app-request";

type EchoBody = { contentLength: string | null; contentType: string | null; method: string };

function echoApp(): Hono {
  return new Hono().all("*", (c) =>
    c.json<EchoBody>({
      contentLength: c.req.header("content-length") ?? null,
      contentType: c.req.header("content-type") ?? null,
      method: c.req.method,
    }),
  );
}

async function call(
  app: Hono,
  init?: RequestInit,
  headers?: Record<string, string>,
): Promise<EchoBody> {
  const fetch = withAutoContentLength(app);
  const res = await fetch("http://test/", { ...init, headers });
  return (await res.json()) as EchoBody;
}

describe("withAutoContentLength", () => {
  it("auto-injects content-length from a string body (byte length, not char count)", async () => {
    expect((await call(echoApp(), { method: "POST", body: "hello" })).contentLength).toBe("5");
    // UTF-8 で 3 char × 3 byte = 9 byte
    expect((await call(echoApp(), { method: "POST", body: "あいう" })).contentLength).toBe("9");
  });

  it("auto-injects content-length from a Uint8Array body", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    expect((await call(echoApp(), { method: "POST", body })).contentLength).toBe("4");
  });

  it("auto-injects content-length from an ArrayBuffer body", async () => {
    const body = new Uint8Array([1, 2, 3]).buffer;
    expect((await call(echoApp(), { method: "POST", body })).contentLength).toBe("3");
  });

  it("auto-injects content-length from a Blob body", async () => {
    const body = new Blob(["abcde"]);
    expect((await call(echoApp(), { method: "POST", body })).contentLength).toBe("5");
  });

  it("does not overwrite an existing content-length header", async () => {
    const result = await call(
      echoApp(),
      { method: "POST", body: "hello" },
      { "content-length": "999" },
    );
    expect(result.contentLength).toBe("999");
  });

  it("preserves other headers (e.g. content-type) and still injects CL", async () => {
    const result = await call(
      echoApp(),
      { method: "POST", body: "x" },
      { "content-type": "application/octet-stream" },
    );
    expect(result.contentType).toBe("application/octet-stream");
    expect(result.contentLength).toBe("1");
  });

  it("does not add content-length when body is absent", async () => {
    expect((await call(echoApp(), { method: "GET" })).contentLength).toBeNull();
  });

  it("skips length-unknown body types (FormData) instead of guessing", async () => {
    const fd = new FormData();
    fd.append("a", "1");
    // FormData の boundary 付き serialization 長は事前計算できないので CL は付けない
    const result = await call(echoApp(), { method: "POST", body: fd });
    expect(result.contentLength).toBeNull();
  });
});
