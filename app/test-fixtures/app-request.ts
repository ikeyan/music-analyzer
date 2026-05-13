import type { Hono } from "hono";

// Hono の `app.request(input, init)` は本番 fetch と違い body から Content-Length を
// 自動付与しない。CL を必須化したエンドポイント (chunked upload PUT 等) を
// テストするときは hc<AppType>(..., { fetch }) にこのラッパを渡す
export function withAutoContentLength<H extends Hono>(app: H): H["request"] {
  const wrapped: H["request"] = async (input, init) => {
    const headers = new Headers(init?.headers);
    const body = init?.body;
    if (body != null && !headers.has("content-length")) {
      const size = bodyByteLength(body);
      if (size !== undefined) headers.set("content-length", String(size));
    }
    return await app.request(input, { ...init, headers });
  };
  return wrapped;
}

// CL を計算できる body 型のみ拾う。FormData / ReadableStream など長さ不定のものは
// undefined を返して付与スキップ
function bodyByteLength(body: BodyInit): number | undefined {
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (body instanceof Blob) return body.size;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  return undefined;
}
