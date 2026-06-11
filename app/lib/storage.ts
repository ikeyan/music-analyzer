import type { Context } from "hono";
import { parseRange } from "./range";
import { getS3 } from "./s3";

export const projectKey = (projectId: string) => `projects/${projectId}`;
// trailing slash 付きの prefix。deletePrefix / list の prefix 引数や DeletionMark.prefix で使う
export const projectPrefix = (projectId: string) => `${projectKey(projectId)}/`;
export const videoPrefix = (projectId: string, videoId: string) =>
  `${projectKey(projectId)}/videos/${videoId}/`;
export const audioPrefix = (projectId: string, audioId: string) =>
  `${projectKey(projectId)}/audios/${audioId}/`;
export const uploadPrefix = (projectId: string, uploadId: string) =>
  `${projectKey(projectId)}/uploads/${uploadId}/`;

export const videoSourceKey = (projectId: string, videoId: string) =>
  `${videoPrefix(projectId, videoId)}source.mp4`;
export const videoAudioKey = (projectId: string, videoId: string) =>
  `${videoPrefix(projectId, videoId)}audio.m4a`;
export const videoThumbKey = (projectId: string, videoId: string, atSec: number) =>
  `${videoPrefix(projectId, videoId)}thumbs/${String(Math.round(atSec)).padStart(6, "0")}.jpg`;
export const audioRawKey = (projectId: string, audioId: string, ext: string) =>
  `${audioPrefix(projectId, audioId)}raw.${ext.replace(/^\./, "")}`;
export const audioTranscodedKey = (projectId: string, audioId: string) =>
  `${audioPrefix(projectId, audioId)}transcoded.m4a`;
export const spectrogramPrefix = (projectId: string, audioId: string, specId: string) =>
  `${audioPrefix(projectId, audioId)}spectrograms/${specId}/`;
export const spectrogramMetaKey = (projectId: string, audioId: string, specId: string) =>
  `${spectrogramPrefix(projectId, audioId, specId)}meta.json`;
export const spectrogramTileKey = (
  projectId: string,
  audioId: string,
  specId: string,
  harmonic: number,
  level: number,
  index: number,
) =>
  `${spectrogramPrefix(projectId, audioId, specId)}tiles/h${harmonic}/${level}/${String(index).padStart(6, "0")}.bin`;

// retry は別 key を書いて DB tx で promote するため writeId で unique 化
export const uploadChunkKey = (
  projectId: string,
  uploadId: string,
  index: number,
  writeId: string,
) => `${uploadPrefix(projectId, uploadId)}chunks/${String(index).padStart(7, "0")}-${writeId}`;

export async function uploadFile(key: string, path: string, contentType: string): Promise<void> {
  await getS3().write(key, Bun.file(path), { type: contentType });
}

export async function uploadBytes(
  key: string,
  data: Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<void> {
  await getS3().write(key, data, { type: contentType });
}

// Bun.serve 経由の Request では S3Client.write の戻り値 size が常に 0 を返すバグの
// workaround で Content-Length から size を取る (CL なしのみ HEAD フォールバック)
export async function uploadRawRequest(
  key: string,
  request: Request,
  contentType: string,
): Promise<number> {
  const s3 = getS3();
  await s3.write(key, request, { type: contentType });
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const stat = await s3.file(key).stat();
  return stat.size;
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

  const parsed = parseRange(c.req.header("range"), total);
  if (parsed === "invalid") {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
  }
  if (parsed) {
    const { start, end } = parsed;
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
