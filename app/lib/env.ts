import { readFileSync } from "node:fs";

// `<NAME>` と `<NAME>_FILE` の二系統。両方セットは誤設定なので fail-fast。
// `<NAME>_FILE` は Docker / k8s の mounted secret 用。末尾の改行1つは値ではないので剥がす
export function readSecretEnv(name: string): string | undefined {
  const direct = process.env[name];
  const filePath = process.env[`${name}_FILE`];
  if (direct && filePath) {
    throw new Error(`${name} and ${name}_FILE are both set; specify only one`);
  }
  if (filePath) {
    return readFileSync(filePath, "utf8").replace(/\r?\n$/, "");
  }
  return direct;
}
