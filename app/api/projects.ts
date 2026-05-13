import { vValidator } from "@hono/valibot-validator";
import * as runtime from "@prisma/client/runtime/client";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as v from "valibot";
import { type Prisma, type PrismaClient, type Upload } from "../generated/prisma/client";
import { type AuthContext, requireUser } from "../lib/auth";
import { describeError } from "../lib/error";
import { MAX_UPLOAD_BYTES } from "../lib/ffmpeg";
import { eagerCleanupAndUnmark, markPrefixForDeletion } from "../lib/gc";
import { prisma } from "../lib/prisma";
import { withSlotRetry } from "../lib/prisma-retry";
import { getS3 } from "../lib/s3";
import {
  audioPrefix,
  projectPrefix,
  streamS3,
  uploadChunkKey,
  uploadPrefix,
  uploadRawRequest,
  videoPrefix,
} from "../lib/storage";
import { TASK_GRACE_MS, enqueueTask } from "../lib/task-runner";
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

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
// 極小チャンク DoS 防止
const MIN_CHUNK_SIZE = 1024;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;

// prisma も tx もどちらも受けたいので $transaction だけ除いた型を作る。
// 呼び出し側は generics を素通しする (デフォルトを置くと推論に巻き込まれる)
type PrismaClientLike<
  in LogOpts extends Prisma.LogLevel,
  in out OmitOpts extends Prisma.PrismaClientOptions["omit"],
  in out ExtArgs extends runtime.Types.Extensions.InternalArgs,
> = Omit<PrismaClient<LogOpts, OmitOpts, ExtArgs>, runtime.ITXClientDenyList>;

// HTTPException のレスポンス本体を `{ error: message }` JSON に統一する
function httpJsonError(status: ContentfulStatusCode, message: string): HTTPException {
  return new HTTPException(status, {
    res: Response.json({ error: message }, { status }),
  });
}

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

// project 不在なら 404 を throw。レスポンス本体は JSON `{ error }`
async function requireProject(userId: string, projectId: string) {
  const p = await prisma.project.findFirst({ where: { id: projectId, userId } });
  if (!p) throw httpJsonError(404, "project not found");
  return p;
}

// upload 不在なら 404 を throw。prisma / tx どちらでも呼べる
async function requireUpload<
  LogOpts extends Prisma.LogLevel,
  OmitOpts extends Prisma.PrismaClientOptions["omit"],
  ExtArgs extends runtime.Types.Extensions.InternalArgs,
>(client: PrismaClientLike<LogOpts, OmitOpts, ExtArgs>, uploadId: string, projectId: string) {
  const upload = await client.upload.findFirst({ where: { id: uploadId, projectId } });
  if (!upload) throw httpJsonError(404, "upload not found");
  return upload;
}

// upload が pending かつ未期限であることを表明。fetched 済みの row に対して使う
function assertUploadPending(upload: Pick<Upload, "status" | "expiresAt">): void {
  if (upload.status !== "pending") throw httpJsonError(409, `upload is ${upload.status}`);
  if (upload.expiresAt.getTime() <= Date.now()) throw httpJsonError(410, "upload expired");
}

// tx 外用: 取得 + status/expiresAt チェックをまとめる
async function requirePendingUpload(uploadId: string, projectId: string) {
  const upload = await requireUpload(prisma, uploadId, projectId);
  assertUploadPending(upload);
  return upload;
}

