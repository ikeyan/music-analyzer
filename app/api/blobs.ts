import { Hono } from "hono";
import { getS3 } from "../lib/s3";

export const blobs = new Hono()
  .get("/", async (c) => {
    const prefix = c.req.query("prefix") ?? undefined;
    const result = await getS3().list(prefix ? { prefix } : null);
    const keys = (result.contents ?? []).map((o) => ({
      key: o.key,
      size: o.size ?? 0,
      lastModified: o.lastModified ?? null,
      etag: o.eTag ?? null,
    }));
    return c.json({ keys });
  })
  .put("/:key{.+}", async (c) => {
    const key = c.req.param("key");
    const body = await c.req.arrayBuffer();
    const contentType = c.req.header("content-type") ?? "application/octet-stream";
    await getS3().write(key, body, { type: contentType });
    return c.json({ key, size: body.byteLength }, 201);
  })
  .get("/:key{.+}", async (c) => {
    const key = c.req.param("key");
    const s3 = getS3();

    if (!(await s3.exists(key))) {
      return c.notFound();
    }

    const file = s3.file(key);
    const stat = await file.stat();
    const buffer = await file.arrayBuffer();

    return new Response(buffer, {
      headers: {
        "content-type": stat.type || "application/octet-stream",
        "content-length": String(stat.size),
        etag: stat.etag,
      },
    });
  });
