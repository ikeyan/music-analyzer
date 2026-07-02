import { vValidator } from "@hono/valibot-validator";
import { Effect, Either, pipe } from "effect";
import { Hono } from "hono";
import * as v from "valibot";
import { requireUser } from "../lib/auth";
import { leftErr, provideEitherJson } from "../lib/either-json";
import { describeError } from "../lib/error";
import { MAX_PROJECT_TIMING_SEC, MAX_UPLOAD_BYTES } from "../lib/ffmpeg";
import { eagerCleanupAndUnmark, markPrefixForDeletion } from "../lib/gc";
import { prisma } from "../lib/prisma";
import { withSlotRetry } from "../lib/prisma-retry";
import {
  type ExtArgs,
  type LogOpts,
  type OmitOpts,
  type PrismaClientLike,
  txEither,
} from "../lib/prisma-tx";
import { getS3 } from "../lib/s3";
import {
  MAX_SPECTROGRAM_BINS,
  MAX_SPECTROGRAM_FMAX_HZ,
  MAX_SPECTROGRAM_HARMONICS,
  MIN_SPECTROGRAM_FMIN_HZ,
  parseHarmonics,
} from "../lib/spectrogram";
import {
  audioPrefix,
  projectPrefix,
  spectrogramMetaKey,
  spectrogramPrefix,
  spectrogramTileKey,
  streamS3,
  uploadChunkKey,
  uploadPrefix,
  uploadRawRequest,
  videoPrefix,
} from "../lib/storage";
import { TASK_GRACE_MS, enqueueTask } from "../lib/task-runner";
import {
  type ApiAudio,
  type ApiProject,
  type ApiProjectDetail,
  type ApiProjectSummary,
  type ApiSpectrogram,
  type ApiTask,
  type ApiUpload,
  type ApiVideo,
  toApiAudio,
  toApiProject,
  toApiProjectDetail,
  toApiProjectSummary,
  toApiSpectrogram,
  toApiTask,
  toApiUpload,
  toApiVideo,
} from "./types";

// upload 完了前に死んだチャンクは 1h grace の DeletionMark + sweeper で回収する
export const UPLOAD_EXPIRY_MS = 60 * 60 * 1000;

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
// 極小チャンク DoS 防止
const MIN_CHUNK_SIZE = 1024;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;

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
const spectrogramIdParamSchema = v.object({
  id: v.string(),
  audioId: v.string(),
  specId: v.string(),
});
const spectrogramTileParamSchema = v.object({
  id: v.string(),
  audioId: v.string(),
  specId: v.string(),
  harmonic: v.string(),
  level: v.string(),
  index: v.string(),
});

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

const createSpectrogramSchema = v.pipe(
  v.object({
    binsPerOctave: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(96)),
    octaves: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
    fminHz: v.pipe(v.number(), v.finite(), v.minValue(MIN_SPECTROGRAM_FMIN_HZ), v.maxValue(4000)),
    harmonics: v.pipe(
      v.array(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16))),
      v.minLength(1),
      v.maxLength(MAX_SPECTROGRAM_HARMONICS),
    ),
  }),
  v.check((d) => new Set(d.harmonics).size === d.harmonics.length, "harmonics must be unique"),
  v.check(
    (d) => d.binsPerOctave * d.octaves <= MAX_SPECTROGRAM_BINS,
    `binsPerOctave * octaves must be <= ${MAX_SPECTROGRAM_BINS}`,
  ),
  v.check(
    (d) => d.fminHz * 2 ** d.octaves <= MAX_SPECTROGRAM_FMAX_HZ,
    `fminHz * 2^octaves must be <= ${MAX_SPECTROGRAM_FMAX_HZ}`,
  ),
);

// 反転は projStart > projEnd で表現するため proj 側に大小制約は置かない。
// src は正方向のみで、durationSec 超過は row 取得後に handler 側で検証する
const timingSchema = v.pipe(
  v.object({
    srcStartSec: v.pipe(v.number(), v.finite(), v.minValue(0)),
    srcEndSec: v.pipe(v.number(), v.finite(), v.minValue(0)),
    projStartSec: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(MAX_PROJECT_TIMING_SEC)),
    projEndSec: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(MAX_PROJECT_TIMING_SEC)),
  }),
  v.check((d) => d.srcEndSec > d.srcStartSec, "srcEndSec must be > srcStartSec"),
  v.check((d) => d.projEndSec !== d.projStartSec, "projEndSec must differ from projStartSec"),
);

// findFirst の結果を Either に持ち上げる小道具。null なら指定の Left、それ以外は Right
function found<R>(notFound: { status: 404; error: string }) {
  return (r: R | null): Either.Either<R, { status: 404; error: string }> =>
    r === null ? leftErr(notFound) : Either.right(r);
}

function requireProject(userId: string, projectId: string) {
  return pipe(
    Effect.promise(() => prisma.project.findFirst({ where: { id: projectId, userId } })),
    Effect.flatMap(found({ status: 404, error: "project not found" })),
  );
}