// GET /:id, PATCH /:id/track-order, SSR route で共通する Project detail loader。
// 戻り値の include shape は toApiProjectDetail への射影と合わせる。
// succeeded task は Video/Audio として timeline に出るので除外
export async function findProjectDetail(userId: string, projectId: string) {
  return await prisma.project.findFirst({
    where: { id: projectId, userId },
    include: {
      videos: { orderBy: { order: "asc" }, include: { thumbnails: { orderBy: { atSec: "asc" } } } },
      audios: { orderBy: { order: "asc" } },
      tasks: {
        where: { status: { in: ["pending", "running", "failed"] } },
        orderBy: { createdAt: "desc" },
        include: { upload: { select: { fileName: true, kind: true } } },
      },
    },
  });
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
    const project = await findProjectDetail(user.id, c.req.valid("param").id);
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json({ project: toApiProjectDetail(project) satisfies ApiProjectDetail });
  })
  .delete("/:id", vValidator("param", idParamSchema), async (c) => {
    const user = c.var.user;
    const project = await requireProject(user.id, c.req.valid("param").id);
    const prefix = projectPrefix(project.id);
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
      const project = await requireProject(user.id, c.req.valid("param").id);
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

      const updated = await findProjectDetail(user.id, project.id);
      if (!updated) return c.json({ error: "project not found" }, 404);
      return c.json({ project: toApiProjectDetail(updated) satisfies ApiProjectDetail });
    },
  )

  .post(
    "/:id/uploads",
    vValidator("param", idParamSchema),
    vValidator("json", createUploadSchema),
    async (c) => {
      const user = c.var.user;
      const project = await requireProject(user.id, c.req.valid("param").id);
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

  .put(
    "/:id/uploads/:uploadId/chunks/:index",
    vValidator("param", uploadChunkParamSchema),
    async (c) => {
      const user = c.var.user;
      const { id, uploadId, index: indexStr } = c.req.valid("param");
      const project = await requireProject(user.id, id);
      const upload = await requirePendingUpload(uploadId, project.id);
      const index = Number(indexStr);
      if (!Number.isInteger(index) || index < 0 || index >= upload.totalChunks) {
        return c.json({ error: `chunk index out of range [0, ${upload.totalChunks})` }, 400);
      }
      // CL 必須。違反は write 前に reject して既存 S3 を破壊しない
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
      if (declared > MAX_CHUNK_SIZE) {
        return c.json({ error: `chunk too large (max ${MAX_CHUNK_SIZE} bytes)` }, 413);
      }
      const contentType = c.req.header("content-type") ?? "application/octet-stream";
      // PUT ごとに固有 s3Key (= DB row が指す 1 object)、tx で promote
      const writeId = crypto.randomUUID();
      const newS3Key = uploadChunkKey(project.id, upload.id, index, writeId);
      let size: number;
      try {
        size = await uploadRawRequest(newS3Key, c.req.raw, contentType);
      } catch (err) {
        return c.json({ error: `chunk upload failed: ${describeError(err)}` }, 500);
      }
      if (size > upload.chunkSize) {
        // CL pre-check の防衛策
        await getS3()
          .delete(newS3Key)
          .catch(() => {});
        return c.json({ error: `chunk exceeds declared chunkSize ${upload.chunkSize}` }, 413);
      }
      // delta 計算用に既存 chunk を read してから、upload の precondition を畳んだ
      // updateMany で claim-first する (skill: prisma-claim-first)。
      // stale (count===0) なら新規 S3 を消すために throw ではなく戻り値で stale を表す
      const promoteResult = await prisma.$transaction(async (tx) => {
        const existing = await tx.uploadChunk.findUnique({
          where: { uploadId_index: { uploadId: upload.id, index } },
        });
        const delta = existing ? BigInt(size) - existing.sizeBytes : BigInt(size);
        const claimed = await tx.upload.updateMany({
          where: {
            id: upload.id,
            status: "pending",
            expiresAt: { gt: new Date() },
          },
          data: { receivedBytes: { increment: delta } },
        });
        if (claimed.count === 0) {
          const fresh = await tx.upload.findUnique({
            where: { id: upload.id },
            select: { status: true, expiresAt: true },
          });
          if (!fresh) return { stale: true as const, status: "missing" as const, oldS3Key: null };
          if (fresh.status !== "pending") {
            return { stale: true as const, status: fresh.status, oldS3Key: null };
          }
          return { stale: true as const, status: "expired" as const, oldS3Key: null };
        }
        if (existing) {
          await tx.uploadChunk.update({
            where: { uploadId_index: { uploadId: upload.id, index } },
            data: { sizeBytes: BigInt(size), s3Key: newS3Key },
          });
          return { stale: false as const, oldS3Key: existing.s3Key };
        }
        await tx.uploadChunk.create({
          data: { uploadId: upload.id, index, sizeBytes: BigInt(size), s3Key: newS3Key },
        });
        return { stale: false as const, oldS3Key: null };
      });
      if (promoteResult.stale) {
        await getS3()
          .delete(newS3Key)
          .catch(() => {});
        return c.json({ error: `upload is ${promoteResult.status}` }, 409);
      }
      if (promoteResult.oldS3Key && promoteResult.oldS3Key !== newS3Key) {
        await getS3()
          .delete(promoteResult.oldS3Key)
          .catch(() => {});
      }
      const updated = await prisma.upload.findUniqueOrThrow({ where: { id: upload.id } });
      return c.json({ upload: toApiUpload(updated) satisfies ApiUpload });
    },
  )

  .post("/:id/uploads/:uploadId/complete", vValidator("param", uploadIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, uploadId } = c.req.valid("param");
    const project = await requireProject(user.id, id);

    // claim-first: 全 precondition を updateMany.where に畳んで原子化する。
    // 並行 /complete も PUT promotion tx も race しても deadlock しない (skill: prisma-claim-first)。
    // 失敗時 (count===0) だけ findFirst で診断し、既に completed なら冪等返却、それ以外は throw。
    // throw は $transaction が自動 rollback してくれるので claim も巻き戻る
    const result = await prisma.$transaction(async (tx) => {
      const claimed = await tx.upload.updateMany({
        where: {
          id: uploadId,
          projectId: project.id,
          status: "pending",
          expiresAt: { gt: new Date() },
        },
        data: { status: "completed" },
      });
      if (claimed.count === 0) {
        const upload = await requireUpload(tx, uploadId, project.id);
        if (upload.status === "completed") {
          // 冪等: 既存 task を返す。並行 /complete の loser もここに来る
          const task = await tx.task.findFirst({
            where: { uploadId: upload.id },
            orderBy: { createdAt: "desc" },
            include: { upload: { select: { fileName: true, kind: true } } },
          });
          if (!task) throw httpJsonError(500, "completed upload has no task");
          return { task: toApiTask(task), enqueue: false };
        }
        // not pending / expired を共通ヘルパで仕分け
        assertUploadPending(upload);
        throw new Error("unreachable: claim failed but upload is pending and not expired");
      }
      // claim 済み行を read。write lock を握っているので並行 read+write しない
      const upload = await tx.upload.findUniqueOrThrow({ where: { id: uploadId } });
      const chunks = await tx.uploadChunk.findMany({
        where: { uploadId: upload.id },
        select: { index: true, sizeBytes: true },
      });
      if (chunks.length !== upload.totalChunks) {
        throw httpJsonError(400, `missing chunks: received ${chunks.length}/${upload.totalChunks}`);
      }
      const seen = new Set(chunks.map((chunk) => chunk.index));
      for (let i = 0; i < upload.totalChunks; i++) {
        if (!seen.has(i)) throw httpJsonError(400, `missing chunk ${i}`);
      }
      const sum = chunks.reduce((acc, chunk) => acc + chunk.sizeBytes, 0n);
      if (sum !== upload.totalBytes) {
        throw httpJsonError(
          400,
          `byte total mismatch: received ${sum}, declared ${upload.totalBytes}`,
        );
      }
      const task = await tx.task.create({
        data: {
          projectId: project.id,
          type: upload.kind === "video" ? "video_validation" : "audio_validation",
          uploadId: upload.id,
          status: "pending",
        },
        include: { upload: { select: { fileName: true, kind: true } } },
      });
      // task 走行中の sweep を防ぐ。完了時 executeTask が mark ごと回収
      await tx.deletionMark.updateMany({
        where: { prefix: uploadPrefix(project.id, upload.id) },
        data: { nextRetryAt: new Date(Date.now() + TASK_GRACE_MS) },
      });
      return { task: toApiTask(task), enqueue: true };
    });

    if (result.enqueue) enqueueTask(result.task.id);
    return c.json({ task: result.task satisfies ApiTask });
  })

  // pending な upload の自発キャンセル用。completed 後は task が chunks を必要とするので拒否
  .delete("/:id/uploads/:uploadId", vValidator("param", uploadIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, uploadId } = c.req.valid("param");
    const project = await requireProject(user.id, id);
    const prefix = uploadPrefix(project.id, uploadId);
    // tx 内で status=pending を再確認して /complete と直列化
    // claim-first で pending → aborted に遷移 (skill: prisma-claim-first)。
    // 期限切れ pending も abort 対象なので expiresAt 条件は付けない
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.upload.updateMany({
        where: { id: uploadId, projectId: project.id, status: "pending" },
        data: { status: "aborted" },
      });
      if (claimed.count === 0) {
        const upload = await requireUpload(tx, uploadId, project.id);
        throw httpJsonError(409, `cannot abort: upload is ${upload.status}`);
      }
      await tx.uploadChunk.deleteMany({ where: { uploadId } });
    });
    await eagerCleanupAndUnmark(prefix);
    return c.body(null, 204);
  })

  .get("/:id/tasks", vValidator("param", idParamSchema), async (c) => {
    const user = c.var.user;
    const project = await requireProject(user.id, c.req.valid("param").id);
    const tasks = await prisma.task.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
      include: { upload: { select: { fileName: true, kind: true } } },
    });
    return c.json({ tasks: tasks.map(toApiTask) satisfies ApiTask[] });
  })

  .get("/:id/tasks/:taskId", vValidator("param", taskIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, taskId } = c.req.valid("param");
    const project = await requireProject(user.id, id);
    const task = await prisma.task.findFirst({
      where: { id: taskId, projectId: project.id },
      include: { upload: { select: { fileName: true, kind: true } } },
    });
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ task: toApiTask(task) satisfies ApiTask });
  })

  .delete("/:id/videos/:videoId", vValidator("param", videoIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, videoId } = c.req.valid("param");
    const project = await requireProject(user.id, id);
    const video = await prisma.video.findFirst({
      where: { id: videoId, projectId: project.id },
    });
    if (!video) return c.json({ error: "video not found" }, 404);
    const prefix = videoPrefix(project.id, video.id);
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
    const project = await requireProject(user.id, id);
    const video = await prisma.video.findFirst({
      where: { id: videoId, projectId: project.id },
    });
    if (!video) return c.notFound();
    return await streamS3(c, video.videoKey, "video/mp4");
  })

  .get("/:id/videos/:videoId/audio", vValidator("param", videoIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, videoId } = c.req.valid("param");
    const project = await requireProject(user.id, id);
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
      const project = await requireProject(user.id, id);
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
    const project = await requireProject(user.id, id);
    const audio = await prisma.audio.findFirst({
      where: { id: audioId, projectId: project.id },
    });
    if (!audio) return c.json({ error: "audio not found" }, 404);
    const prefix = audioPrefix(project.id, audio.id);
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
    const project = await requireProject(user.id, id);
    const audio = await prisma.audio.findFirst({
      where: { id: audioId, projectId: project.id },
    });
    if (!audio) return c.notFound();
    return await streamS3(c, audio.audioKey, "audio/mp4");
  })

  .get("/:id/audios/:audioId/raw", vValidator("param", audioIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, audioId } = c.req.valid("param");
    const project = await requireProject(user.id, id);
    const audio = await prisma.audio.findFirst({
      where: { id: audioId, projectId: project.id },
    });
    if (!audio || !audio.rawKey) return c.notFound();
    return await streamS3(c, audio.rawKey, audio.rawContentType ?? "application/octet-stream");
  });

export type ProjectsAppType = typeof projects;
