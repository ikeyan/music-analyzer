import { beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { useS3Fixture } from "./test-fixtures/s3";

useS3Fixture();

let app: Hono;
beforeAll(async () => {
  const { blobs } = await import("./api/blobs");
  app = new Hono().route("/api/blobs", blobs);
});

describe("/api/blobs", () => {
  it("uploads a blob via PUT", async () => {
    const res = await app.request("/api/blobs/hello.txt", {
      method: "PUT",
      body: "Hello, S3!",
      headers: { "content-type": "text/plain" },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string; size: number };
    expect(body.key).toBe("hello.txt");
    expect(body.size).toBe("Hello, S3!".length);
  });

  it("downloads a blob via GET with the original content-type", async () => {
    await app.request("/api/blobs/download.json", {
      method: "PUT",
      body: JSON.stringify({ foo: "bar" }),
      headers: { "content-type": "application/json" },
    });

    const res = await app.request("/api/blobs/download.json");
    expect(res.status).toBe(200);
    // Requestがcharset=utf-8を付与するので前方一致のみ
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ foo: "bar" });
  });

  it("returns 404 for missing keys", async () => {
    const res = await app.request("/api/blobs/does-not-exist.bin");
    expect(res.status).toBe(404);
  });

  it("lists uploaded blobs", async () => {
    await app.request("/api/blobs/list-a.txt", {
      method: "PUT",
      body: "a",
      headers: { "content-type": "text/plain" },
    });
    await app.request("/api/blobs/list-b.txt", {
      method: "PUT",
      body: "bb",
      headers: { "content-type": "text/plain" },
    });

    const res = await app.request("/api/blobs");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      keys: { key: string; size: number; lastModified: string | null; etag: string | null }[];
    };
    const byKey = new Map(body.keys.map((k) => [k.key, k]));

    expect(byKey.get("list-a.txt")?.size).toBe(1);
    expect(byKey.get("list-b.txt")?.size).toBe(2);
  });

  it("filters listing by prefix", async () => {
    await app.request("/api/blobs/prefix-x/one.txt", {
      method: "PUT",
      body: "1",
      headers: { "content-type": "text/plain" },
    });
    await app.request("/api/blobs/prefix-y/two.txt", {
      method: "PUT",
      body: "2",
      headers: { "content-type": "text/plain" },
    });

    const res = await app.request("/api/blobs?prefix=prefix-x/");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { keys: { key: string }[] };
    const keys = body.keys.map((k) => k.key);
    expect(keys).toContain("prefix-x/one.txt");
    expect(keys).not.toContain("prefix-y/two.txt");
  });
});
