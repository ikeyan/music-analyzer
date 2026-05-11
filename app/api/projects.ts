import { vValidator } from "@hono/valibot-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { extname, join } from "node:path";
import * as v from "valibot";
import { type AuthContext, requireUser } from "../lib/auth";
import {
  MAX_DURATION_SEC,
  MAX_UPLOAD_BYTES,
  extractAudio,
  extractThumbnails,
  ffprobe,
  isBrowserPlayableAudio,
  transcodeAudio,
  transcodeVideo,
} from "../lib/ffmpeg";
import { prisma } from "../lib/prisma";
import { awaitAllOrAggregate } from "../lib/promise";
import { tempDir } from "../lib/temp-dir";
import {
  audioRawKey,
  audioTranscodedKey,
  deletePrefix,
  projectKey,
  streamS3,
  uploadFile,
  videoAudioKey,
  videoSourceKey,
  videoThumbKey,
} from "../lib/storage";
import {
  type ApiAudio,
  type ApiProject,
  type ApiProjectDetail,
  type ApiProjectSummary,
  type ApiVideo,
  toApiAudio,
  toApiProject,
  toApiProjectDetail,
  toApiProjectSummary,
  toApiVideo,
} from "./types";

// multipart envelope (boundary / Content-Disposition / filename) で数百〜数KBの
// overhead が乗るので Content-Length 早期チェックは余裕を持たせる
const MULTIPART_OVERHEAD_SLACK = 64 * 1024;

const idParamSchema = v.object({ id: v.string() });
const videoIdParamSchema = v.object({ id: v.string(), videoId: v.string() });
const audioIdParamSchema = v.object({ id: v.string(), audioId: v.string() });
const thumbIdParamSchema = v.object({ id: v.string(), videoId: v.string(), thumbId: v.string() });
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

async function findProjectOr404(userId: string, projectId: string) {
  const p = await prisma.project.findFirst({ where: { id: projectId, userId } });
  return p;
}

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// project 行への update で SQLite write lock を先取りし、同一 project への並行 alloc を直列化する
// (table 別 unique では video/audio cross-table race を検出できない)
async function allocSlot(
  tx: TxClient,
  projectId: string,
): Promise<{ order: number; projStart: number }> {
  await tx.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
  const [vOrder, aOrder, vEnd, aEnd] = await Promise.all([
    tx.video.findFirst({
      where: { projectId },
      orderBy: { order: "desc" },
      select: { order: true },
    }),
    tx.audio.findFirst({
      where: { projectId },
      orderBy: { order: "desc" },
      select: { order: true },
    }),
    tx.video.findFirst({
      where: { projectId },
      orderBy: { projEndSec: "desc" },
      select: { projEndSec: true },
    }),
    tx.audio.findFirst({
      where: { projectId },
      orderBy: { projEndSec: "desc" },
      select: { projEndSec: true },
    }),
  ]);
  return {
    order: Math.max(vOrder?.order ?? -1, aOrder?.order ?? -1) + 1,
    projStart: Math.max(vEnd?.projEndSec ?? 0, aEnd?.projEndSec ?? 0),
  };
}

// 1h 動画の transcode + upload に十分余裕のある grace
const UPLOAD_GRACE_MS = 4 * 60 * 60 * 1000;

// upload 完了前に死んだら sweeper が grace 後に拾うので S3 に orphan が残らない
async function markPrefixForDeletion(prefix: string, graceMs = 0): Promise<void> {
  await prisma.deletionMark.create({
    data: { prefix, nextRetryAt: new Date(Date.now() + graceMs) },
  });
}

// 失敗しても sweeper が mark を拾うので throw しない
async function eagerCleanupAndUnmark(prefix: string): Promise<void> {
  try {
    await deletePrefix(prefix);
    await prisma.deletionMark.deleteMany({ where: { prefix } });
  } catch {
    /* sweeperに任せる */
  }
}

