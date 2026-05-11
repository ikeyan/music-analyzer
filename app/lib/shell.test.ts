import { $ } from "bun";
import { describe, expect, it } from "bun:test";
import { runShell } from "./shell";

describe("runShell", () => {
  it("resolves on exit 0", async () => {
    await expect(runShell("ok", $`true`)).resolves.toBeUndefined();
  });

  it("includes label, exit code and stderr on failure", async () => {
    await expect(runShell("boom", $`bash -c 'echo nope >&2; exit 7'`)).rejects.toThrow(
      /boom failed \(exit 7\)[\s\S]*nope/,
    );
  });
});
