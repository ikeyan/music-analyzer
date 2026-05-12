import { extname, join } from "node:path";
import type { Upload } from "../generated/prisma/client";

// /complete 後に task が走り終わるまで sweeper に回収されないよう mark を伸ばす grace。
// MAX_DURATION_SEC (1h) の transcode + upload に余裕を持たせた値
export const TASK_GRACE_MS = 4 * 60 * 60 * 1000;
import {
  MAX_DURATION_SEC,
  extractAudio,
  extractThumbnails,
  ffprobe,
  isBrowserPlayableAudio,
  transcodeAudio,
  transcodeVideo,
} from "./ffmpeg";
import { prisma } from "./prisma";
import { awaitAllOrAggregate } from "./promise";
import { getS3 } from "./s3";
import {
  audioRawKey,
  audioTranscodedKey,
  deletePrefix,
  projectKey,
  uploadFile,
  uploadPrefix,
  videoAudioKey,
  videoSourceKey,
  videoThumbKey,
} from "./storage";
import { tempDir } from "./temp-dir";

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// project 行への update で SQLite write lock を先取りし、同一 project への並行 alloc を直列化する
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

async function projectExists(projectId: string): Promise<boolean> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  return p !== null;
}

// media prefix を sweeper の回収対象にしておき、Video/Audio.create と同じ tx で
// unmark する。並列 S3 upload の一部失敗・FK race・mid-upload crash すべてで
// orphan を残さない。grace は task の最大走行時間を見込んだ TASK_GRACE_MS を流用
async function markMediaPrefixForCleanup(prefix: string): Promise<void> {
  await prisma.deletionMark.create({
    data: { prefix, nextRetryAt: new Date(Date.now() + TASK_GRACE_MS) },
  });
}

// UploadChunk.s3Key を index 順に S3 ストリームから destPath に連結する。
// DB に記録された s3Key を直接読むので、/complete の validate と同じ object を merge する
async function mergeChunks(upload: Upload, destPath: string): Promise<void> {
  const chunks = await prisma.uploadChunk.findMany({
    where: { uploadId: upload.id },
    orderBy: { index: "asc" },
    select: { index: true, s3Key: true },
  });
  if (chunks.length !== upload.totalChunks) {
    throw new Error(
      `mergeChunks: chunk count ${chunks.length} != totalChunks ${upload.totalChunks}`,
    );
  }
  const s3 = getS3();
  const writer = Bun.file(destPath).writer();
  try {
    for (const chunk of chunks) {
      const reader = s3.file(chunk.s3Key).stream().getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
  } finally {
    await writer.end();
  }
}

type TaskResult =
  | { kind: "success"; videoId?: string; audioId?: string }
  | { kind: "failure"; error: string };

async function runVideoTask(upload: Upload): Promise<TaskResult> {
  await using td = await tempDir("video-task");
  const tmp = td.path;
  const ext = extname(upload.fileName) || ".bin";
  const inputPath = join(tmp, "input" + ext);
  await mergeChunks(upload, inputPath);

  let probe;
  try {
    probe = await ffprobe(inputPath);
  } catch {
    return { kind: "failure", error: "could not parse uploaded file" };
  }
  if (!probe.videoStream) return { kind: "failure", error: "no video stream" };
  if (
    !Number.isFinite(probe.durationSec) ||
    probe.durationSec <= 0 ||
    probe.durationSec > MAX_DURATION_SEC
  ) {
    return {
      kind: "failure",
      error: `duration must be > 0 and <= ${MAX_DURATION_SEC}s (input probe)`,
    };
  }

  const hasAudio = probe.audioStream !== null;
  const videoOut = join(tmp, "video.mp4");
  const audioOut = join(tmp, "audio.m4a");
  const thumbDir = join(tmp, "thumbs");
  const ac = new AbortController();
  const tasks: Promise<unknown>[] = [transcodeVideo(inputPath, videoOut, hasAudio, ac.signal)];
  if (hasAudio) tasks.push(extractAudio(inputPath, audioOut, ac.signal));
  try {
    await Promise.all(tasks);
  } catch {
    ac.abort();
    await Promise.allSettled(tasks);
    return { kind: "failure", error: "ffmpeg cannot decode this video" };
  }

  const finalProbe = await ffprobe(videoOut);
  const vs = finalProbe.videoStream;
  if (!vs) return { kind: "failure", error: "transcode produced no video stream" };
  if (!Number.isFinite(finalProbe.durationSec) || finalProbe.durationSec <= 0) {
    return { kind: "failure", error: "transcode produced unknown duration" };
  }
  if (finalProbe.durationSec > MAX_DURATION_SEC) {
    return {
      kind: "failure",
      error: `duration must be > 0 and <= ${MAX_DURATION_SEC}s (transcoded probe)`,
    };
  }

  const thumbs = await extractThumbnails(
    videoOut,
    thumbDir,
    finalProbe.durationSec,
    vs.width,
    vs.height,
  );

  const videoId = crypto.randomUUID();
  const vKey = videoSourceKey(upload.projectId, videoId);
  const aKey = hasAudio ? videoAudioKey(upload.projectId, videoId) : null;
  const videoPrefix = `${projectKey(upload.projectId)}/videos/${videoId}/`;
  if (!(await projectExists(upload.projectId))) {
    return { kind: "failure", error: "project deleted before media upload" };
  }
  // S3 upload + Video.create のどこで落ちても orphan を残さないよう先に mark を打つ。
  // 全部成功して row が確定したら mark を消す
  await markMediaPrefixForCleanup(videoPrefix);
  await awaitAllOrAggregate([
    uploadFile(vKey, videoOut, "video/mp4"),
    ...(aKey ? [uploadFile(aKey, audioOut, "audio/mp4")] : []),
    ...thumbs.map((t) =>
      uploadFile(videoThumbKey(upload.projectId, videoId, t.atSec), t.path, "image/jpeg"),
    ),
  ]);

  const duration = finalProbe.durationSec;
  const created = await withSlotRetry(() =>
    prisma.$transaction(async (tx) => {
      const { order, projStart } = await allocSlot(tx, upload.projectId);
      const v = await tx.video.create({
        data: {
          id: videoId,
          projectId: upload.projectId,
          order,
          name: upload.fileName || "video",
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
              key: videoThumbKey(upload.projectId, videoId, t.atSec),
              width: t.width,
              height: t.height,
            })),
          },
        },
      });
      // row が確定した時点で mark を消す。途中 throw 時は mark が残り sweeper が拾う
      await tx.deletionMark.deleteMany({ where: { prefix: videoPrefix } });
      return v;
    }),
  );
  return { kind: "success", videoId: created.id };
}

