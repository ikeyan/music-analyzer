#!/usr/bin/env bun
// Bun.WebView 用の chrome-for-testing を <out>/ に展開し、--no-sandbox を強制する
// wrapper を <wrapper> に書く。session-start hook と CI が共有する。
// dl.google deb は 403、chrome snap は sandbox 不可なので zip 直接展開
import { $ } from "bun";
import { parseArgs } from "node:util";
import { tempDir } from "../app/lib/temp-dir";

export const CHROME_VERSION = "141.0.7390.107";

export async function installChrome(outDir: string, wrapperPath: string): Promise<void> {
  const arch = "linux64";
  const dirName = `chrome-${arch}`;
  const url = `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${arch}/${dirName}.zip`;
  await using td = await tempDir(`chrome-${CHROME_VERSION}`);
  await $`curl -fsSL ${url} -o ${td.path}/chrome.zip`.quiet();
  await $`unzip -q -o ${td.path}/chrome.zip -d ${td.path}`.quiet();
  await $`cp -r ${td.path}/${dirName}/. ${outDir}/`;
  await Bun.write(wrapperPath, `#!/bin/sh\nexec ${outDir}/chrome --no-sandbox "$@"\n`);
  await $`chmod +x ${wrapperPath}`;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { out: { type: "string" }, wrapper: { type: "string" } },
    strict: true,
  });
  if (!values.out || !values.wrapper) {
    throw new Error("--out <dir> and --wrapper <path> required");
  }
  await installChrome(values.out, values.wrapper);
}
