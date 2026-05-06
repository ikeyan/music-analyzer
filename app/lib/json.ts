import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// bigint を含む値を c.json で返すには JSON.stringify が拒否するので number に落とす
// (sizeBytes は Number.MAX_SAFE_INTEGER を越えない前提)
export const bigintReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? Number(value) : value;

export function jsonResponse(
  c: Context,
  data: unknown,
  status: ContentfulStatusCode = 200,
): Response {
  return c.body(JSON.stringify(data, bigintReplacer), status, {
    "content-type": "application/json; charset=utf-8",
  });
}
