import { Hono } from "hono";
import { extname, join } from "node:path";
import { unlink } from "node:fs/promises";
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
  withTempDir,
} from "../lib/ffmpeg";
import { jsonResponse } from "../lib/json";
import { prisma } from "../lib/prisma";
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

async function findProjectOr404(userId: string, projectId: string) {
  const p = await prisma.project.findFirst({ where: { id: projectId, userId } });
  return p;
}

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// (projectId, order) のunique制約と projStart の隣接配置を満たす次スロットを採取する。
// 呼び出しは tx 内で行い、create と原子化する。
// video/audio の unique は table 別なので片方だけでは cross-table race を防げない。
// project行を先に update して SQLite の write lock を獲得し、同一 project への
// 並行 alloc を直列化する
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

// upload開始前に立てる墓標の有効期限。これを越えると sweeper が S3 を消し始める。
// 1h動画の transcode + upload を含めても十分余裕がある値
const UPLOAD_GRACE_MS = 4 * 60 * 60 * 1000;

// upload経路で先に立てる墓標。S3にbyteを書く前に呼び、handlerが完走したら
// DB tx の中で同じ prefix の mark を消す。途中で死んだら sweeper が grace 後に拾う
async function markPrefixForDeletion(prefix: string, graceMs = 0): Promise<void> {
  await prisma.deletionMark.create({
    data: { prefix, nextRetryAt: new Date(Date.now() + graceMs) },
  });
}

// 同期best-effort cleanup。失敗してもsweeperがmarkを拾うのでthrowしない
async function eagerCleanupAndUnmark(prefix: string): Promise<void> {
  try {
    await deletePrefix(prefix);
    await prisma.deletionMark.deleteMany({ where: { prefix } });
  } catch {
    /* sweeperに任せる */
  }
}