async function runAudioTask(upload: Upload): Promise<TaskResult> {
  await using td = await tempDir("audio-task");
  const tmp = td.path;
  const ext = (extname(upload.fileName) || ".bin").slice(1).toLowerCase();
  const inputPath = join(tmp, "input." + ext);
  await mergeChunks(upload, inputPath);

  let probe;
  try {
    probe = await ffprobe(inputPath);
  } catch {
    return { kind: "failure", error: "could not parse uploaded file" };
  }
  if (!probe.audioStream) return { kind: "failure", error: "no audio stream" };
  if (
    !Number.isFinite(probe.durationSec) ||
    probe.durationSec <= 0 ||
    probe.durationSec > MAX_DURATION_SEC
  ) {
    return {
      kind: "failure",
      error: `duration must be > 0 and <= ${MAX_DURATION_SEC}s (input probe)`,
    };
  }

  const transcodedPath = join(tmp, "transcoded.m4a");
  try {
    await transcodeAudio(inputPath, transcodedPath);
  } catch {
    return { kind: "failure", error: "ffmpeg cannot decode this audio" };
  }

  const finalProbe = await ffprobe(transcodedPath);
  if (!Number.isFinite(finalProbe.durationSec) || finalProbe.durationSec <= 0) {
    return { kind: "failure", error: "transcode produced unknown duration" };
  }
  if (finalProbe.durationSec > MAX_DURATION_SEC) {
    return {
      kind: "failure",
      error: `duration must be > 0 and <= ${MAX_DURATION_SEC}s (transcoded probe)`,
    };
  }

  const audioId = crypto.randomUUID();
  const contentType = upload.contentType ?? "application/octet-stream";
  const keepRaw = isBrowserPlayableAudio(probe.audioStream.codec, probe.formatName);
  const transcodedKey = audioTranscodedKey(upload.projectId, audioId);
  const rawKey = keepRaw ? audioRawKey(upload.projectId, audioId, ext) : null;
  const audioPrefix = `${projectKey(upload.projectId)}/audios/${audioId}/`;
  if (!(await projectExists(upload.projectId))) {
    return { kind: "failure", error: "project deleted before media upload" };
  }
  await markMediaPrefixForCleanup(audioPrefix);
  await awaitAllOrAggregate([
    uploadFile(transcodedKey, transcodedPath, "audio/mp4"),
    ...(rawKey ? [uploadFile(rawKey, inputPath, contentType)] : []),
  ]);

  const duration = finalProbe.durationSec;
  const created = await withSlotRetry(() =>
    prisma.$transaction(async (tx) => {
      const { order, projStart } = await allocSlot(tx, upload.projectId);
      const a = await tx.audio.create({
        data: {
          id: audioId,
          projectId: upload.projectId,
          order,
          name: upload.fileName || "audio",
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
      await tx.deletionMark.deleteMany({ where: { prefix: audioPrefix } });
      return a;
    }),
  );
  return { kind: "success", audioId: created.id };
}

// task を 1件実行する。task 完了時に upload prefix の DeletionMark を即時 cleanup
async function executeTask(taskId: string): Promise<void> {
  const claimed = await prisma.task.updateMany({
    where: { id: taskId, status: "pending" },
    data: { status: "running", startedAt: new Date() },
  });
  if (claimed.count === 0) return;

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { upload: true },
  });
  if (!task || !task.upload) {
    await prisma.task.update({
      where: { id: taskId },
      data: { status: "failed", error: "task has no upload", finishedAt: new Date() },
    });
    return;
  }

  let result: TaskResult;
  try {
    result =
      task.type === "video_validation"
        ? await runVideoTask(task.upload)
        : await runAudioTask(task.upload);
  } catch (err) {
    result = {
      kind: "failure",
      error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
    };
  }

  if (result.kind === "success") {
    await prisma.task.update({
      where: { id: task.id },
      data: {
        status: "succeeded",
        finishedAt: new Date(),
        videoId: result.videoId ?? null,
        audioId: result.audioId ?? null,
      },
    });
  } else {
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "failed", error: result.error, finishedAt: new Date() },
    });
  }

  // upload chunks はもう不要 (Video/Audio へ昇格済み or 失敗)。
  // 同期 cleanup が失敗しても DeletionMark + sweeper が後で回収する
  const prefix = uploadPrefix(task.upload.projectId, task.upload.id);
  try {
    await deletePrefix(prefix);
    await prisma.deletionMark.deleteMany({ where: { prefix } });
  } catch {
    /* sweeperに任せる */
  }
}

