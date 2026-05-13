import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { useEnvSandbox } from "../test-fixtures/env-sandbox";
import { getS3, resetS3ForTest } from "./s3";
import { tempDir } from "./temp-dir";

useEnvSandbox(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"]);

beforeEach(resetS3ForTest);
afterEach(resetS3ForTest);

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
