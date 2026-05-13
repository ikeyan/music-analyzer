import { vValidator } from "@hono/valibot-validator";
import * as runtime from "@prisma/client/runtime/client";
import { Either } from "effect";
import type { Context } from "hono";
import { Hono } from "hono";
import * as v from "valibot";
import { type Prisma, type PrismaClient } from "../generated/prisma/client";
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

// throw HTTPException は hc の response 型に乗らないので Either で返す。
// `<const E>` で literal status / 追加プロパティをそのまま伝播させる
type ApiErrorStatus = 400 | 404 | 409 | 410 | 500;
type ApiError = { status: ApiErrorStatus; error: string };

function leftErr<const E extends ApiError>(e: E): Either.Either<never, E> {
  return Either.left(e);
}

// e.status の literal がそのまま c.json の status overload に渡るので、
// hc がエラー status 毎に narrow した response 型を見られる
function leftJson<const E extends ApiError>(c: Context, e: E) {
  const { status, ...body } = e;
  return c.json(body, status);
}

// tx 内で Left を返した場合に rollback したい。Prisma の $transaction は
// throw でしか rollback できないので、内部で throw → 外で catch して Left に戻す
class TxRollback extends Error {
  constructor(public left: unknown) {
    super();
  }
}

async function txEither<A, E>(
  fn: (
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  ) => Promise<Either.Either<A, E>>,
): Promise<Either.Either<A, E>> {
  try {
    const a = await prisma.$transaction(async (tx) => {
      const r = await fn(tx);
      if (Either.isLeft(r)) throw new TxRollback(r.left);
      return r.right;
    });
    return Either.right(a);
  } catch (err) {
    // throw / catch を自分で挟んでいるので left が E であることは確定
    if (err instanceof TxRollback) return Either.left(err.left as E);
    throw err;
  }
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

// 戻り値の型は推論に任せる (literal status / Prisma の Extended Row を保ったまま流す)
async function requireProject(userId: string, projectId: string) {
  const p = await prisma.project.findFirst({ where: { id: projectId, userId } });
  if (!p) return leftErr({ status: 404, error: "project not found" });
  return Either.right(p);
}

// prisma / tx のどちらでも呼べる。generics は呼び出し側から素通し
async function requireUpload<
  LogOpts extends Prisma.LogLevel,
  OmitOpts extends Prisma.PrismaClientOptions["omit"],
  ExtArgs extends runtime.Types.Extensions.InternalArgs,
>(client: PrismaClientLike<LogOpts, OmitOpts, ExtArgs>, uploadId: string, projectId: string) {
  const upload = await client.upload.findFirst({ where: { id: uploadId, projectId } });
  if (!upload) return leftErr({ status: 404, error: "upload not found" });
  return Either.right(upload);
}

type UploadRow = NonNullable<Awaited<ReturnType<typeof prisma.upload.findFirst>>>;

// pending + 未期限 check。Right が upload row なので requirePendingUpload と直接合成可能。
// 返り値型を明示しないと leftErr 毎の Either<never, X> が union のまま残り、合成側で
// 同じ Right 型に並べたとき variance が合わない
function checkUploadPending<U extends UploadRow>(
  upload: U,
): Either.Either<U, { status: 409 | 410; error: string }> {
  if (upload.status !== "pending") {
    return Either.left({ status: 409, error: `upload is ${upload.status}` });
  }
  if (upload.expiresAt.getTime() <= Date.now()) {
    return Either.left({ status: 410, error: "upload expired" });
  }
  return Either.right(upload);
}

async function requirePendingUpload(
  uploadId: string,
  projectId: string,
): Promise<Either.Either<UploadRow, { status: 404 | 409 | 410; error: string }>> {
  const r = await requireUpload(prisma, uploadId, projectId);
  if (Either.isLeft(r)) return r;
  return checkUploadPending(r.right);
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
    const projectR = await requireProject(user.id, c.req.valid("param").id);
    if (Either.isLeft(projectR)) return leftJson(c, projectR.left);
    const project = projectR.right;
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
      const projectR = await requireProject(user.id, c.req.valid("param").id);
      if (Either.isLeft(projectR)) return leftJson(c, projectR.left);
      const project = projectR.right;
      const { tracks: newOrder } = c.req.valid("json");

      // withSlotRetry が P2002/P2034 throw を retry。validation 失敗の Left は
      // txEither 内で rollback してから上に伝わるので retry 対象外
      type TrackOrderErr = { status: 400; error: string };
      const txResult = await withSlotRetry(() =>
        txEither<void, TrackOrderErr>(async (tx) => {
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
            return leftErr({ status: 400, error: "track-order: length mismatch" });
          }
          const videoMap = new Map(videos.map((row) => [row.id, row]));
          const audioMap = new Map(audios.map((row) => [row.id, row]));
          const seen = new Set<string>();
          for (const t of newOrder) {
            const exists = t.kind === "video" ? videoMap.has(t.id) : audioMap.has(t.id);
            if (!exists) {
              return leftErr({
                status: 400,
                error: `track-order: unknown ${t.kind} id ${t.id}`,
              });
            }
            const key = `${t.kind}:${t.id}`;
            if (seen.has(key)) {
              return leftErr({
                status: 400,
                error: `track-order: duplicate ${t.kind} id ${t.id}`,
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
          return Either.right(undefined);
        }),
      );
      if (Either.isLeft(txResult)) return leftJson(c, txResult.left);

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
      const projectR = await requireProject(user.id, c.req.valid("param").id);
      if (Either.isLeft(projectR)) return leftJson(c, projectR.left);
      const project = projectR.right;
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
      const projectR = await requireProject(user.id, id);
      if (Either.isLeft(projectR)) return leftJson(c, projectR.left);
      const project = projectR.right;
      const uploadR = await requirePendingUpload(uploadId, project.id);
      if (Either.isLeft(uploadR)) return leftJson(c, uploadR.left);
      const upload = uploadR.right;
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
    const projectR = await requireProject(user.id, id);
    if (Either.isLeft(projectR)) return leftJson(c, projectR.left);
    const project = projectR.right;

    // claim-first: 全 precondition を updateMany.where に畳んで原子化 (skill: prisma-claim-first)。
    // 失敗時 (count===0) だけ findFirst で診断し、既に completed なら冪等返却、それ以外は Left。
    // claim 後の validate 失敗は txEither が内部 throw で rollback してくれる
    type CompleteResult = { task: ApiTask; enqueue: boolean };
    type CompleteErr = { status: 400 | 404 | 409 | 410 | 500; error: string };
    const result = await txEither<CompleteResult, CompleteErr>(async (tx) => {
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
        const uploadR = await requireUpload(tx, uploadId, project.id);
        // Right の型が違う Either はそのまま return できないので Either.left で rewrap する
        if (Either.isLeft(uploadR)) return Either.left(uploadR.left);
        const upload = uploadR.right;
        if (upload.status === "completed") {
          // 冪等: 既存 task を返す。並行 /complete の loser もここに来る
          const existing = await tx.task.findFirst({
            where: { uploadId: upload.id },
            orderBy: { createdAt: "desc" },
            include: { upload: { select: { fileName: true, kind: true } } },
          });
          if (!existing) return leftErr({ status: 500, error: "completed upload has no task" });
          return Either.right({ task: toApiTask(existing), enqueue: false });
        }
        const check = checkUploadPending(upload);
        if (Either.isLeft(check)) return Either.left(check.left);
        return leftErr({
          status: 500,
          error: "unreachable: claim failed but upload is pending",
        });
      }
      // claim 済み行を read。write lock を握っているので並行 read+write しない
      const upload = await tx.upload.findUniqueOrThrow({ where: { id: uploadId } });
      const chunks = await tx.uploadChunk.findMany({
        where: { uploadId: upload.id },
        select: { index: true, sizeBytes: true },
      });
      if (chunks.length !== upload.totalChunks) {
        return leftErr({
          status: 400,
          error: `missing chunks: received ${chunks.length}/${upload.totalChunks}`,
        });
      }
      const seen = new Set(chunks.map((chunk) => chunk.index));
      for (let i = 0; i < upload.totalChunks; i++) {
        if (!seen.has(i)) return leftErr({ status: 400, error: `missing chunk ${i}` });
      }
      const sum = chunks.reduce((acc, chunk) => acc + chunk.sizeBytes, 0n);
      if (sum !== upload.totalBytes) {
        return leftErr({
          status: 400,
          error: `byte total mismatch: received ${sum}, declared ${upload.totalBytes}`,
        });
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
      return Either.right({ task: toApiTask(task), enqueue: true });
    });
    if (Either.isLeft(result)) return leftJson(c, result.left);
    if (result.right.enqueue) enqueueTask(result.right.task.id);
    return c.json({ task: result.right.task satisfies ApiTask });
  })

  // pending な upload の自発キャンセル用。completed 後は task が chunks を必要とするので拒否
  .delete("/:id/uploads/:uploadId", vValidator("param", uploadIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, uploadId } = c.req.valid("param");
    const projectR = await requireProject(user.id, id);
    if (Either.isLeft(projectR)) return leftJson(c, projectR.left);
    const project = projectR.right;
    const prefix = uploadPrefix(project.id, uploadId);
    // claim-first で pending → aborted に遷移 (skill: prisma-claim-first)。
    // 期限切れ pending も abort 対象なので expiresAt 条件は付けない
    type AbortErr = { status: 404 | 409; error: string };
    const result = await txEither<void, AbortErr>(async (tx) => {
      const claimed = await tx.upload.updateMany({
        where: { id: uploadId, projectId: project.id, status: "pending" },
        data: { status: "aborted" },
      });
      if (claimed.count === 0) {
        const uploadR = await requireUpload(tx, uploadId, project.id);
        if (Either.isLeft(uploadR)) return Either.left(uploadR.left);
        return leftErr({
          status: 409,
          error: `cannot abort: upload is ${uploadR.right.status}`,
        });
      }
      await tx.uploadChunk.deleteMany({ where: { uploadId } });
      return Either.right(undefined);
    });
    if (Either.isLeft(result)) return leftJson(c, result.left);
    await eagerCleanupAndUnmark(prefix);
    return c.body(null, 204);
  })

  .get("/:id/tasks", vValidator("param", idParamSchema), async (c) => {
    const user = c.var.user;
    const projectR = await requireProject(user.id, c.req.valid("param").id);
    if (Either.isLeft(projectR)) return leftJson(c, projectR.left);
    const project = projectR.right;
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
    const projectR = await requireProject(user.id, id);

    if (Either.isLeft(projectR)) return leftJson(c, projectR.left);

    const project = projectR.right;
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
    const projectR = await requireProject(user.id, id);

    if (Either.isLeft(projectR)) return leftJson(c, projectR.left);

    const project = projectR.right;
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
    const projectR = await requireProject(user.id, id);

    if (Either.isLeft(projectR)) return leftJson(c, projectR.left);

    const project = projectR.right;
    const video = await prisma.video.findFirst({
      where: { id: videoId, projectId: project.id },
    });
    if (!video) return c.notFound();
    return await streamS3(c, video.videoKey, "video/mp4");
  })

  .get("/:id/videos/:videoId/audio", vValidator("param", videoIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, videoId } = c.req.valid("param");
    const projectR = await requireProject(user.id, id);

    if (Either.isLeft(projectR)) return leftJson(c, projectR.left);

    const project = projectR.right;
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
      const projectR = await requireProject(user.id, id);

      if (Either.isLeft(projectR)) return leftJson(c, projectR.left);

      const project = projectR.right;
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
    const projectR = await requireProject(user.id, id);

    if (Either.isLeft(projectR)) return leftJson(c, projectR.left);

    const project = projectR.right;
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
    const projectR = await requireProject(user.id, id);

    if (Either.isLeft(projectR)) return leftJson(c, projectR.left);

    const project = projectR.right;
    const audio = await prisma.audio.findFirst({
      where: { id: audioId, projectId: project.id },
    });
    if (!audio) return c.notFound();
    return await streamS3(c, audio.audioKey, "audio/mp4");
  })

  .get("/:id/audios/:audioId/raw", vValidator("param", audioIdParamSchema), async (c) => {
    const user = c.var.user;
    const { id, audioId } = c.req.valid("param");
    const projectR = await requireProject(user.id, id);

    if (Either.isLeft(projectR)) return leftJson(c, projectR.left);

    const project = projectR.right;
    const audio = await prisma.audio.findFirst({
      where: { id: audioId, projectId: project.id },
    });
    if (!audio || !audio.rawKey) return c.notFound();
    return await streamS3(c, audio.rawKey, audio.rawContentType ?? "application/octet-stream");
  });

export type ProjectsAppType = typeof projects;
