import type { Context } from "hono";
import { getS3 } from "./s3";

export const projectKey = (projectId: string) => `projects/${projectId}`;
export const videoSourceKey = (projectId: string, videoId: string) =>
  `${projectKey(projectId)}/videos/${videoId}/source.mp4`;
export const videoAudioKey = (projectId: string, videoId: string) =>
  `${projectKey(projectId)}/videos/${videoId}/audio.m4a`;
export const videoThumbKey = (projectId: string, videoId: string, atSec: number) =>
  `${projectKey(projectId)}/videos/${videoId}/thumbs/${String(Math.round(atSec)).padStart(6, "0")}.jpg`;
export const audioRawKey = (projectId: string, audioId: string, ext: string) =>
  `${projectKey(projectId)}/audios/${audioId}/raw.${ext.replace(/^\./, "")}`;
export const audioTranscodedKey = (projectId: string, audioId: string) =>
  `${projectKey(projectId)}/audios/${audioId}/transcoded.m4a`;

export async function uploadFile(key: string, path: string, contentType: string): Promise<void> {
  await getS3().write(key, Bun.file(path), { type: contentType });
}

export async function deletePrefix(prefix: string): Promise<void> {
  const s3 = getS3();
  let continuationToken: string | undefined;
  do {
    const result = await s3.list({ prefix, continuationToken });
    for (const obj of result.contents ?? []) {
      if (obj.key) await s3.delete(obj.key);
    }
    continuationToken = result.isTruncated ? result.nextContinuationToken : undefined;
  } while (continuationToken);
}

export async function streamS3(
  c: Context,
  key: string,
  fallbackContentType?: string,
): Promise<Response> {
  const s3 = getS3();
  if (!(await s3.exists(key))) return c.notFound();
  const file = s3.file(key);
  const stat = await file.stat();
  const total = stat.size;
  const type = stat.type || fallbackContentType || "application/octet-stream";

  const range = c.req.header("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m)
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
    const startStr = m[1];
    const endStr = m[2];
    const start = startStr === "" ? Math.max(0, total - Number(endStr)) : Number(startStr);
    // RFC 7233 §2.1: last-byte-pos が現在長以上なら EOF まで読む扱い。
    // 一部の media client が probing で大きめの end を投げてくるのでクランプする
    const rawEnd = startStr === "" || endStr === "" ? total - 1 : Number(endStr);
    const end = Math.min(rawEnd, total - 1);
    if (Number.isNaN(start) || Number.isNaN(rawEnd) || start > end || start >= total) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
    }
    const slice = file.slice(start, end + 1);
    return new Response(slice.stream(), {
      status: 206,
      headers: {
        "content-type": type,
        "content-range": `bytes ${start}-${end}/${total}`,
        "accept-ranges": "bytes",
        "content-length": String(end - start + 1),
        etag: stat.etag,
      },
    });
  }

  return new Response(file.stream(), {
    headers: {
      "content-type": type,
      "content-length": String(total),
      "accept-ranges": "bytes",
      etag: stat.etag,
    },
  });
}