// (projectId, order) unique衝突 (P2002) と SQLite write conflict (P2034) を保険でリトライする
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
      await tx.thumbnail.deleteMany({ where: { video: { projectId: project.id } } });
      await tx.video.deleteMany({ where: { projectId: project.id } });
      await tx.audio.deleteMany({ where: { projectId: project.id } });
      await tx.project.delete({ where: { id: project.id } });
    });
    await eagerCleanupAndUnmark(prefix);
    return c.body(null, 204);
  })

  // 全 track の並び順を一括更新する。video / audio 横断で order が unique なので
  // 中間状態で衝突しないよう負の offset に一旦逃がしてから本来の order に書き戻し、
  // 同時に projStartSec / projEndSec を新しい順に back-to-back で再配置する
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
          // 同じ {kind,id} を複数回含めると重複 update + 抜けが発生して order が
          // 壊れるので、長さが一致していても永続 set で permutation か検証する
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
          // Phase 1: 既存 row を一時的に負の order に逃がして unique 衝突を回避
          for (const [i, t] of newOrder.entries()) {
            const data = { order: -(i + 1) };
            if (t.kind === "video") await tx.video.update({ where: { id: t.id }, data });
            else await tx.audio.update({ where: { id: t.id }, data });
          }
          // Phase 2: 本来の order と back-to-back な projStart/End を書き込む
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

  .post("/:id/videos", vValidator("param", idParamSchema), async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.valid("param").id);
    if (!project) return c.json({ error: "project not found" }, 404);

    // Content-Length で fast-fail。client は嘘をつけるので parse 後の file.size でも再チェックする
    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_SLACK) {
      return c.json(
        { error: `file too large (max ${MAX_UPLOAD_BYTES} bytes, declared content-length)` },
        413,
      );
    }

    let form;
    try {
      form = await c.req.raw.formData();
    } catch {
      return c.json({ error: "invalid multipart body" }, 400);
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return c.json({ error: "file required" }, 400);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json(
        { error: `file too large (max ${MAX_UPLOAD_BYTES} bytes, parsed file.size)` },
        413,
      );
    }
    const nameField = form.get("name");
    const name = (typeof nameField === "string" ? nameField.trim() : "") || file.name || "video";

    const videoId = crypto.randomUUID();
    const prefix = `${projectKey(project.id)}/videos/${videoId}/`;
    await markPrefixForDeletion(prefix, UPLOAD_GRACE_MS);

    let result;
    try {
      result = await (async () => {
        await using td = await tempDir("video-upload");
        const tmp = td.path;
        const inputPath = join(tmp, "input" + (extname(file.name) || ".bin"));
        await Bun.write(inputPath, file);

        let probe;
        try {
          probe = await ffprobe(inputPath);
        } catch {
          return { error: "could not parse uploaded file", status: 400 as const };
        }
        if (!probe.videoStream) {
          return { error: "no video stream", status: 400 as const };
        }
        if (
          !Number.isFinite(probe.durationSec) ||
          probe.durationSec <= 0 ||
          probe.durationSec > MAX_DURATION_SEC
        ) {
          return {
            error: `duration must be > 0 and <= ${MAX_DURATION_SEC}s (input probe)`,
            status: 400 as const,
          };
        }

        const hasAudio = probe.audioStream !== null;
        const videoOut = join(tmp, "video.mp4");
        const audioOut = join(tmp, "audio.m4a");
        const thumbDir = join(tmp, "thumbs");
        // 片方の reject で他方も abort し CPU/disk を解放
        const ac = new AbortController();
        const tasks: Promise<unknown>[] = [
          transcodeVideo(inputPath, videoOut, hasAudio, ac.signal),
        ];
        if (hasAudio) tasks.push(extractAudio(inputPath, audioOut, ac.signal));
        try {
          await Promise.all(tasks);
        } catch {
          ac.abort();
          // 残った ffmpeg を抱えたまま return しないよう settle 待ち
          await Promise.allSettled(tasks);
          return { error: "ffmpeg cannot decode this video", status: 400 as const };
        }

        const finalProbe = await ffprobe(videoOut);
        const vs = finalProbe.videoStream;
        if (!vs) return { error: "transcode produced no video stream", status: 500 as const };
        if (!Number.isFinite(finalProbe.durationSec) || finalProbe.durationSec <= 0) {
          return { error: "transcode produced unknown duration", status: 500 as const };
        }
        // pre-probe で過小報告された壊れた入力に備えて再判定
        if (finalProbe.durationSec > MAX_DURATION_SEC) {
          return {
            error: `duration must be > 0 and <= ${MAX_DURATION_SEC}s (transcoded probe)`,
            status: 400 as const,
          };
        }

        const thumbs = await extractThumbnails(
          videoOut,
          thumbDir,
          finalProbe.durationSec,
          vs.width,
          vs.height,
        );

        const vKey = videoSourceKey(project.id, videoId);
        const aKey = hasAudio ? videoAudioKey(project.id, videoId) : null;

        // 全 upload が settle してから throw しないと cleanup が遅延 upload 完了の orphan を逃す
        await awaitAllOrAggregate([
          uploadFile(vKey, videoOut, "video/mp4"),
          ...(aKey ? [uploadFile(aKey, audioOut, "audio/mp4")] : []),
          ...thumbs.map((t) =>
            uploadFile(videoThumbKey(project.id, videoId, t.atSec), t.path, "image/jpeg"),
          ),
        ]);

        const duration = finalProbe.durationSec;
        const row = await withSlotRetry(() =>
          prisma.$transaction(async (tx) => {
            const { order, projStart } = await allocSlot(tx, project.id);
            const created = await tx.video.create({
              data: {
                id: videoId,
                projectId: project.id,
                order,
                name,
                videoKey: vKey,
                audioKey: aKey,
                durationSec: duration,
                width: vs.width,
                height: vs.height,
                fps: vs.fps,
                videoBitrate: vs.bitrate,
                audioBitrate: finalProbe.audioStream?.bitrate ?? null,
                sizeBytes: BigInt(finalProbe.sizeBytes),
                srcStartSec: 0,
                srcEndSec: duration,
                projStartSec: projStart,
                projEndSec: projStart + duration,
                thumbnails: {
                  create: thumbs.map((t) => ({
                    atSec: t.atSec,
                    key: videoThumbKey(project.id, videoId, t.atSec),
                    width: t.width,
                    height: t.height,
                  })),
                },
              },
              include: { thumbnails: { orderBy: { atSec: "asc" } } },
            });
            await tx.deletionMark.deleteMany({ where: { prefix } });
            return created;
          }),
        );
        return { video: row };
      })();
    } catch (err) {
      void eagerCleanupAndUnmark(prefix).catch(() => {});
      throw err;
    }

    if ("error" in result) {
      void eagerCleanupAndUnmark(prefix).catch(() => {});
      return c.json({ error: result.error }, result.status);
    }
    return c.json({ video: toApiVideo(result.video) satisfies ApiVideo }, 201);
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

  .post("/:id/audios", vValidator("param", idParamSchema), async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.valid("param").id);
    if (!project) return c.json({ error: "project not found" }, 404);

    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_SLACK) {
      return c.json(
        { error: `file too large (max ${MAX_UPLOAD_BYTES} bytes, declared content-length)` },
        413,
      );
    }

    let form;
    try {
      form = await c.req.raw.formData();
    } catch {
      return c.json({ error: "invalid multipart body" }, 400);
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return c.json({ error: "file required" }, 400);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json(
        { error: `file too large (max ${MAX_UPLOAD_BYTES} bytes, parsed file.size)` },
        413,
      );
    }
    const nameField = form.get("name");
    const name = (typeof nameField === "string" ? nameField.trim() : "") || file.name || "audio";
    const ext = (extname(file.name) || ".bin").slice(1).toLowerCase();
    const contentType = file.type || "application/octet-stream";

    const audioId = crypto.randomUUID();
    const prefix = `${projectKey(project.id)}/audios/${audioId}/`;
    await markPrefixForDeletion(prefix, UPLOAD_GRACE_MS);

    let result;
    try {
      result = await (async () => {
        await using td = await tempDir("audio-upload");
        const tmp = td.path;
        const inputPath = join(tmp, "input." + ext);
        await Bun.write(inputPath, file);
        let probe;
        try {
          probe = await ffprobe(inputPath);
        } catch {
          return { error: "could not parse uploaded file", status: 400 as const };
        }
        if (!probe.audioStream) return { error: "no audio stream", status: 400 as const };
        if (
          !Number.isFinite(probe.durationSec) ||
          probe.durationSec <= 0 ||
          probe.durationSec > MAX_DURATION_SEC
        ) {
          return {
            error: `duration must be > 0 and <= ${MAX_DURATION_SEC}s (input probe)`,
            status: 400 as const,
          };
        }

        // 標準形 AAC m4a を常に持つ。decode できないなら 400 で拒否
        const transcodedPath = join(tmp, "transcoded.m4a");
        try {
          await transcodeAudio(inputPath, transcodedPath);
        } catch {
          return { error: "ffmpeg cannot decode this audio", status: 400 as const };
        }

        // audioKey が指す transcoded.m4a の長さに persist された durationSec を揃える
        const finalProbe = await ffprobe(transcodedPath);
        if (!Number.isFinite(finalProbe.durationSec) || finalProbe.durationSec <= 0) {
          return { error: "transcode produced unknown duration", status: 500 as const };
        }
        if (finalProbe.durationSec > MAX_DURATION_SEC) {
          return {
            error: `duration must be > 0 and <= ${MAX_DURATION_SEC}s (transcoded probe)`,
            status: 400 as const,
          };
        }

        const keepRaw = isBrowserPlayableAudio(probe.audioStream.codec, probe.formatName);
        const transcodedKey = audioTranscodedKey(project.id, audioId);
        const rawKey = keepRaw ? audioRawKey(project.id, audioId, ext) : null;

        await awaitAllOrAggregate([
          uploadFile(transcodedKey, transcodedPath, "audio/mp4"),
          ...(rawKey ? [uploadFile(rawKey, inputPath, contentType)] : []),
        ]);

        const duration = finalProbe.durationSec;
        const row = await withSlotRetry(() =>
          prisma.$transaction(async (tx) => {
            const { order, projStart } = await allocSlot(tx, project.id);
            const created = await tx.audio.create({
              data: {
                id: audioId,
                projectId: project.id,
                order,
                name,
                audioKey: transcodedKey,
                rawKey,
                rawContentType: keepRaw ? contentType : null,
                durationSec: duration,
                sampleRate: finalProbe.audioStream?.sampleRate || null,
                channels: finalProbe.audioStream?.channels || null,
                bitrate: finalProbe.audioStream?.bitrate ?? null,
                sizeBytes: BigInt(finalProbe.sizeBytes),
                srcStartSec: 0,
                srcEndSec: duration,
                projStartSec: projStart,
                projEndSec: projStart + duration,
              },
            });
            await tx.deletionMark.deleteMany({ where: { prefix } });
            return created;
          }),
        );
        return { audio: row };
      })();
    } catch (err) {
      void eagerCleanupAndUnmark(prefix).catch(() => {});
      throw err;
    }

    if ("error" in result) {
      void eagerCleanupAndUnmark(prefix).catch(() => {});
      return c.json({ error: result.error }, result.status);
    }
    return c.json({ audio: toApiAudio(result.audio) satisfies ApiAudio }, 201);
  })

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

export type ProjectsAppType = typeof projects;
