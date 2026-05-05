import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { clearS3Bucket, ensureS3Fixture } from "../test-fixtures/s3";
import { getS3 } from "./s3";
import { deletePrefix, streamS3 } from "./storage";

const STARTUP_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  await ensureS3Fixture();
}, STARTUP_TIMEOUT_MS);

beforeEach(async () => {
  await clearS3Bucket();
});

async function put(key: string, body: string, type = "application/octet-stream"): Promise<void> {
  await getS3().write(key, body, { type });
}

describe("streamS3", () => {
  const app = new Hono().get("/:key{.+}", (c) => streamS3(c, c.req.param("key")));

  it("returns full body when no Range", async () => {
    await put("media/full.bin", "0123456789", "text/plain");
    const res = await app.request("/media/full.bin");
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("10");
    expect(await res.text()).toBe("0123456789");
  });

  it("returns 206 with content-range for explicit range", async () => {
    await put("media/range.bin", "0123456789", "text/plain");
    const res = await app.request("/media/range.bin", { headers: { Range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("2345");
  });

  it("clamps oversized end to EOF (RFC 7233 §2.1)", async () => {
    await put("media/clamp.bin", "0123456789", "text/plain");
    const res = await app.request("/media/clamp.bin", { headers: { Range: "bytes=0-9999" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-9/10");
    expect(await res.text()).toBe("0123456789");
  });

  it("returns 416 for unsatisfiable start", async () => {
    await put("media/oob.bin", "0123456789", "text/plain");
    const res = await app.request("/media/oob.bin", { headers: { Range: "bytes=20-30" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });

  it("returns 404 for missing key", async () => {
    const res = await app.request("/media/missing.bin");
    expect(res.status).toBe(404);
  });
});

describe("deletePrefix", () => {
  it("removes every object under the prefix", async () => {
    await put("p/a/1.bin", "x");
    await put("p/a/2.bin", "x");
    await put("p/a/sub/3.bin", "x");
    await put("p/b/keep.bin", "x");

    await deletePrefix("p/a/");

    const after = await getS3().list({ prefix: "p/" });
    const keys = (after.contents ?? []).map((o) => o.key);
    expect(keys).not.toContain("p/a/1.bin");
    expect(keys).not.toContain("p/a/2.bin");
    expect(keys).not.toContain("p/a/sub/3.bin");
    expect(keys).toContain("p/b/keep.bin");
  });

  it("is a no-op for an empty prefix", async () => {
    await put("other/x.bin", "x");
    await deletePrefix("nope/");
    const all = await getS3().list({});
    const keys = (all.contents ?? []).map((o) => o.key);
    expect(keys).toContain("other/x.bin");
  });

  // Bun S3 の continuationToken ページネーションが想定通り動くことを実測。
  // maxKeys を小さくして同じプレフィックスで意図的に複数ページを発生させる
  it("paginates via continuationToken until all pages consumed", async () => {
    const N = 7;
    for (let i = 0; i < N; i++) await put(`page/${i}.bin`, "x");

    const collected: string[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      pages++;
      const result = await getS3().list({ prefix: "page/", maxKeys: 3, continuationToken: token });
      for (const o of result.contents ?? []) if (o.key) collected.push(o.key);
      token = result.isTruncated ? result.nextContinuationToken : undefined;
    } while (token);

    expect(pages).toBeGreaterThanOrEqual(3);
    expect(collected).toHaveLength(N);
    expect(new Set(collected).size).toBe(N);

    await deletePrefix("page/");
    const after = await getS3().list({ prefix: "page/" });
    expect(after.contents ?? []).toHaveLength(0);
  });
});
