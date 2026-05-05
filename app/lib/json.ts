import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// JSON.stringify は bigint を投げる。グローバルprototypeを汚さずに replacer で number へ落とす
// (sizeBytes 等は Number.MAX_SAFE_INTEGER を越えない前提)
export const bigintReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? Number(value) : value;

// c.json は内部で JSON.stringify を replacer なしで呼ぶので、
// bigint を含むレスポンスはこの helper を使う
export function jsonResponse(
  c: Context,
  data: unknown,
  status: ContentfulStatusCode = 200,
): Response {
  return c.body(JSON.stringify(data, bigintReplacer), status, {
    "content-type": "application/json; charset=utf-8",
  });
}
