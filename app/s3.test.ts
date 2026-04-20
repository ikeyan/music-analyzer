import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

const MINIO_IMAGE = "minio/minio:latest";
const MINIO_USER = "minioadmin";
const MINIO_PASSWORD = "minioadmin";
const TEST_BUCKET = "test-bucket";
const CONTAINER_STARTUP_MS = 120_000;

let container: StartedTestContainer;
let app: Hono;

beforeAll(async () => {
  // The official minio image does not support an "auto-create buckets" env
  // var, so we pre-create the bucket directory before starting the server.
  // Bun's S3Client does not expose a CreateBucket call, so this is the
  // simplest way to get a usable bucket without pulling in aws-sdk purely
  // for tests.
  container = await new GenericContainer(MINIO_IMAGE)
    .withExposedPorts(9000)
    .withEnvironment({
      MINIO_ROOT_USER: MINIO_USER,
      MINIO_ROOT_PASSWORD: MINIO_PASSWORD,
    })
    .withEntrypoint(["/bin/sh", "-c"])
    .withCommand([`mkdir -p /data/${TEST_BUCKET} && exec minio server /data --address :9000`])
    .withWaitStrategy(Wait.forLogMessage(/API:/))
    .withStartupTimeout(CONTAINER_STARTUP_MS)
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  process.env.S3_ENDPOINT = endpoint;
  process.env.S3_REGION = "us-east-1";
  process.env.S3_ACCESS_KEY_ID = MINIO_USER;
  process.env.S3_SECRET_ACCESS_KEY = MINIO_PASSWORD;
  process.env.S3_BUCKET = TEST_BUCKET;

  const { resetS3ForTest } = await import("./lib/s3");
  resetS3ForTest();

  const { blobs } = await import("./api/blobs");
  app = new Hono().route("/api/blobs", blobs);
}, CONTAINER_STARTUP_MS);

afterAll(async () => {
  await container?.stop();
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
    // JS Request constructors append ";charset=utf-8" to text content types,
    // so we only assert the media type.
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
