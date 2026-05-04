import { Hono } from "hono";
import { extname, join } from "node:path";
import { unlink } from "node:fs/promises";
import { type AuthContext, requireUser } from "../lib/auth";
import {
  MAX_DURATION_SEC,
  extractAudio,
  extractThumbnails,
  ffprobe,
  transcodeVideo,
  withTempDir,
} from "../lib/ffmpeg";
import { prisma } from "../lib/prisma";
import {
  audioSourceKey,
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
// 呼び出しは tx 内で行い、create と原子化する
async function allocSlot(
  tx: TxClient,
  projectId: string,
): Promise<{ order: number; projStart: number }> {
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

// SQLite + Prisma は transaction で write を直列化するが、保険として
// (projectId, order) のunique衝突 (P2002) はリトライする
async function withSlotRetry<T>(fn: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 5;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== "P2002" || i === MAX_ATTEMPTS - 1) throw err;
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
    return c.json({ project });
  })
  .delete("/:id", async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.param("id"));
    if (!project) return c.notFound();
    await deletePrefix(`${projectKey(project.id)}/`);
    await prisma.thumbnail.deleteMany({ where: { video: { projectId: project.id } } });
    await prisma.video.deleteMany({ where: { projectId: project.id } });
    await prisma.audio.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } });
    return c.body(null, 204);
  })

  .post("/:id/videos", async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.param("id"));
    if (!project) return c.notFound();

    const form = await c.req.raw.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return c.json({ error: "file required" }, 400);
    }
    const name = (form.get("name") as string | null)?.trim() || file.name || "video";

    // S3に全オブジェクトを置いた後にDB rowを作る (失敗時は孤立S3で済み、broken rowは残らない)
    const videoId = crypto.randomUUID();

    const result = await withTempDir("video-upload", async (tmp) => {
      const inputPath = join(tmp, "input" + (extname(file.name) || ".bin"));
      await Bun.write(inputPath, file);

      const probe = await ffprobe(inputPath);
      if (!probe.videoStream) {
        return { error: "no video stream", status: 400 as const };
      }
      if (probe.durationSec <= 0 || probe.durationSec > MAX_DURATION_SEC) {
        return { error: `duration must be > 0 and <= ${MAX_DURATION_SEC}s`, status: 400 as const };
      }

      const hasAudio = probe.audioStream !== null;
      const videoOut = join(tmp, "video.mp4");
      const audioOut = join(tmp, "audio.m4a");
      const thumbDir = join(tmp, "thumbs");
      const tasks: Promise<unknown>[] = [transcodeVideo(inputPath, videoOut, hasAudio)];
      if (hasAudio) tasks.push(extractAudio(inputPath, audioOut));
      await Promise.all(tasks);

      const finalProbe = await ffprobe(videoOut);
      const v = finalProbe.videoStream;
      if (!v) return { error: "transcode produced no video stream", status: 500 as const };

      const thumbs = await extractThumbnails(
        videoOut,
        thumbDir,
        finalProbe.durationSec,
        v.width,
        v.height,
      );

      const vKey = videoSourceKey(project.id, videoId);
      const aKey = hasAudio ? videoAudioKey(project.id, videoId) : null;

      try {
        await Promise.all([
          uploadFile(vKey, videoOut, "video/mp4"),
          ...(aKey ? [uploadFile(aKey, audioOut, "audio/mp4")] : []),
          ...thumbs.map((t) =>
            uploadFile(videoThumbKey(project.id, videoId, t.atSec), t.path, "image/jpeg"),
          ),
        ]);
      } catch (err) {
        await deletePrefix(`${projectKey(project.id)}/videos/${videoId}/`).catch(() => {});
        throw err;
      }

      const duration = finalProbe.durationSec;

      try {
        const row = await withSlotRetry(() =>
          prisma.$transaction(async (tx) => {
            const { order, projStart } = await allocSlot(tx, project.id);
            return tx.video.create({
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
                sizeBytes: finalProbe.sizeBytes,
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
          }),
        );
        return { video: row };
      } catch (err) {
        await deletePrefix(`${projectKey(project.id)}/videos/${videoId}/`).catch(() => {});
        throw err;
      }
    });

    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json({ video: result.video }, 201);
  })

  .delete("/:id/videos/:videoId", async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.param("id"));
    if (!project) return c.notFound();
    const video = await prisma.video.findFirst({
      where: { id: c.req.param("videoId"), projectId: project.id },
    });
    if (!video) return c.notFound();
    await deletePrefix(`${projectKey(project.id)}/videos/${video.id}/`);
    await prisma.thumbnail.deleteMany({ where: { videoId: video.id } });
    await prisma.video.delete({ where: { id: video.id } });
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

    const form = await c.req.raw.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return c.json({ error: "file required" }, 400);
    }
    const name = (form.get("name") as string | null)?.trim() || file.name || "audio";
    const ext = (extname(file.name) || ".bin").slice(1).toLowerCase();
    const contentType = file.type || "application/octet-stream";

    const audioId = crypto.randomUUID();

    const result = await withTempDir("audio-upload", async (tmp) => {
      const inputPath = join(tmp, "input." + ext);
      await Bun.write(inputPath, file);
      const probe = await ffprobe(inputPath);
      if (!probe.audioStream) return { error: "no audio stream", status: 400 as const };
      if (probe.durationSec <= 0 || probe.durationSec > MAX_DURATION_SEC) {
        return { error: `duration must be > 0 and <= ${MAX_DURATION_SEC}s`, status: 400 as const };
      }

      const key = audioSourceKey(project.id, audioId, ext);
      try {
        await uploadFile(key, inputPath, contentType);
      } catch (err) {
        await deletePrefix(`${projectKey(project.id)}/audios/${audioId}/`).catch(() => {});
        throw err;
      }

      const duration = probe.durationSec;

      try {
        const row = await withSlotRetry(() =>
          prisma.$transaction(async (tx) => {
            const { order, projStart } = await allocSlot(tx, project.id);
            return tx.audio.create({
              data: {
                id: audioId,
                projectId: project.id,
                order,
                name,
                audioKey: key,
                contentType,
                durationSec: duration,
                sampleRate: probe.audioStream?.sampleRate || null,
                channels: probe.audioStream?.channels || null,
                bitrate: probe.audioStream?.bitrate ?? null,
                sizeBytes: probe.sizeBytes,
                srcStartSec: 0,
                srcEndSec: duration,
                projStartSec: projStart,
                projEndSec: projStart + duration,
              },
            });
          }),
        );
        await unlink(inputPath).catch(() => {});
        return { audio: row };
      } catch (err) {
        await deletePrefix(`${projectKey(project.id)}/audios/${audioId}/`).catch(() => {});
        throw err;
      }
    });

    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json({ audio: result.audio }, 201);
  })

  .delete("/:id/audios/:audioId", async (c) => {
    const user = c.var.user;
    const project = await findProjectOr404(user.id, c.req.param("id"));
    if (!project) return c.notFound();
    const audio = await prisma.audio.findFirst({
      where: { id: c.req.param("audioId"), projectId: project.id },
    });
    if (!audio) return c.notFound();
    await deletePrefix(`${projectKey(project.id)}/audios/${audio.id}/`);
    await prisma.audio.delete({ where: { id: audio.id } });
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
    return await streamS3(c, audio.audioKey, audio.contentType);
  });