// SQLite + Prisma は transaction で write を直列化するが、保険として
// (projectId, order) のunique衝突 (P2002) と書き込み競合 (P2034) はリトライする
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
    return c.json({ projects: list });
  })
  .post("/", async (c) => {
    const user = c.var.user;
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name required" }, 400);
    const project = await prisma.project.create({ data: { userId: user.id, name } });
    return c.json({ project }, 201);
  })
  .get("/:id", async (c) => {
    const user = c.var.user;
    const project = await prisma.project.findFirst({
      where: { id: c.req.param("id"), userId: user.id },
      include: {
        videos: {
          orderBy: { order: "asc" },
          include: { thumbnails: { orderBy: { atSec: "asc" } } },
        },
        audios: { orderBy: { order: "asc" } },
      },
    });
    if (!project) return c.notFound();
    return jsonResponse(c, { project });
  })
  .delete("/:id", async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.param("id"));
    if (!project) return c.notFound();
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

  .post("/:id/videos", async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.param("id"));
    if (!project) return c.notFound();

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
      return c.json({ error: `file too large (max ${MAX_UPLOAD_BYTES} bytes)` }, 413);
    }
    const name = (form.get("name") as string | null)?.trim() || file.name || "video";

    const videoId = crypto.randomUUID();
    const prefix = `${projectKey(project.id)}/videos/${videoId}/`;
    // S3 にバイトを置く前に墓標を立てる。完走したら DB tx の中で消す。
    // 途中で死んだら sweeper が grace 経過後に拾う (orphan が S3 に残らない)
    await markPrefixForDeletion(prefix, UPLOAD_GRACE_MS);

    let result;
    try {
      result = await withTempDir("video-upload", async (tmp) => {
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
            error: `duration must be > 0 and <= ${MAX_DURATION_SEC}s`,
            status: 400 as const,
          };
        }

        const hasAudio = probe.audioStream !== null;
        const videoOut = join(tmp, "video.mp4");
        const audioOut = join(tmp, "audio.m4a");
        const thumbDir = join(tmp, "thumbs");
        // 片方が落ちた瞬間にもう片方も abort して CPU/disk を解放する
        const ac = new AbortController();
        const tasks: Promise<unknown>[] = [
          transcodeVideo(inputPath, videoOut, hasAudio, ac.signal),
        ];
        if (hasAudio) tasks.push(extractAudio(inputPath, audioOut, ac.signal));
        try {
          await Promise.all(tasks);
        } catch {
          ac.abort();
          // 残りの ffmpeg がプロセスを抱えたまま return しないよう settle 待ち
          await Promise.allSettled(tasks);
          return { error: "ffmpeg cannot decode this video", status: 400 as const };
        }

        const finalProbe = await ffprobe(videoOut);
        const v = finalProbe.videoStream;
        if (!v) return { error: "transcode produced no video stream", status: 500 as const };
        if (!Number.isFinite(finalProbe.durationSec) || finalProbe.durationSec <= 0) {
          return { error: "transcode produced unknown duration", status: 500 as const };
        }
        // pre-probe の durationSec が壊れた入力で過小報告された場合に備えて再判定
        if (finalProbe.durationSec > MAX_DURATION_SEC) {
          return {
            error: `duration must be > 0 and <= ${MAX_DURATION_SEC}s`,
            status: 400 as const,
          };
        }

        const thumbs = await extractThumbnails(
          videoOut,
          thumbDir,
          finalProbe.durationSec,
          v.width,
          v.height,
        );

        const vKey = videoSourceKey(project.id, videoId);
        const aKey = hasAudio ? videoAudioKey(project.id, videoId) : null;

        await Promise.all([
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
                width: v.width,
                height: v.height,
                fps: v.fps,
                videoBitrate: v.bitrate,
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
      });
    } catch (err) {
      // sweeper が grace 経過後に拾うが、user を待たせないよう即時 cleanup も試す
      void eagerCleanupAndUnmark(prefix).catch(() => {});
      throw err;
    }

    if ("error" in result) {
      // 早期 validation 失敗。S3 にはまだ何も置いていないが mark は立っているので消す
      void eagerCleanupAndUnmark(prefix).catch(() => {});
      return c.json({ error: result.error }, result.status);
    }
    return jsonResponse(c, { video: result.video }, 201);
  })

  .delete("/:id/videos/:videoId", async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.param("id"));
    if (!project) return c.notFound();
    const video = await prisma.video.findFirst({
      where: { id: c.req.param("videoId"), projectId: project.id },
    });
    if (!video) return c.notFound();
    const prefix = `${projectKey(project.id)}/videos/${video.id}/`;
    await prisma.$transaction(async (tx) => {
      await tx.deletionMark.create({ data: { prefix } });
      await tx.thumbnail.deleteMany({ where: { videoId: video.id } });
      await tx.video.delete({ where: { id: video.id } });
    });
    await eagerCleanupAndUnmark(prefix);
    return c.body(null, 204);
  })

  .get("/:id/videos/:videoId/stream", async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.param("id"));
    if (!project) return c.notFound();
    const video = await prisma.video.findFirst({
      where: { id: c.req.param("videoId"), projectId: project.id },
    });
    if (!video) return c.notFound();
    return await streamS3(c, video.videoKey, "video/mp4");
  })

  .get("/:id/videos/:videoId/audio", async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.param("id"));
    if (!project) return c.notFound();
    const video = await prisma.video.findFirst({
      where: { id: c.req.param("videoId"), projectId: project.id },
    });
    if (!video || !video.audioKey) return c.notFound();
    return await streamS3(c, video.audioKey, "audio/mp4");
  })

  .get("/:id/videos/:videoId/thumbnails/:thumbId", async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.param("id"));
    if (!project) return c.notFound();
    const thumb = await prisma.thumbnail.findFirst({
      where: { id: c.req.param("thumbId"), video: { projectId: project.id } },
    });
    if (!thumb) return c.notFound();
    return await streamS3(c, thumb.key, "image/jpeg");
  })

  .post("/:id/audios", async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.param("id"));
    if (!project) return c.notFound();

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
      return c.json({ error: `file too large (max ${MAX_UPLOAD_BYTES} bytes)` }, 413);
    }
    const name = (form.get("name") as string | null)?.trim() || file.name || "audio";
    const ext = (extname(file.name) || ".bin").slice(1).toLowerCase();
    const contentType = file.type || "application/octet-stream";

    const audioId = crypto.randomUUID();
    const prefix = `${projectKey(project.id)}/audios/${audioId}/`;
    await markPrefixForDeletion(prefix, UPLOAD_GRACE_MS);

    let result;
    try {
      result = await withTempDir("audio-upload", async (tmp) => {
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
            error: `duration must be > 0 and <= ${MAX_DURATION_SEC}s`,
            status: 400 as const,
          };
        }

        // 標準化AAC m4aは常に作る。失敗 = ffmpegが扱えない入力なので400で拒否
        const transcodedPath = join(tmp, "transcoded.m4a");
        try {
          await transcodeAudio(inputPath, transcodedPath);
        } catch {
          return { error: "ffmpeg cannot decode this audio", status: 400 as const };
        }

        // audioKey は transcoded を指すので、persistする durationSec は
        // re-probe した transcoded の長さに揃える (priming/padding や入力 metadata の
        // ズレで pre-probe と差が出るため)
        const finalProbe = await ffprobe(transcodedPath);
        if (!Number.isFinite(finalProbe.durationSec) || finalProbe.durationSec <= 0) {
          return { error: "transcode produced unknown duration", status: 500 as const };
        }
        if (finalProbe.durationSec > MAX_DURATION_SEC) {
          return {
            error: `duration must be > 0 and <= ${MAX_DURATION_SEC}s`,
            status: 400 as const,
          };
        }

        const keepRaw = isBrowserPlayableAudio(probe.audioStream.codec, probe.formatName);
        const transcodedKey = audioTranscodedKey(project.id, audioId);
        const rawKey = keepRaw ? audioRawKey(project.id, audioId, ext) : null;

        await Promise.all([
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
                // audioKey は transcoded を指すので metadata も transcoded probe 由来に揃える
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
        await unlink(inputPath).catch(() => {});
        return { audio: row };
      });
    } catch (err) {
      void eagerCleanupAndUnmark(prefix).catch(() => {});
      throw err;
    }

    if ("error" in result) {
      void eagerCleanupAndUnmark(prefix).catch(() => {});
      return c.json({ error: result.error }, result.status);
    }
    return jsonResponse(c, { audio: result.audio }, 201);
  })

  .delete("/:id/audios/:audioId", async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.param("id"));
    if (!project) return c.notFound();
    const audio = await prisma.audio.findFirst({
      where: { id: c.req.param("audioId"), projectId: project.id },
    });
    if (!audio) return c.notFound();
    const prefix = `${projectKey(project.id)}/audios/${audio.id}/`;
    await prisma.$transaction(async (tx) => {
      await tx.deletionMark.create({ data: { prefix } });
      await tx.audio.delete({ where: { id: audio.id } });
    });
    await eagerCleanupAndUnmark(prefix);
    return c.body(null, 204);
  })

  .get("/:id/audios/:audioId/stream", async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.param("id"));
    if (!project) return c.notFound();
    const audio = await prisma.audio.findFirst({
      where: { id: c.req.param("audioId"), projectId: project.id },
    });
    if (!audio) return c.notFound();
    return await streamS3(c, audio.audioKey, "audio/mp4");
  })

  .get("/:id/audios/:audioId/raw", async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.param("id"));
    if (!project) return c.notFound();
    const audio = await prisma.audio.findFirst({
      where: { id: c.req.param("audioId"), projectId: project.id },
    });
    if (!audio || !audio.rawKey) return c.notFound();
    return await streamS3(c, audio.rawKey, audio.rawContentType ?? "application/octet-stream");
  });
