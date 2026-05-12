import { vValidator } from "@hono/valibot-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as v from "valibot";
import { type AuthContext, requireUser } from "../lib/auth";
import { MAX_UPLOAD_BYTES } from "../lib/ffmpeg";
import { prisma } from "../lib/prisma";
import { getS3 } from "../lib/s3";
import {
  projectKey,
  streamS3,
  uploadPrefix,
  uploadRawRequest,
  uploadChunkKey,
  deletePrefix,
} from "../lib/storage";
import { enqueueTask } from "../lib/task-runner";
import {
  type ApiProject,
  type ApiProjectDetail,
  type ApiProjectSummary,
  type ApiTask,
  type ApiUpload,
  toApiProject,
  toApiProjectDetail,
  toApiProjectSummary,
  toApiTask,
  toApiUpload,
} from "./types";

// upload 完了前に死んだチャンクは 1h grace の DeletionMark + sweeper で回収する
export const UPLOAD_EXPIRY_MS = 60 * 60 * 1000;
// /complete 後に task が走り終わるまで sweeper に回収されないよう mark を伸ばす。
// MAX_DURATION_SEC (1h) の transcode + upload に余裕を持たせた grace
export const TASK_GRACE_MS = 4 * 60 * 60 * 1000;

// chunk size の許容範囲。client が指定する。multipart の S3 minimum (5MiB) と
// 単一 request にメモリ展開しても安全な上限を考慮した範囲
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
// 極小チャンクの DoS だけ防ぐ。実用的な下限は client が DEFAULT を使うことを期待する
const MIN_CHUNK_SIZE = 1024;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
// 全 chunk 受信前の Content-Length 単発 fast-fail 用
const MAX_SINGLE_CHUNK_BYTES = MAX_CHUNK_SIZE;

const idParamSchema = v.object({ id: v.string() });
const videoIdParamSchema = v.object({ id: v.string(), videoId: v.string() });
const audioIdParamSchema = v.object({ id: v.string(), audioId: v.string() });
const thumbIdParamSchema = v.object({ id: v.string(), videoId: v.string(), thumbId: v.string() });
const uploadIdParamSchema = v.object({ id: v.string(), uploadId: v.string() });
const uploadChunkParamSchema = v.object({
  id: v.string(),
  uploadId: v.string(),
  index: v.string(),
});
const taskIdParamSchema = v.object({ id: v.string(), taskId: v.string() });

const createProjectSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1)),
});
const reorderTracksSchema = v.object({
  tracks: v.array(
    v.object({
      kind: v.picklist(["video", "audio"]),
      id: v.string(),
    }),
  ),
});
const createUploadSchema = v.object({
  kind: v.picklist(["video", "audio"]),
  fileName: v.pipe(v.string(), v.trim(), v.minLength(1)),
  contentType: v.optional(v.string()),
  totalBytes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_UPLOAD_BYTES)),
  chunkSize: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(MIN_CHUNK_SIZE), v.maxValue(MAX_CHUNK_SIZE)),
  ),
});

async function findProjectOr404(userId: string, projectId: string) {
  const p = await prisma.project.findFirst({ where: { id: projectId, userId } });
  return p;
}

async function markPrefixForDeletion(prefix: string, graceMs: number): Promise<void> {
  await prisma.deletionMark.create({
    data: { prefix, nextRetryAt: new Date(Date.now() + graceMs) },
  });
}

async function eagerCleanupAndUnmark(prefix: string): Promise<void> {
  try {
    await deletePrefix(prefix);
    await prisma.deletionMark.deleteMany({ where: { prefix } });
  } catch {
    /* sweeperに任せる */
  }
}