// 起動からの inflight task 集合。dev HMR / test 横断で重複起動しないよう global に持つ
declare global {
  // eslint-disable-next-line no-var
  var __musicAnalyzerInflightTasks: Set<string> | undefined;
}
const inflight =
  globalThis.__musicAnalyzerInflightTasks ??
  (globalThis.__musicAnalyzerInflightTasks = new Set<string>());

// task を background 実行用に enqueue。await しない (返り値で完了待ちはできない)
export function enqueueTask(taskId: string): void {
  if (inflight.has(taskId)) return;
  inflight.add(taskId);
  void (async () => {
    try {
      await executeTask(taskId);
    } catch {
      /* executeTask 内で task row は failed に落としている */
    } finally {
      inflight.delete(taskId);
    }
  })();
}

// テスト用に inflight 完了を待つ
export async function waitForInflightTasks(): Promise<void> {
  while (inflight.size > 0) await Bun.sleep(20);
}

// 起動時に「running のまま残った」task は前 process が落ちた事を意味するので
// failed へ落とす。pending は再 enqueue して実行を継続させる。
// 4h grace ギリギリの再起動で sweeper が走ると chunks が消える窓があるので
// 再 enqueue 前に DeletionMark.nextRetryAt を引き直す
export async function recoverTasksOnStartup(): Promise<void> {
  const orphaned = await prisma.task.updateMany({
    where: { status: "running" },
    data: { status: "failed", error: "process restarted during task", finishedAt: new Date() },
  });
  if (orphaned.count > 0) {
    console.error(`task-runner: marked ${orphaned.count} orphaned tasks as failed`);
  }
  const pending = await prisma.task.findMany({
    where: { status: "pending" },
    select: { id: true, upload: { select: { id: true, projectId: true } } },
  });
  const refreshAt = new Date(Date.now() + TASK_GRACE_MS);
  for (const t of pending) {
    if (t.upload) {
      await prisma.deletionMark.updateMany({
        where: { prefix: uploadPrefix(t.upload.projectId, t.upload.id) },
        data: { nextRetryAt: refreshAt },
      });
    }
    enqueueTask(t.id);
  }
}
