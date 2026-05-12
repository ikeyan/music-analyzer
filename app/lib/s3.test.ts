import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getS3, resetS3ForTest } from "./s3";
import { tempDir } from "./temp-dir";

const ENV_KEYS = [
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID_FILE",
  "S3_SECRET_ACCESS_KEY_FILE",
] as const;
type Env = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
let saved: Env = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetS3ForTest();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetS3ForTest();
});

describe("getS3 configuration", () => {
  it("throws when no env vars are set", () => {
    expect(() => getS3()).toThrow(/Missing S3 configuration/);
  });

  it("throws when only some env vars are set", () => {
    process.env.S3_ACCESS_KEY_ID = "x";
    expect(() => getS3()).toThrow(/Missing S3 configuration/);
    process.env.S3_SECRET_ACCESS_KEY = "y";
    expect(() => getS3()).toThrow(/Missing S3 configuration/);
  });

  it("constructs a client when all required vars are set", () => {
    process.env.S3_ACCESS_KEY_ID = "id";
    process.env.S3_SECRET_ACCESS_KEY = "secret";
    process.env.S3_BUCKET = "bucket";
    expect(() => getS3()).not.toThrow();
  });

  it("memoizes the singleton until resetS3ForTest is called", () => {
    process.env.S3_ACCESS_KEY_ID = "id";
    process.env.S3_SECRET_ACCESS_KEY = "secret";
    process.env.S3_BUCKET = "bucket";
    const a = getS3();
    const b = getS3();
    expect(a).toBe(b);
    resetS3ForTest();
    const c = getS3();
    expect(c).not.toBe(a);
  });

  it("accepts credentials from S3_ACCESS_KEY_ID_FILE / S3_SECRET_ACCESS_KEY_FILE", async () => {
    await using td = await tempDir("s3-secret-");
    const idPath = join(td.path, "id");
    const secretPath = join(td.path, "secret");
    writeFileSync(idPath, "id-from-file\n");
    writeFileSync(secretPath, "secret-from-file\n");
    process.env.S3_ACCESS_KEY_ID_FILE = idPath;
    process.env.S3_SECRET_ACCESS_KEY_FILE = secretPath;
    process.env.S3_BUCKET = "bucket";
    expect(() => getS3()).not.toThrow();
  });

  it("rejects both S3_ACCESS_KEY_ID and S3_ACCESS_KEY_ID_FILE being set", async () => {
    await using td = await tempDir("s3-secret-");
    const idPath = join(td.path, "id");
    writeFileSync(idPath, "id-from-file");
    process.env.S3_ACCESS_KEY_ID = "id";
    process.env.S3_ACCESS_KEY_ID_FILE = idPath;
    process.env.S3_SECRET_ACCESS_KEY = "secret";
    process.env.S3_BUCKET = "bucket";
    expect(() => getS3()).toThrow(/both set/);
  });
});