export const projects = new Hono<AuthContext>()
  .use("*", requireUser)
  .get("/", async (c) => {
    const user = c.var.user;
    const list = await prisma.project.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { videos: true, audios: true } } },
    });
    return c.json({ projects: list.map(toApiProjectSummary) satisfies ApiProjectSummary[] });
  })
  .post("/", vValidator("json", createProjectSchema), async (c) => {
    const user = c.var.user;
    const { name } = c.req.valid("json");
    const project = await prisma.project.create({ data: { userId: user.id, name } });
    return c.json({ project: toApiProject(project) satisfies ApiProject }, 201);
  })
  .get("/:id", vValidator("param", idParamSchema), async (c) => {
    const user = c.var.user;
    const project = await prisma.project.findFirst({
      where: { id: c.req.valid("param").id, userId: user.id },
      include: {
        videos: {
          orderBy: { order: "asc" },
          include: { thumbnails: { orderBy: { atSec: "asc" } } },
        },
        audios: { orderBy: { order: "asc" } },
      },
    });
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json({ project: toApiProjectDetail(project) satisfies ApiProjectDetail });
  })
  .delete("/:id", vValidator("param", idParamSchema), async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.valid("param").id);
    if (!project) return c.json({ error: "project not found" }, 404);
    const prefix = `${projectKey(project.id)}/`;
    await prisma.$transaction(async (tx) => {
      await tx.deletionMark.create({ data: { prefix } });
      await tx.task.deleteMany({ where: { projectId: project.id } });
      await tx.uploadChunk.deleteMany({ where: { upload: { projectId: project.id } } });
      await tx.upload.deleteMany({ where: { projectId: project.id } });
      await tx.thumbnail.deleteMany({ where: { video: { projectId: project.id } } });
      await tx.video.deleteMany({ where: { projectId: project.id } });
      await tx.audio.deleteMany({ where: { projectId: project.id } });
      await tx.project.delete({ where: { id: project.id } });
    });
    await eagerCleanupAndUnmark(prefix);
    return c.body(null, 204);
  })

  .patch(
    "/:id/track-order",
    vValidator("param", idParamSchema),
    vValidator("json", reorderTracksSchema),
    async (c) => {
      const user = c.var.user;
      const project = await findProjectOr404(user.id, c.req.valid("param").id);
      if (!project) return c.json({ error: "project not found" }, 404);
      const { tracks: newOrder } = c.req.valid("json");

      await withSlotRetry(() =>
        prisma.$transaction(async (tx) => {
          await tx.project.update({ where: { id: project.id }, data: { updatedAt: new Date() } });
          const [videos, audios] = await Promise.all([
            tx.video.findMany({
              where: { projectId: project.id },
              select: { id: true, projStartSec: true, projEndSec: true },
            }),
            tx.audio.findMany({
              where: { projectId: project.id },
              select: { id: true, projStartSec: true, projEndSec: true },
            }),
          ]);
          const expected = videos.length + audios.length;
          if (newOrder.length !== expected) {
            throw new HTTPException(400, { message: "track-order: length mismatch" });
          }
          const videoMap = new Map(videos.map((row) => [row.id, row]));
          const audioMap = new Map(audios.map((row) => [row.id, row]));
          const seen = new Set<string>();
          for (const t of newOrder) {
            const exists = t.kind === "video" ? videoMap.has(t.id) : audioMap.has(t.id);
            if (!exists) {
              throw new HTTPException(400, {
                message: `track-order: unknown ${t.kind} id ${t.id}`,
              });
            }
            const key = `${t.kind}:${t.id}`;
            if (seen.has(key)) {
              throw new HTTPException(400, {
                message: `track-order: duplicate ${t.kind} id ${t.id}`,
              });
            }
            seen.add(key);
          }
          for (const [i, t] of newOrder.entries()) {
            const data = { order: -(i + 1) };
            if (t.kind === "video") await tx.video.update({ where: { id: t.id }, data });
            else await tx.audio.update({ where: { id: t.id }, data });
          }
          let cursor = 0;
          for (const [i, t] of newOrder.entries()) {
            const row = (t.kind === "video" ? videoMap : audioMap).get(t.id);
            if (!row) throw new Error("unreachable");
            const duration = row.projEndSec - row.projStartSec;
            const data = { order: i, projStartSec: cursor, projEndSec: cursor + duration };
            if (t.kind === "video") await tx.video.update({ where: { id: t.id }, data });
            else await tx.audio.update({ where: { id: t.id }, data });
            cursor += duration;
          }
        }),
      );

      const updated = await prisma.project.findFirst({
        where: { id: project.id, userId: user.id },
        include: {
          videos: {
            orderBy: { order: "asc" },
            include: { thumbnails: { orderBy: { atSec: "asc" } } },
          },
          audios: { orderBy: { order: "asc" } },
        },
      });
      if (!updated) return c.json({ error: "project not found" }, 404);
      return c.json({ project: toApiProjectDetail(updated) satisfies ApiProjectDetail });
    },
  )

  // 分割アップロード開始: Upload 行 + 1h grace の DeletionMark を作る。
  // 以降の PUT /chunks/:index と POST /complete はこの uploadId を握って進める
  .post(
    "/:id/uploads",
    vValidator("param", idParamSchema),
    vValidator("json", createUploadSchema),
    async (c) => {
      const user = c.var.user;
      const project = await findProjectOr404(user.id, c.req.valid("param").id);
      if (!project) return c.json({ error: "project not found" }, 404);
      const {
        kind,
        fileName,
        contentType,
        totalBytes,
        chunkSize: requestedChunk,
      } = c.req.valid("json");
      const chunkSize = requestedChunk ?? DEFAULT_CHUNK_SIZE;
      const totalChunks = Math.max(1, Math.ceil(totalBytes / chunkSize));
      const expiresAt = new Date(Date.now() + UPLOAD_EXPIRY_MS);

      const upload = await prisma.upload.create({
        data: {
          projectId: project.id,
          kind,
          fileName,
          contentType: contentType ?? null,
          totalBytes: BigInt(totalBytes),
          chunkSize,
          totalChunks,
          expiresAt,
        },
      });
      await markPrefixForDeletion(uploadPrefix(project.id, upload.id), UPLOAD_EXPIRY_MS);
      return c.json({ upload: toApiUpload(upload) satisfies ApiUpload }, 201);
    },
  )

  // 単一 chunk を S3 に書き込み、UploadChunk 行を upsert する。再送 idempotent
  .put(
    "/:id/uploads/:uploadId/chunks/:index",
    vValidator("param", uploadChunkParamSchema),
    async (c) => {
      const user = c.var.user;
      const { id, uploadId, index: indexStr } = c.req.valid("param");
      const project = await findProjectOr404(user.id, id);
      if (!project) return c.json({ error: "project not found" }, 404);
      const upload = await prisma.upload.findFirst({
        where: { id: uploadId, projectId: project.id },
      });
      if (!upload) return c.json({ error: "upload not found" }, 404);
      if (upload.status !== "pending") {
        return c.json({ error: `upload is ${upload.status}` }, 409);
      }
      if (upload.expiresAt.getTime() <= Date.now()) {
        return c.json({ error: "upload expired" }, 410);
      }
      const index = Number(indexStr);
      if (!Number.isInteger(index) || index < 0 || index >= upload.totalChunks) {
        return c.json({ error: `chunk index out of range [0, ${upload.totalChunks})` }, 400);
      }
      // 既存 S3 オブジェクトを上書き破壊しないよう、Content-Length を必須にして
      // chunkSize 違反は write 前に reject する (CL なし=真の chunked は 411)
      const declaredRaw = c.req.header("content-length");
      if (declaredRaw == null) {
        return c.json({ error: "content-length header required" }, 411);
      }
      const declared = Number(declaredRaw);
      if (!Number.isFinite(declared) || declared < 0 || !Number.isInteger(declared)) {
        return c.json({ error: "content-length must be a non-negative integer" }, 400);
      }
      if (declared > upload.chunkSize) {
        return c.json({ error: `chunk exceeds declared chunkSize ${upload.chunkSize}` }, 413);
      }
      if (declared > MAX_SINGLE_CHUNK_BYTES) {
        return c.json({ error: `chunk too large (max ${MAX_SINGLE_CHUNK_BYTES} bytes)` }, 413);
      }
      const contentType = c.req.header("content-type") ?? "application/octet-stream";
      const key = uploadChunkKey(project.id, upload.id, index);
      let size: number;
      try {
        size = await uploadRawRequest(key, c.req.raw, contentType);
      } catch (err) {
        return c.json(
          { error: `chunk upload failed: ${err instanceof Error ? err.message : String(err)}` },
          500,
        );
      }
      // クライアントが CL で嘘をついて多く送ってきた防衛策。CL を信じて write 前検証
      // を通したあとに size > chunkSize にはならない想定だが念のため
      if (size > upload.chunkSize) {
        await getS3()
          .delete(key)
          .catch(() => {});
        return c.json({ error: `chunk exceeds declared chunkSize ${upload.chunkSize}` }, 413);
      }
      // S3 write 完了から DB 反映までの間に /complete が status を flip しうるので、
      // tx 内で status=pending を再確認してから書く。flipped していたら S3 にだけ
      // 残った遅延書き込みは best-effort で消す (failed の場合 task 完了時の prefix
      // cleanup or sweeper でも回収される)
      const txResult = await prisma.$transaction(async (tx) => {
        const fresh = await tx.upload.findUnique({
          where: { id: upload.id },
          select: { status: true, expiresAt: true },
        });
        if (!fresh || fresh.status !== "pending") {
          return { stale: true as const, status: fresh?.status ?? "missing" };
        }
        if (fresh.expiresAt.getTime() <= Date.now()) {
          return { stale: true as const, status: "expired" as const };
        }
        const existing = await tx.uploadChunk.findUnique({
          where: { uploadId_index: { uploadId: upload.id, index } },
        });
        if (existing) {
          const delta = BigInt(size) - existing.sizeBytes;
          await tx.uploadChunk.update({
            where: { uploadId_index: { uploadId: upload.id, index } },
            data: { sizeBytes: BigInt(size) },
          });
          await tx.upload.update({
            where: { id: upload.id },
            data: { receivedBytes: { increment: delta } },
          });
        } else {
          await tx.uploadChunk.create({
            data: { uploadId: upload.id, index, sizeBytes: BigInt(size) },
          });
          await tx.upload.update({
            where: { id: upload.id },
            data: { receivedBytes: { increment: BigInt(size) } },
          });
        }
        return { stale: false as const };
      });
      if (txResult.stale) {
        await getS3()
          .delete(key)
          .catch(() => {});
        return c.json({ error: `upload is ${txResult.status}` }, 409);
      }
      const updated = await prisma.upload.findUniqueOrThrow({ where: { id: upload.id } });
      return c.json({ upload: toApiUpload(updated) satisfies ApiUpload });
    },
  )

  // 全 chunk 揃った前提で finalize。Task を pending で作成し background runner を起動。
  // ffmpeg は非同期で走り、完了は GET /tasks/:taskId の polling で取る
  .post("/:id/uploads/:uploadId/complete", vValidator("param", uploadIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, uploadId } = c.req.valid("param");
    const project = await findProjectOr404(user.id, id);
    if (!project) return c.json({ error: "project not found" }, 404);

    // 並行 /complete を直列化するため、validate と claim を 1 つの transaction に置く。
    // updateMany({where: status:"pending"}) で claim を原子化し、count==0 なら race 敗北
    type CompleteOutcome =
      | { kind: "claimed"; task: ApiTask }
      | { kind: "race_lost"; task: ApiTask }
      | {
          kind: "error";
          status: 400 | 404 | 409 | 410 | 500;
          error: string;
        };
    const outcome: CompleteOutcome = await prisma.$transaction(async (tx) => {
      const upload = await tx.upload.findFirst({
        where: { id: uploadId, projectId: project.id },
        include: { chunks: { select: { index: true, sizeBytes: true } } },
      });
      if (!upload) {
        return { kind: "error", status: 404, error: "upload not found" };
      }
      if (upload.status === "completed") {
        const existing = await tx.task.findFirst({
          where: { uploadId: upload.id },
          orderBy: { createdAt: "desc" },
        });
        if (existing) return { kind: "race_lost", task: toApiTask(existing) };
        return { kind: "error", status: 500, error: "completed upload has no task" };
      }
      if (upload.status !== "pending") {
        return { kind: "error", status: 409, error: `upload is ${upload.status}` };
      }
      if (upload.expiresAt.getTime() <= Date.now()) {
        return { kind: "error", status: 410, error: "upload expired" };
      }
      if (upload.chunks.length !== upload.totalChunks) {
        return {
          kind: "error",
          status: 400,
          error: `missing chunks: received ${upload.chunks.length}/${upload.totalChunks}`,
        };
      }
      const seen = new Set(upload.chunks.map((chunk) => chunk.index));
      for (let i = 0; i < upload.totalChunks; i++) {
        if (!seen.has(i)) {
          return { kind: "error", status: 400, error: `missing chunk ${i}` };
        }
      }
      const sum = upload.chunks.reduce((acc, chunk) => acc + chunk.sizeBytes, 0n);
      if (sum !== upload.totalBytes) {
        return {
          kind: "error",
          status: 400,
          error: `byte total mismatch: received ${sum}, declared ${upload.totalBytes}`,
        };
      }
      // atomic claim: 同時 /complete のもう一方は count=0 で抜ける
      const claimed = await tx.upload.updateMany({
        where: { id: upload.id, status: "pending" },
        data: { status: "completed" },
      });
      if (claimed.count === 0) {
        const existing = await tx.task.findFirst({
          where: { uploadId: upload.id },
          orderBy: { createdAt: "desc" },
        });
        if (existing) return { kind: "race_lost", task: toApiTask(existing) };
        return { kind: "error", status: 500, error: "race lost but no task found" };
      }
      const task = await tx.task.create({
        data: {
          projectId: project.id,
          type: upload.kind === "video" ? "video_validation" : "audio_validation",
          uploadId: upload.id,
          status: "pending",
        },
      });
      // task 走行中に sweeper に chunks を消されないよう mark の grace を伸ばす。
      // task 完了時に executeTask が prefix と一緒に mark を消す
      await tx.deletionMark.updateMany({
        where: { prefix: uploadPrefix(project.id, upload.id) },
        data: { nextRetryAt: new Date(Date.now() + TASK_GRACE_MS) },
      });
      return { kind: "claimed", task: toApiTask(task) };
    });

    if (outcome.kind === "error") return c.json({ error: outcome.error }, outcome.status);
    if (outcome.kind === "claimed") enqueueTask(outcome.task.id);
    return c.json({ task: outcome.task satisfies ApiTask }, outcome.kind === "claimed" ? 201 : 200);
  })

  // pending な upload の自発キャンセル用。completed 後は task が chunks を必要とするので拒否
  .delete("/:id/uploads/:uploadId", vValidator("param", uploadIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, uploadId } = c.req.valid("param");
    const project = await findProjectOr404(user.id, id);
    if (!project) return c.json({ error: "project not found" }, 404);
    const prefix = uploadPrefix(project.id, uploadId);
    // tx 内で status=pending を再確認して flip すれば、aborted への遷移が
    // /complete とすれ違うのを防げる
    const aborted = await prisma.$transaction(async (tx) => {
      const upload = await tx.upload.findFirst({
        where: { id: uploadId, projectId: project.id },
        select: { status: true },
      });
      if (!upload) return { ok: false as const, status: 404 as const, error: "upload not found" };
      if (upload.status !== "pending") {
        return {
          ok: false as const,
          status: 409 as const,
          error: `cannot abort: upload is ${upload.status}`,
        };
      }
      await tx.uploadChunk.deleteMany({ where: { uploadId } });
      await tx.upload.update({ where: { id: uploadId }, data: { status: "aborted" } });
      return { ok: true as const };
    });
    if (!aborted.ok) return c.json({ error: aborted.error }, aborted.status);
    await eagerCleanupAndUnmark(prefix);
    return c.body(null, 204);
  })

  .get("/:id/tasks", vValidator("param", idParamSchema), async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.valid("param").id);
    if (!project) return c.json({ error: "project not found" }, 404);
    const tasks = await prisma.task.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
    });
    return c.json({ tasks: tasks.map(toApiTask) satisfies ApiTask[] });
  })

  .get("/:id/tasks/:taskId", vValidator("param", taskIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, taskId } = c.req.valid("param");
    const project = await findProjectOr404(user.id, id);
    if (!project) return c.json({ error: "project not found" }, 404);
    const task = await prisma.task.findFirst({
      where: { id: taskId, projectId: project.id },
    });
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ task: toApiTask(task) satisfies ApiTask });
  })

  .delete("/:id/videos/:videoId", vValidator("param", videoIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, videoId } = c.req.valid("param");
    const project = await findProjectOr404(user.id, id);
    if (!project) return c.json({ error: "project not found" }, 404);
    const video = await prisma.video.findFirst({
      where: { id: videoId, projectId: project.id },
    });
    if (!video) return c.json({ error: "video not found" }, 404);
    const prefix = `${projectKey(project.id)}/videos/${video.id}/`;
    await prisma.$transaction(async (tx) => {
      await tx.deletionMark.create({ data: { prefix } });
      await tx.thumbnail.deleteMany({ where: { videoId: video.id } });
      await tx.video.delete({ where: { id: video.id } });
    });
    await eagerCleanupAndUnmark(prefix);
    return c.body(null, 204);
  })

  .get("/:id/videos/:videoId/stream", vValidator("param", videoIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, videoId } = c.req.valid("param");
    const project = await findProjectOr404(user.id, id);
    if (!project) return c.notFound();
    const video = await prisma.video.findFirst({
      where: { id: videoId, projectId: project.id },
    });
    if (!video) return c.notFound();
    return await streamS3(c, video.videoKey, "video/mp4");
  })

  .get("/:id/videos/:videoId/audio", vValidator("param", videoIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, videoId } = c.req.valid("param");
    const project = await findProjectOr404(user.id, id);
    if (!project) return c.notFound();
    const video = await prisma.video.findFirst({
      where: { id: videoId, projectId: project.id },
    });
    if (!video || !video.audioKey) return c.notFound();
    return await streamS3(c, video.audioKey, "audio/mp4");
  })

  .get(
    "/:id/videos/:videoId/thumbnails/:thumbId",
    vValidator("param", thumbIdParamSchema),
    async (c) => {
      const user = c.var.user;
      const { id, thumbId } = c.req.valid("param");
      const project = await findProjectOr404(user.id, id);
      if (!project) return c.notFound();
      const thumb = await prisma.thumbnail.findFirst({
        where: { id: thumbId, video: { projectId: project.id } },
      });
      if (!thumb) return c.notFound();
      return await streamS3(c, thumb.key, "image/jpeg");
    },
  )

  .delete("/:id/audios/:audioId", vValidator("param", audioIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, audioId } = c.req.valid("param");
    const project = await findProjectOr404(user.id, id);
    if (!project) return c.json({ error: "project not found" }, 404);
    const audio = await prisma.audio.findFirst({
      where: { id: audioId, projectId: project.id },
    });
    if (!audio) return c.json({ error: "audio not found" }, 404);
    const prefix = `${projectKey(project.id)}/audios/${audio.id}/`;
    await prisma.$transaction(async (tx) => {
      await tx.deletionMark.create({ data: { prefix } });
      await tx.audio.delete({ where: { id: audio.id } });
    });
    await eagerCleanupAndUnmark(prefix);
    return c.body(null, 204);
  })

  .get("/:id/audios/:audioId/stream", vValidator("param", audioIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, audioId } = c.req.valid("param");
    const project = await findProjectOr404(user.id, id);
    if (!project) return c.notFound();
    const audio = await prisma.audio.findFirst({
      where: { id: audioId, projectId: project.id },
    });
    if (!audio) return c.notFound();
    return await streamS3(c, audio.audioKey, "audio/mp4");
  })

  .get("/:id/audios/:audioId/raw", vValidator("param", audioIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, audioId } = c.req.valid("param");
    const project = await findProjectOr404(user.id, id);
    if (!project) return c.notFound();
    const audio = await prisma.audio.findFirst({
      where: { id: audioId, projectId: project.id },
    });
    if (!audio || !audio.rawKey) return c.notFound();
    return await streamS3(c, audio.rawKey, audio.rawContentType ?? "application/octet-stream");
  });

// (projectId, order) unique衝突 (P2002) と SQLite write conflict (P2034) 用の保険リトライ
async function withSlotRetry<T>(fn: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 5;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if ((code !== "P2002" && code !== "P2034") || i === MAX_ATTEMPTS - 1) throw err;
    }
  }
  throw new Error("unreachable");
}

export type ProjectsAppType = typeof projects;
