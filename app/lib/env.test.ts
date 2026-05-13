import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { useEnvSandbox } from "../test-fixtures/env-sandbox";
import { readSecretEnv } from "./env";
import { tempDir } from "./temp-dir";

const NAME = "MUSIC_ANALYZER_TEST_SECRET";
const FILE_NAME = `${NAME}_FILE`;

useEnvSandbox([NAME]);

describe("readSecretEnv", () => {
  it("returns undefined when neither is set", () => {
    expect(readSecretEnv(NAME)).toBeUndefined();
  });

  it("returns the direct value when only the env var is set", () => {
    process.env[NAME] = "direct-value";
    expect(readSecretEnv(NAME)).toBe("direct-value");
  });

  it("reads the file when only _FILE is set", async () => {
    await using td = await tempDir("env-secret-");
    const p = join(td.path, "secret");
    writeFileSync(p, "file-value");
    process.env[FILE_NAME] = p;
    expect(readSecretEnv(NAME)).toBe("file-value");
  });

  it("strips a single trailing LF added by editors / echo", async () => {
    await using td = await tempDir("env-secret-");
    const p = join(td.path, "secret");
    writeFileSync(p, "value\n");
    process.env[FILE_NAME] = p;
    expect(readSecretEnv(NAME)).toBe("value");
  });

  it("strips a single trailing CRLF", async () => {
    await using td = await tempDir("env-secret-");
    const p = join(td.path, "secret");
    writeFileSync(p, "value\r\n");
    process.env[FILE_NAME] = p;
    expect(readSecretEnv(NAME)).toBe("value");
  });

  it("only strips one trailing newline, preserving prior content as-is", async () => {
    await using td = await tempDir("env-secret-");
    const p = join(td.path, "secret");
    writeFileSync(p, "line1\nline2\n");
    process.env[FILE_NAME] = p;
    expect(readSecretEnv(NAME)).toBe("line1\nline2");
  });

  it("throws when both env vars are set", async () => {
    await using td = await tempDir("env-secret-");
    const p = join(td.path, "secret");
    writeFileSync(p, "file-value");
    process.env[NAME] = "direct-value";
    process.env[FILE_NAME] = p;
    expect(() => readSecretEnv(NAME)).toThrow(/both set/);
  });

  it("treats empty direct value as unset and reads the file", async () => {
    await using td = await tempDir("env-secret-");
    const p = join(td.path, "secret");
    writeFileSync(p, "file-value");
    process.env[NAME] = "";
    process.env[FILE_NAME] = p;
    expect(readSecretEnv(NAME)).toBe("file-value");
  });

  it("treats empty _FILE path as unset and returns the direct value", () => {
    process.env[NAME] = "direct-value";
    process.env[FILE_NAME] = "";
    expect(readSecretEnv(NAME)).toBe("direct-value");
  });

  it("propagates the underlying error when _FILE points to a missing file", () => {
    process.env[FILE_NAME] = "/nonexistent/path/should-not-exist-music-analyzer";
    expect(() => readSecretEnv(NAME)).toThrow();
  });
});
