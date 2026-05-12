import type { hc } from "hono/client";
import type { AppType } from "../api";
import type { ApiTask } from "../api/types";

export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

export type ChunkedUploadClient = ReturnType<typeof hc<AppType>>;

export type ChunkedUploadResult = { ok: true; task: ApiTask } | { error: string; status: number };

export async function chunkedUpload(
  client: ChunkedUploadClient,
  projectId: string,
  kind: "video" | "audio",
  source: Blob,
  fileName: string,
  contentType?: string,
  chunkSize: number = UPLOAD_CHUNK_SIZE,
): Promise<ChunkedUploadResult> {
  const create = await client.projects[":id"].uploads.$post({
    param: { id: projectId },
    json: { kind, fileName, contentType, totalBytes: source.size, chunkSize },
  });
  if (!create.ok) return await readError(create);
  const { upload } = await create.json();

  const chunkContentType = contentType ?? "application/octet-stream";
  for (let i = 0; i < upload.totalChunks; i++) {
    const start = i * upload.chunkSize;
    const end = Math.min(source.size, start + upload.chunkSize);
    const res = await client.projects[":id"].uploads[":uploadId"].chunks[":index"].$put(
      { param: { id: projectId, uploadId: upload.id, index: String(i) } },
      // headers は per-call options に置く。init.headers に置くと hc の `...init`
      // spread で hc-level headers (auth など) ごと上書きされる
      {
        init: { body: source.slice(start, end) },
        headers: { "content-type": chunkContentType },
      },
    );
    if (!res.ok) return await readError(res);
  }

  const complete = await client.projects[":id"].uploads[":uploadId"].complete.$post({
    param: { id: projectId, uploadId: upload.id },
  });
  if (!complete.ok) return await readError(complete);
  const { task } = await complete.json();
  return { ok: true, task };
}

async function readError(res: Response): Promise<{ error: string; status: number }> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { error: body.error ?? "(no error message in response body)", status: res.status };
}