// prisma / tx のどちらでも呼べる。generics は呼び出し側から素通し
function requireUpload<L extends LogOpts, O extends OmitOpts, E extends ExtArgs>(
  client: PrismaClientLike<L, O, E>,
  uploadId: string,
  projectId: string,
) {
  return pipe(
    Effect.promise(() => client.upload.findFirst({ where: { id: uploadId, projectId } })),
    Effect.flatMap(found({ status: 404, error: "upload not found" })),
  );
}

type UploadRow = NonNullable<Awaited<ReturnType<typeof prisma.upload.findFirst>>>;

// 戻り値型を明示しないと leftErr の Either<never, X> が union のまま残り variance が合わない
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

function requirePendingUpload(uploadId: string, projectId: string) {
  return pipe(requireUpload(prisma, uploadId, projectId), Effect.flatMap(checkUploadPending));
}

function requireVideo(projectId: string, videoId: string) {
  return pipe(
    Effect.promise(() => prisma.video.findFirst({ where: { id: videoId, projectId } })),
    Effect.flatMap(found({ status: 404, error: "video not found" })),
  );
}

function requireAudio(projectId: string, audioId: string) {
  return pipe(
    Effect.promise(() => prisma.audio.findFirst({ where: { id: audioId, projectId } })),
    Effect.flatMap(found({ status: 404, error: "audio not found" })),
  );
}

function requireSpectrogram(audioId: string, specId: string) {
  return pipe(
    Effect.promise(() => prisma.spectrogram.findFirst({ where: { id: specId, audioId } })),
    Effect.flatMap(found({ status: 404, error: "spectrogram not found" })),
  );
}

function requireReadySpectrogram(audioId: string, specId: string) {
  return pipe(
    requireSpectrogram(audioId, specId),
    Effect.flatMap((s) =>
      s.status === "ready"
        ? Either.right(s)
        : leftErr({ status: 409, error: `spectrogram is ${s.status}` }),
    ),
  );
}

function requireThumbnail(projectId: string, thumbId: string) {
  return pipe(
    Effect.promise(() =>
      prisma.thumbnail.findFirst({ where: { id: thumbId, video: { projectId } } }),
    ),
    Effect.flatMap(found({ status: 404, error: "thumbnail not found" })),
  );
}

// GET /:id, PATCH /:id/track-order, SSR route で共通する Project detail loader。
// succeeded は Video/Audio に置き換わるため除外、failed は dismiss/24h で expireAt が過去になるまで表示
export function requireProjectDetail(userId: string, projectId: string) {
  return pipe(
    Effect.promise(() =>
      prisma.project.findFirst({
        where: { id: projectId, userId },
        include: {
          videos: {
            orderBy: { order: "asc" },
            include: { thumbnails: { orderBy: { atSec: "asc" } } },
          },
          audios: {
            orderBy: { order: "asc" },
            include: { spectrograms: { orderBy: { createdAt: "asc" } } },
          },
          tasks: {
            where: {
              OR: [
                { status: { in: ["pending", "running"] } },
                { status: "failed", OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }] },
              ],
            },
            orderBy: { createdAt: "desc" },
          },
        },
      }),
    ),
    Effect.flatMap(found({ status: 404, error: "project not found" })),
  );
}

