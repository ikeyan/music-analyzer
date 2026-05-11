import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { tempDir } from "./temp-dir";

describe("tempDir", () => {
  it("creates a directory and disposes it at scope end", async () => {
    let captured: string;
    {
      await using td = await tempDir("test-tmp-");
      captured = td.path;
      expect(existsSync(td.path)).toBe(true);
    }
    expect(existsSync(captured)).toBe(false);
  });

  it("disposes even when the scope throws", async () => {
    let captured: string | undefined;
    await expect(
      (async () => {
        await using td = await tempDir("test-tmp-throw-");
        captured = td.path;
        throw new Error("boom");
      })(),
    ).rejects.toThrow("boom");
    expect(existsSync(captured!)).toBe(false);
  });
});