export const projects = new Hono()
  .use("*", requireUser)
  .use("*", provideEitherJson)
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
  .get("/:id", vValidator("param", idParamSchema), (c) =>
    pipe(
      requireProjectDetail(c.var.user.id, c.req.valid("param").id),
      Effect.map((project): { project: ApiProjectDetail } => ({
        project: toApiProjectDetail(project),
      })),
      Effect.either,
      Effect.map((r) => c.var.eitherJson(r)),
      Effect.runPromise,
    ),
  )
  .delete("/:id", vValidator("param", idParamSchema), (c) =>
    pipe(
      requireProject(c.var.user.id, c.req.valid("param").id),
      Effect.flatMap((project) =>
        Effect.promise(async () => {
          const prefix = projectPrefix(project.id);
          await prisma.$transaction([
            prisma.deletionMark.create({ data: { prefix } }),
            prisma.task.deleteMany({ where: { projectId: project.id } }),
            prisma.uploadChunk.deleteMany({ where: { upload: { projectId: project.id } } }),
            prisma.upload.deleteMany({ where: { projectId: project.id } }),
            prisma.thumbnail.deleteMany({ where: { video: { projectId: project.id } } }),
            prisma.video.deleteMany({ where: { projectId: project.id } }),
            prisma.spectrogram.deleteMany({ where: { audio: { projectId: project.id } } }),
            prisma.audio.deleteMany({ where: { projectId: project.id } }),
            prisma.project.delete({ where: { id: project.id } }),
          ]);
          await eagerCleanupAndUnmark(prefix);
        }),
      ),
      Effect.mapBoth({
        onSuccess: () => c.body(null, 204),
        onFailure: (err) => c.var.eitherJson(leftErr(err)),
      }),
      Effect.merge,
      Effect.runPromise,
    ),
  )

  .patch(
    "/:id/track-order",
    vValidator("param", idParamSchema),
    vValidator("json", reorderTracksSchema),
    (c) => {
      const { tracks: newOrder } = c.req.valid("json");
      // withSlotRetry が P2002/P2034 throw を retry。validation 失敗の Left は
      // txEither 内で rollback してから上に伝わるので retry 対象外
      return pipe(
        requireProject(c.var.user.id, c.req.valid("param").id),
        Effect.flatMap((project) =>
          pipe(
            Effect.promise(() =>
              withSlotRetry(() =>
                Effect.runPromise(
                  Effect.either(
                    txEither((tx) =>
                      Effect.gen(function* () {
                        yield* Effect.promise(() =>
                          tx.project.update({
                            where: { id: project.id },
                            data: { updatedAt: new Date() },
                          }),
                        );
                        const [videos, audios] = yield* Effect.promise(() =>
                          Promise.all([
                            tx.video.findMany({
                              where: { projectId: project.id },
                              select: { id: true, projStartSec: true, projEndSec: true },
                            }),
                            tx.audio.findMany({
                              where: { projectId: project.id },
                              select: { id: true, projStartSec: true, projEndSec: true },
                            }),
                          ]),
                        );
                        const expected = videos.length + audios.length;
                        if (newOrder.length !== expected) {
                          return yield* leftErr({
                            status: 400,
                            error: "track-order: length mismatch",
                          });
                        }
                        const videoMap = new Map(videos.map((row) => [row.id, row]));
                        const audioMap = new Map(audios.map((row) => [row.id, row]));
                        const seen = new Set<string>();
                        for (const t of newOrder) {
                          const exists =
                            t.kind === "video" ? videoMap.has(t.id) : audioMap.has(t.id);
                          if (!exists) {
                            return yield* leftErr({
                              status: 400,
                              error: `track-order: unknown ${t.kind} id ${t.id}`,
                            });
                          }
                          const key = `${t.kind}:${t.id}`;
                          if (seen.has(key)) {
                            return yield* leftErr({
                              status: 400,
                              error: `track-order: duplicate ${t.kind} id ${t.id}`,
                            });
                          }
                          seen.add(key);
                        }
                        // reorder は timing を動かさないが、既存合計が cap 内である不変条件は保証する
                        const totalAbsDur =
                          videos.reduce((s, r) => s + Math.abs(r.projEndSec - r.projStartSec), 0) +
                          audios.reduce((s, r) => s + Math.abs(r.projEndSec - r.projStartSec), 0);
                        if (totalAbsDur > MAX_PROJECT_TIMING_SEC) {
                          return yield* leftErr({
                            status: 400,
                            error: `track-order: total duration ${totalAbsDur} exceeds ${MAX_PROJECT_TIMING_SEC}`,
                          });
                        }
                        for (const [i, t] of newOrder.entries()) {
                          const data = { order: -(i + 1) };
                          if (t.kind === "video")
                            yield* Effect.promise(() =>
                              tx.video.update({ where: { id: t.id }, data }),
                            );
                          else
                            yield* Effect.promise(() =>
                              tx.audio.update({ where: { id: t.id }, data }),
                            );
                        }
                        // ↑↓ は project 内の並び順だけを変える。timing (時間軸上の
                        // 位置) は動かさないので projStart/End は据え置く
                        for (const [i, t] of newOrder.entries()) {
                          const data = { order: i };
                          if (t.kind === "video")
                            yield* Effect.promise(() =>
                              tx.video.update({ where: { id: t.id }, data }),
                            );
                          else
                            yield* Effect.promise(() =>
                              tx.audio.update({ where: { id: t.id }, data }),
                            );
                        }
                      }),
                    ),
                  ),
                ),
              ),
            ),
            Effect.flatMap((r) => r),
            Effect.flatMap(() => requireProjectDetail(c.var.user.id, project.id)),
          ),
        ),
        Effect.map((updated): { project: ApiProjectDetail } => ({
          project: toApiProjectDetail(updated),
        })),
        Effect.either,
        Effect.map((r) => c.var.eitherJson(r)),
        Effect.runPromise,
      );
    },
  )

  .post(
    "/:id/uploads",
    vValidator("param", idParamSchema),
    vValidator("json", createUploadSchema),
    (c) => {
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
      return pipe(
        requireProject(c.var.user.id, c.req.valid("param").id),
        Effect.flatMap((project) =>
          Effect.promise(async () => {
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
            return upload;
          }),
        ),
        Effect.mapBoth({
          onSuccess: (upload) => c.json({ upload: toApiUpload(upload) satisfies ApiUpload }, 201),
          onFailure: (err) => c.var.eitherJson(leftErr(err)),
        }),
        Effect.merge,
        Effect.runPromise,
      );
    },
  )

  .put(
    "/:id/uploads/:uploadId/chunks/:index",
    vValidator("param", uploadChunkParamSchema),
    async (c) => {
      const user = c.var.user;
      const { id, uploadId, index: indexStr } = c.req.valid("param");
      const projectR = await Effect.runPromise(Effect.either(requireProject(user.id, id)));
      if (Either.isLeft(projectR)) return c.var.eitherJson(projectR);
      const project = projectR.right;
      const uploadR = await Effect.runPromise(
        Effect.either(requirePendingUpload(uploadId, project.id)),
      );
      if (Either.isLeft(uploadR)) return c.var.eitherJson(uploadR);
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
      // skill: prisma-claim-first。chunk の read/delta は claim 後でないと
      // 並行 PUT が同じ古い sizeBytes を基に delta を計算し receivedBytes が ずれる。
      // stale を throw で表すと外側で新規 S3 を掃除できないので戻り値で表す
      const promoteResult = await prisma.$transaction(async (tx) => {
        const claimed = await tx.upload.updateMany({
          where: {
            id: upload.id,
            status: "pending",
            expiresAt: { gt: new Date() },
          },
          data: { updatedAt: new Date() },
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
        const existing = await tx.uploadChunk.findUnique({
          where: { uploadId_index: { uploadId: upload.id, index } },
        });
        const delta = existing ? BigInt(size) - existing.sizeBytes : BigInt(size);
        await tx.upload.update({
          where: { id: upload.id },
          data: { receivedBytes: { increment: delta } },
        });
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

  .post("/:id/uploads/:uploadId/complete", vValidator("param", uploadIdParamSchema), (c) => {
    const { id, uploadId } = c.req.valid("param");
    // skill: prisma-claim-first。completed なら冪等返却、validate 失敗は txEither が rollback
    return pipe(
      requireProject(c.var.user.id, id),
      Effect.flatMap((project) =>
        txEither((tx) =>
          Effect.gen(function* () {
            const claimed = yield* Effect.promise(() =>
              tx.upload.updateMany({
                where: {
                  id: uploadId,
                  projectId: project.id,
                  status: "pending",
                  expiresAt: { gt: new Date() },
                },
                data: { status: "completed" },
              }),
            );
            if (claimed.count === 0) {
              const upload = yield* requireUpload(tx, uploadId, project.id);
              if (upload.status === "completed") {
                // 冪等: 既存 task を返す (Task.id === Upload.id)
                const existing = yield* Effect.promise(() =>
                  tx.task.findUnique({ where: { id: upload.id } }),
                );
                if (!existing) {
                  return yield* leftErr({ status: 500, error: "completed upload has no task" });
                }
                return { task: toApiTask(existing), enqueue: false };
              }
              yield* checkUploadPending(upload);
              return yield* leftErr({
                status: 500,
                error: "unreachable: claim failed but upload is pending",
              });
            }
            // claim 済み行を read。write lock を握っているので並行 read+write しない
            const upload = yield* Effect.promise(() =>
              tx.upload.findUniqueOrThrow({ where: { id: uploadId } }),
            );
            const chunks = yield* Effect.promise(() =>
              tx.uploadChunk.findMany({
                where: { uploadId: upload.id },
                select: { index: true, sizeBytes: true },
              }),
            );
            if (chunks.length !== upload.totalChunks) {
              return yield* leftErr({
                status: 400,
                error: `missing chunks: received ${chunks.length}/${upload.totalChunks}`,
              });
            }
            const seen = new Set(chunks.map((chunk) => chunk.index));
            for (let i = 0; i < upload.totalChunks; i++) {
              if (!seen.has(i)) return yield* leftErr({ status: 400, error: `missing chunk ${i}` });
            }
            const sum = chunks.reduce((acc, chunk) => acc + chunk.sizeBytes, 0n);
            if (sum !== upload.totalBytes) {
              return yield* leftErr({
                status: 400,
                error: `byte total mismatch: received ${sum}, declared ${upload.totalBytes}`,
              });
            }
            const task = yield* Effect.promise(() =>
              tx.task.create({
                data: {
                  id: upload.id,
                  projectId: project.id,
                  type: upload.kind === "video" ? "video_validation" : "audio_validation",
                  fileName: upload.fileName,
                  status: "pending",
                },
              }),
            );
            // task 走行中の sweep を防ぐ。完了時 executeTask が mark ごと回収
            yield* Effect.promise(() =>
              tx.deletionMark.updateMany({
                where: { prefix: uploadPrefix(project.id, upload.id) },
                data: { nextRetryAt: new Date(Date.now() + TASK_GRACE_MS) },
              }),
            );
            return { task: toApiTask(task), enqueue: true };
          }),
        ),
      ),
      Effect.map(({ task, enqueue }): { task: ApiTask } => {
        if (enqueue) enqueueTask(task.id);
        return { task };
      }),
      Effect.either,
      Effect.map((r) => c.var.eitherJson(r)),
      Effect.runPromise,
    );
  })

  // pending な upload の自発キャンセル用。completed 後は task が chunks を必要とするので拒否
  .delete("/:id/uploads/:uploadId", vValidator("param", uploadIdParamSchema), (c) => {
    const { id, uploadId } = c.req.valid("param");
    // claim-first で pending → aborted に遷移 (skill: prisma-claim-first)。
    // 期限切れ pending も abort 対象なので expiresAt 条件は付けない
    return pipe(
      requireProject(c.var.user.id, id),
      Effect.flatMap((project) =>
        pipe(
          txEither((tx) =>
            Effect.gen(function* () {
              const claimed = yield* Effect.promise(() =>
                tx.upload.updateMany({
                  where: { id: uploadId, projectId: project.id, status: "pending" },
                  data: { status: "aborted" },
                }),
              );
              if (claimed.count === 0) {
                const upload = yield* requireUpload(tx, uploadId, project.id);
                return yield* leftErr({
                  status: 409,
                  error: `cannot abort: upload is ${upload.status}`,
                });
              }
              yield* Effect.promise(() => tx.uploadChunk.deleteMany({ where: { uploadId } }));
            }),
          ),
          Effect.flatMap(() =>
            Effect.promise(() => eagerCleanupAndUnmark(uploadPrefix(project.id, uploadId))),
          ),
        ),
      ),
      Effect.mapBoth({
        onSuccess: () => c.body(null, 204),
        onFailure: (err) => c.var.eitherJson(leftErr(err)),
      }),
      Effect.merge,
      Effect.runPromise,
    );
  })

  .get("/:id/tasks", vValidator("param", idParamSchema), (c) =>
    pipe(
      requireProject(c.var.user.id, c.req.valid("param").id),
      Effect.flatMap((project) =>
        Effect.promise(() =>
          prisma.task.findMany({
            where: { projectId: project.id },
            orderBy: { createdAt: "desc" },
          }),
        ),
      ),
      Effect.map((tasks) => ({ tasks: tasks.map(toApiTask) satisfies ApiTask[] })),
      Effect.either,
      Effect.map((r) => c.var.eitherJson(r)),
      Effect.runPromise,
    ),
  )

  .get("/:id/tasks/:taskId", vValidator("param", taskIdParamSchema), (c) => {
    const { id, taskId } = c.req.valid("param");
    return pipe(
      requireProject(c.var.user.id, id),
      Effect.flatMap((project) =>
        Effect.promise(() =>
          prisma.task.findFirst({ where: { id: taskId, projectId: project.id } }),
        ),
      ),
      Effect.flatMap(found({ status: 404, error: "task not found" })),
      Effect.map((task) => ({ task: toApiTask(task) satisfies ApiTask })),
      Effect.either,
      Effect.map((r) => c.var.eitherJson(r)),
      Effect.runPromise,
    );
  })

  // failed task の dismiss。expireAt を now に倒すと UI から消え、sweeper が同 id の Upload も回収
  .post("/:id/tasks/:taskId/dismiss", vValidator("param", taskIdParamSchema), (c) => {
    const { id, taskId } = c.req.valid("param");
    return pipe(
      requireProject(c.var.user.id, id),
      Effect.flatMap((project) =>
        Effect.promise(() =>
          prisma.task.updateMany({
            where: { id: taskId, projectId: project.id, status: "failed" },
            data: { expireAt: new Date() },
          }),
        ),
      ),
      Effect.flatMap((res) =>
        res.count === 0
          ? leftErr({ status: 404, error: "failed task not found" })
          : Either.right(null),
      ),
      Effect.mapBoth({
        onSuccess: () => c.body(null, 204),
        onFailure: (err) => c.var.eitherJson(leftErr(err)),
      }),
      Effect.merge,
      Effect.runPromise,
    );
  })

  .delete("/:id/videos/:videoId", vValidator("param", videoIdParamSchema), (c) => {
    const { id, videoId } = c.req.valid("param");
    return pipe(
      requireProject(c.var.user.id, id),
      Effect.flatMap((project) =>
        pipe(
          requireVideo(project.id, videoId),
          Effect.flatMap((video) =>
            Effect.promise(async () => {
              const prefix = videoPrefix(project.id, video.id);
              await prisma.$transaction([
                prisma.deletionMark.create({ data: { prefix } }),
                prisma.thumbnail.deleteMany({ where: { videoId: video.id } }),
                prisma.video.delete({ where: { id: video.id } }),
              ]);
              await eagerCleanupAndUnmark(prefix);
            }),
          ),
        ),
      ),
      Effect.mapBoth({
        onSuccess: () => c.body(null, 204),
        onFailure: (err) => c.var.eitherJson(leftErr(err)),
      }),
      Effect.merge,
      Effect.runPromise,
    );
  })

  .patch(
    "/:id/videos/:videoId/timing",
    vValidator("param", videoIdParamSchema),
    vValidator("json", timingSchema),
    (c) => {
      const { id, videoId } = c.req.valid("param");
      const body = c.req.valid("json");
      return pipe(
        requireProject(c.var.user.id, id),
        Effect.flatMap((project) =>
          pipe(
            // task-runner.allocSlot と同じ project-row lock を取り、新規 upload の
            // slot 計算と timing 変更が interleave しないよう serialize する
            Effect.promise(() =>
              withSlotRetry(() =>
                Effect.runPromise(
                  Effect.either(
                    txEither((tx) =>
                      Effect.gen(function* () {
                        yield* Effect.promise(() =>
                          tx.project.update({
                            where: { id: project.id },
                            data: { updatedAt: new Date() },
                          }),
                        );
                        // durationSec 制約を where に畳んで claim-first で原子更新
                        const claimed = yield* Effect.promise(() =>
                          tx.video.updateMany({
                            where: {
                              id: videoId,
                              projectId: project.id,
                              durationSec: { gte: body.srcEndSec },
                            },
                            data: {
                              srcStartSec: body.srcStartSec,
                              srcEndSec: body.srcEndSec,
                              projStartSec: body.projStartSec,
                              projEndSec: body.projEndSec,
                            },
                          }),
                        );
                        if (claimed.count === 0) {
                          const video = yield* Effect.promise(() =>
                            tx.video.findFirst({
                              where: { id: videoId, projectId: project.id },
                              select: { durationSec: true },
                            }),
                          );
                          if (video === null) {
                            return yield* leftErr({ status: 404, error: "video not found" });
                          }
                          return yield* leftErr({
                            status: 400,
                            error: `srcEndSec must be <= durationSec (${video.durationSec})`,
                          });
                        }
                        return yield* Effect.promise(() =>
                          tx.video.findUniqueOrThrow({
                            where: { id: videoId },
                            include: { thumbnails: { orderBy: { atSec: "asc" } } },
                          }),
                        );
                      }),
                    ),
                  ),
                ),
              ),
            ),
            Effect.flatMap((r) => r),
          ),
        ),
        Effect.map((video): { video: ApiVideo } => ({ video: toApiVideo(video) })),
        Effect.either,
        Effect.map((r) => c.var.eitherJson(r)),
        Effect.runPromise,
      );
    },
  )

  .get("/:id/videos/:videoId/stream", vValidator("param", videoIdParamSchema), (c) => {
    const { id, videoId } = c.req.valid("param");
    return pipe(
      requireProject(c.var.user.id, id),
      Effect.flatMap((project) => requireVideo(project.id, videoId)),
      Effect.either,
      Effect.flatMap((r) =>
        Either.isLeft(r)
          ? Effect.sync(() => c.var.eitherJson(r))
          : Effect.promise(() => streamS3(c, r.right.videoKey, "video/mp4")),
      ),
      Effect.runPromise,
    );
  })

  .get("/:id/videos/:videoId/audio", vValidator("param", videoIdParamSchema), (c) => {
    const { id, videoId } = c.req.valid("param");
    return pipe(
      requireProject(c.var.user.id, id),
      Effect.flatMap((project) => requireVideo(project.id, videoId)),
      Effect.flatMap((video) =>
        video.audioKey === null
          ? leftErr({ status: 404, error: "video has no audio" })
          : Either.right({ ...video, audioKey: video.audioKey }),
      ),
      Effect.either,
      Effect.flatMap((r) =>
        Either.isLeft(r)
          ? Effect.sync(() => c.var.eitherJson(r))
          : Effect.promise(() => streamS3(c, r.right.audioKey, "audio/mp4")),
      ),
      Effect.runPromise,
    );
  })

  .get("/:id/videos/:videoId/thumbnails/:thumbId", vValidator("param", thumbIdParamSchema), (c) => {
    const { id, thumbId } = c.req.valid("param");
    return pipe(
      requireProject(c.var.user.id, id),
      Effect.flatMap((project) => requireThumbnail(project.id, thumbId)),
      Effect.either,
      Effect.flatMap((r) =>
        Either.isLeft(r)
          ? Effect.sync(() => c.var.eitherJson(r))
          : Effect.promise(() => streamS3(c, r.right.key, "image/jpeg")),
      ),
      Effect.runPromise,
    );
  })

  .delete("/:id/audios/:audioId", vValidator("param", audioIdParamSchema), (c) => {
    const { id, audioId } = c.req.valid("param");
    return pipe(
      requireProject(c.var.user.id, id),
      Effect.flatMap((project) =>
        pipe(
          requireAudio(project.id, audioId),
          Effect.flatMap((audio) =>
            Effect.promise(async () => {
              const prefix = audioPrefix(project.id, audio.id);
              await prisma.$transaction([
                prisma.deletionMark.create({ data: { prefix } }),
                prisma.task.deleteMany({ where: { audioId: audio.id, type: "cqt_spectrogram" } }),
                prisma.spectrogram.deleteMany({ where: { audioId: audio.id } }),
                prisma.audio.delete({ where: { id: audio.id } }),
              ]);
              await eagerCleanupAndUnmark(prefix);
            }),
          ),
        ),
      ),
      Effect.mapBoth({
        onSuccess: () => c.body(null, 204),
        onFailure: (err) => c.var.eitherJson(leftErr(err)),
      }),
      Effect.merge,
      Effect.runPromise,
    );
  })

  .patch(
    "/:id/audios/:audioId/timing",
    vValidator("param", audioIdParamSchema),
    vValidator("json", timingSchema),
    (c) => {
      const { id, audioId } = c.req.valid("param");
      const body = c.req.valid("json");
      return pipe(
        requireProject(c.var.user.id, id),
        Effect.flatMap((project) =>
          pipe(
            // task-runner.allocSlot と同じ project-row lock を取り、新規 upload の
            // slot 計算と timing 変更が interleave しないよう serialize する
            Effect.promise(() =>
              withSlotRetry(() =>
                Effect.runPromise(
                  Effect.either(
                    txEither((tx) =>
                      Effect.gen(function* () {
                        yield* Effect.promise(() =>
                          tx.project.update({
                            where: { id: project.id },
                            data: { updatedAt: new Date() },
                          }),
                        );
                        // durationSec 制約を where に畳んで claim-first で原子更新
                        const claimed = yield* Effect.promise(() =>
                          tx.audio.updateMany({
                            where: {
                              id: audioId,
                              projectId: project.id,
                              durationSec: { gte: body.srcEndSec },
                            },
                            data: {
                              srcStartSec: body.srcStartSec,
                              srcEndSec: body.srcEndSec,
                              projStartSec: body.projStartSec,
                              projEndSec: body.projEndSec,
                            },
                          }),
                        );
                        if (claimed.count === 0) {
                          const audio = yield* Effect.promise(() =>
                            tx.audio.findFirst({
                              where: { id: audioId, projectId: project.id },
                              select: { durationSec: true },
                            }),
                          );
                          if (audio === null) {
                            return yield* leftErr({ status: 404, error: "audio not found" });
                          }
                          return yield* leftErr({
                            status: 400,
                            error: `srcEndSec must be <= durationSec (${audio.durationSec})`,
                          });
                        }
                        return yield* Effect.promise(() =>
                          tx.audio.findUniqueOrThrow({
                            where: { id: audioId },
                            include: { spectrograms: { orderBy: { createdAt: "asc" } } },
                          }),
                        );
                      }),
                    ),
                  ),
                ),
              ),
            ),
            Effect.flatMap((r) => r),
          ),
        ),
        Effect.map((audio): { audio: ApiAudio } => ({ audio: toApiAudio(audio) })),
        Effect.either,
        Effect.map((r) => c.var.eitherJson(r)),
        Effect.runPromise,
      );
    },
  )

  .get("/:id/audios/:audioId/stream", vValidator("param", audioIdParamSchema), (c) => {
    const { id, audioId } = c.req.valid("param");
    return pipe(
      requireProject(c.var.user.id, id),
      Effect.flatMap((project) => requireAudio(project.id, audioId)),
      Effect.either,
      Effect.flatMap((r) =>
        Either.isLeft(r)
          ? Effect.sync(() => c.var.eitherJson(r))
          : Effect.promise(() => streamS3(c, r.right.audioKey, "audio/mp4")),
      ),
      Effect.runPromise,
    );
  })

  .get("/:id/audios/:audioId/raw", vValidator("param", audioIdParamSchema), (c) => {
    const { id, audioId } = c.req.valid("param");
    return pipe(
      requireProject(c.var.user.id, id),
      Effect.flatMap((project) => requireAudio(project.id, audioId)),
      Effect.flatMap((audio) =>
        audio.rawKey === null
          ? leftErr({ status: 404, error: "audio has no raw file" })
          : Either.right({ ...audio, rawKey: audio.rawKey }),
      ),
      Effect.either,
      Effect.flatMap((r) =>
        Either.isLeft(r)
          ? Effect.sync(() => c.var.eitherJson(r))
          : Effect.promise(() =>
              streamS3(c, r.right.rawKey, r.right.rawContentType ?? "application/octet-stream"),
            ),
      ),
      Effect.runPromise,
    );
  })

  .get("/:id/audios/:audioId/spectrograms", vValidator("param", audioIdParamSchema), (c) => {
    const { id, audioId } = c.req.valid("param");
    return pipe(
      requireProject(c.var.user.id, id),
      Effect.flatMap((project) => requireAudio(project.id, audioId)),
      Effect.flatMap((audio) =>
        Effect.promise(() =>
          prisma.spectrogram.findMany({
            where: { audioId: audio.id },
            orderBy: { createdAt: "asc" },
          }),
        ),
      ),
      Effect.map((specs) => ({
        spectrograms: specs.map((s) => toApiSpectrogram(id, s)) satisfies ApiSpectrogram[],
      })),
      Effect.either,
      Effect.map((r) => c.var.eitherJson(r)),
      Effect.runPromise,
    );
  })

  .post(
    "/:id/audios/:audioId/spectrograms",
    vValidator("param", audioIdParamSchema),
    vValidator("json", createSpectrogramSchema),
    (c) => {
      const { id, audioId } = c.req.valid("param");
      const body = c.req.valid("json");
      return pipe(
        requireProject(c.var.user.id, id),
        Effect.flatMap((project) => requireAudio(project.id, audioId)),
        Effect.flatMap((audio) =>
          Effect.promise(async () => {
            // Spectrogram.id === Task.id (Upload と同じ共有 id パターン)
            const specId = crypto.randomUUID();
            const [spec, task] = await prisma.$transaction([
              prisma.spectrogram.create({
                data: {
                  id: specId,
                  audioId: audio.id,
                  binsPerOctave: body.binsPerOctave,
                  octaves: body.octaves,
                  fminHz: body.fminHz,
                  harmonics: JSON.stringify(body.harmonics.toSorted((a, b) => a - b)),
                },
              }),
              prisma.task.create({
                data: {
                  id: specId,
                  projectId: audio.projectId,
                  type: "cqt_spectrogram",
                  fileName: audio.name,
                  audioId: audio.id,
                  status: "pending",
                },
              }),
            ]);
            enqueueTask(task.id);
            return { spectrogram: toApiSpectrogram(audio.projectId, spec), task: toApiTask(task) };
          }),
        ),
        Effect.mapBoth({
          onSuccess: (r) => c.json(r satisfies { spectrogram: ApiSpectrogram; task: ApiTask }, 201),
          onFailure: (err) => c.var.eitherJson(leftErr(err)),
        }),
        Effect.merge,
        Effect.runPromise,
      );
    },
  )

  // pending (task 走行中) は拒否。terminal のみ claim-first で削除し S3 は mark + eager 掃除
  .delete(
    "/:id/audios/:audioId/spectrograms/:specId",
    vValidator("param", spectrogramIdParamSchema),
    (c) => {
      const { id, audioId, specId } = c.req.valid("param");
      return pipe(
        requireProject(c.var.user.id, id),
        Effect.flatMap((project) =>
          pipe(
            requireAudio(project.id, audioId),
            Effect.flatMap((audio) =>
              pipe(
                txEither((tx) =>
                  Effect.gen(function* () {
                    const deleted = yield* Effect.promise(() =>
                      tx.spectrogram.deleteMany({
                        where: {
                          id: specId,
                          audioId: audio.id,
                          status: { in: ["ready", "failed"] },
                        },
                      }),
                    );
                    if (deleted.count === 0) {
                      const spec = yield* requireSpectrogram(audio.id, specId);
                      return yield* leftErr({
                        status: 409,
                        error: `cannot delete: spectrogram is ${spec.status}`,
                      });
                    }
                    yield* Effect.promise(() => tx.task.deleteMany({ where: { id: specId } }));
                    yield* Effect.promise(() =>
                      tx.deletionMark.create({
                        data: { prefix: spectrogramPrefix(project.id, audio.id, specId) },
                      }),
                    );
                  }),
                ),
                Effect.flatMap(() =>
                  Effect.promise(() =>
                    eagerCleanupAndUnmark(spectrogramPrefix(project.id, audio.id, specId)),
                  ),
                ),
              ),
            ),
          ),
        ),
        Effect.mapBoth({
          onSuccess: () => c.body(null, 204),
          onFailure: (err) => c.var.eitherJson(leftErr(err)),
        }),
        Effect.merge,
        Effect.runPromise,
      );
    },
  )

  .get(
    "/:id/audios/:audioId/spectrograms/:specId/meta",
    vValidator("param", spectrogramIdParamSchema),
    (c) => {
      const { id, audioId, specId } = c.req.valid("param");
      return pipe(
        requireProject(c.var.user.id, id),
        Effect.flatMap((project) => requireAudio(project.id, audioId)),
        Effect.flatMap((audio) => requireReadySpectrogram(audio.id, specId)),
        Effect.either,
        Effect.flatMap((r) =>
          Either.isLeft(r)
            ? Effect.sync(() => c.var.eitherJson(r))
            : Effect.promise(async () => {
                const res = await streamS3(
                  c,
                  spectrogramMetaKey(id, audioId, specId),
                  "application/json",
                );
                res.headers.set("cache-control", "private, max-age=31536000, immutable");
                return res;
              }),
        ),
        Effect.runPromise,
      );
    },
  )

  .get(
    "/:id/audios/:audioId/spectrograms/:specId/tiles/:harmonic/:level/:index",
    vValidator("param", spectrogramTileParamSchema),
    (c) => {
      const { id, audioId, specId, harmonic, level, index } = c.req.valid("param");
      const h = Number(harmonic);
      const lv = Number(level);
      const idx = Number(index);
      if (
        !Number.isInteger(h) ||
        h < 1 ||
        !Number.isInteger(lv) ||
        lv < 0 ||
        !Number.isInteger(idx) ||
        idx < 0
      ) {
        return c.json({ error: "harmonic/level/index must be non-negative integers" }, 400);
      }
      return pipe(
        requireProject(c.var.user.id, id),
        Effect.flatMap((project) => requireAudio(project.id, audioId)),
        Effect.flatMap((audio) => requireReadySpectrogram(audio.id, specId)),
        Effect.flatMap((spec) =>
          parseHarmonics(spec.harmonics).includes(h)
            ? Either.right(spec)
            : leftErr({ status: 404, error: `harmonic ${h} not in spectrogram` }),
        ),
        Effect.either,
        Effect.flatMap((r) =>
          Either.isLeft(r)
            ? Effect.sync(() => c.var.eitherJson(r))
            : Effect.promise(async () => {
                const res = await streamS3(
                  c,
                  spectrogramTileKey(id, audioId, specId, h, lv, idx),
                  "application/octet-stream",
                );
                res.headers.set("cache-control", "private, max-age=31536000, immutable");
                return res;
              }),
        ),
        Effect.runPromise,
      );
    },
  );

export type ProjectsAppType = typeof projects;
