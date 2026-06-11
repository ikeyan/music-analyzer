import { Either } from "effect";
import { extname, join } from "node:path";
import type { Task, Upload } from "../generated/prisma/client";
import { describeError } from "./error";
import {
  MAX_DURATION_SEC,
  MAX_PROJECT_TIMING_SEC,
  extractAudio,
  extractThumbnails,
  ffprobe,
  isBrowserPlayableAudio,
  transcodeAudio,
  transcodeVideo,
} from "./ffmpeg";
import { eagerCleanupAndUnmark, markPrefixForDeletion } from "./gc";
import { prisma } from "./prisma";
import { withSlotRetry } from "./prisma-retry";
import { awaitAllOrAggregate } from "./promise";
import { getS3 } from "./s3";
import { runSpectrogramTask } from "./spectrogram-task";
import {
  audioPrefix,
  audioRawKey,
  audioTranscodedKey,
  spectrogramPrefix,
  uploadFile,
  uploadPrefix,
  videoAudioKey,
  videoPrefix,
  videoSourceKey,
  videoThumbKey,
} from "./storage";
import { tempDir } from "./temp-dir";

// /complete 後の task 走行中 sweep を防ぐ S3 prefix の grace (1h transcode + 余裕)
export const TASK_GRACE_MS = 4 * 60 * 60 * 1000;

// terminal task の DB row 回収猶予。sweeper が Task + Upload + uploadChunk を消す
export const TASK_SUCCESS_GRACE_MS = 60 * 60 * 1000;
export const TASK_FAILURE_GRACE_MS = 24 * 60 * 60 * 1000;

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// project 行への update で SQLite write lock を先取りし、同一 project への並行 alloc を直列化する
// 反転 (projStart > projEnd) が許されるので max(start, end) = max(max start, max end) で両軸を見る
async function allocSlot(
  tx: TxClient,
  projectId: string,
): Promise<{ order: number; projStart: number }> {
  await tx.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
  const [vOrder, aOrder, vEnd, aEnd, vStart, aStart] = await Promise.all([
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
    tx.video.findFirst({
      where: { projectId },
      orderBy: { projStartSec: "desc" },
      select: { projStartSec: true },
    }),
    tx.audio.findFirst({
      where: { projectId },
      orderBy: { projStartSec: "desc" },
      select: { projStartSec: true },
    }),
  ]);
  return {
    order: Math.max(vOrder?.order ?? -1, aOrder?.order ?? -1) + 1,
    projStart: Math.max(
      vEnd?.projEndSec ?? 0,
      aEnd?.projEndSec ?? 0,
      vStart?.projStartSec ?? 0,
      aStart?.projStartSec ?? 0,
    ),
  };
}

async function projectExists(projectId: string): Promise<boolean> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  return p !== null;
}

// DB の s3Key を index 順に読む (/complete が validate したのと同じ object)
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

// 成功は付随データ不要 (executeTask は失敗時の error しか見ない)
type TaskResult = Either.Either<void, string>;

async function runVideoTask(taskId: string, upload: Upload): Promise<TaskResult> {
  await using td = await tempDir("video-task");
  const tmp = td.path;
  const ext = extname(upload.fileName) || ".bin";
  const inputPath = join(tmp, "input" + ext);
  await mergeChunks(upload, inputPath);

  let probe;
  try {
    probe = await ffprobe(inputPath);
  } catch {
    return Either.left("could not parse uploaded file");
  }
  if (!probe.videoStream) return Either.left("no video stream");
  if (
    !Number.isFinite(probe.durationSec) ||
    probe.durationSec <= 0 ||
    probe.durationSec > MAX_DURATION_SEC
  ) {
    return Either.left(`duration must be > 0 and <= ${MAX_DURATION_SEC}s (input probe)`);
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
    return Either.left("ffmpeg cannot decode this video");
  }

  const finalProbe = await ffprobe(videoOut);
  const vs = finalProbe.videoStream;
  if (!vs) return Either.left("transcode produced no video stream");
  if (!Number.isFinite(finalProbe.durationSec) || finalProbe.durationSec <= 0) {
    return Either.left("transcode produced unknown duration");
  }
  if (finalProbe.durationSec > MAX_DURATION_SEC) {
    return Either.left(`duration must be > 0 and <= ${MAX_DURATION_SEC}s (transcoded probe)`);
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
  const vPrefix = videoPrefix(upload.projectId, videoId);
  if (!(await projectExists(upload.projectId))) {
    return Either.left("project deleted before media upload");
  }
  // Video.create commit で unmark、未到達なら sweeper 回収
  await markPrefixForDeletion(vPrefix, TASK_GRACE_MS);
  await awaitAllOrAggregate([
    uploadFile(vKey, videoOut, "video/mp4"),
    ...(aKey ? [uploadFile(aKey, audioOut, "audio/mp4")] : []),
    ...thumbs.map((t) =>
      uploadFile(videoThumbKey(upload.projectId, videoId, t.atSec), t.path, "image/jpeg"),
    ),
  ]);

  const duration = finalProbe.durationSec;
  const allocResult = await withSlotRetry(() =>
    prisma.$transaction(async (tx) => {
      const { order, projStart } = await allocSlot(tx, upload.projectId);
      if (projStart + duration > MAX_PROJECT_TIMING_SEC) {
        return Either.left({ projEnd: projStart + duration });
      }
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
      await tx.deletionMark.deleteMany({ where: { prefix: vPrefix } });
      // task→succeeded は Video.create と同 tx 必須 (中間状態で recovery が failed に倒す)
      const finishedAt = new Date();
      await tx.task.update({
        where: { id: taskId },
        data: {
          status: "succeeded",
          finishedAt,
          videoId: v.id,
          expireAt: new Date(finishedAt.getTime() + TASK_SUCCESS_GRACE_MS),
        },
      });
      await tx.uploadChunk.deleteMany({ where: { uploadId: upload.id } });
      return Either.right(v);
    }),
  );
  if (Either.isLeft(allocResult)) {
    return Either.left(
      `project timeline cap exceeded: would end at ${allocResult.left.projEnd}s (max ${MAX_PROJECT_TIMING_SEC}s)`,
    );
  }
  return Either.right(undefined);
}

async function runAudioTask(taskId: string, upload: Upload): Promise<TaskResult> {
  await using td = await tempDir("audio-task");
  const tmp = td.path;
  const ext = (extname(upload.fileName) || ".bin").slice(1).toLowerCase();
  const inputPath = join(tmp, "input." + ext);
  await mergeChunks(upload, inputPath);

  let probe;
  try {
    probe = await ffprobe(inputPath);
  } catch {
    return Either.left("could not parse uploaded file");
  }
  if (!probe.audioStream) return Either.left("no audio stream");
  if (
    !Number.isFinite(probe.durationSec) ||
    probe.durationSec <= 0 ||
    probe.durationSec > MAX_DURATION_SEC
  ) {
    return Either.left(`duration must be > 0 and <= ${MAX_DURATION_SEC}s (input probe)`);
  }

  const transcodedPath = join(tmp, "transcoded.m4a");
  try {
    await transcodeAudio(inputPath, transcodedPath);
  } catch {
    return Either.left("ffmpeg cannot decode this audio");
  }

  const finalProbe = await ffprobe(transcodedPath);
  if (!Number.isFinite(finalProbe.durationSec) || finalProbe.durationSec <= 0) {
    return Either.left("transcode produced unknown duration");
  }
  if (finalProbe.durationSec > MAX_DURATION_SEC) {
    return Either.left(`duration must be > 0 and <= ${MAX_DURATION_SEC}s (transcoded probe)`);
  }

  const audioId = crypto.randomUUID();
  const contentType = upload.contentType ?? "application/octet-stream";
  const keepRaw = isBrowserPlayableAudio(probe.audioStream.codec, probe.formatName);
  const transcodedKey = audioTranscodedKey(upload.projectId, audioId);
  const rawKey = keepRaw ? audioRawKey(upload.projectId, audioId, ext) : null;
  const aPrefix = audioPrefix(upload.projectId, audioId);
  if (!(await projectExists(upload.projectId))) {
    return Either.left("project deleted before media upload");
  }
  await markPrefixForDeletion(aPrefix, TASK_GRACE_MS);
  await awaitAllOrAggregate([
    uploadFile(transcodedKey, transcodedPath, "audio/mp4"),
    ...(rawKey ? [uploadFile(rawKey, inputPath, contentType)] : []),
  ]);

  const duration = finalProbe.durationSec;
  const allocResult = await withSlotRetry(() =>
    prisma.$transaction(async (tx) => {
      const { order, projStart } = await allocSlot(tx, upload.projectId);
      if (projStart + duration > MAX_PROJECT_TIMING_SEC) {
        return Either.left({ projEnd: projStart + duration });
      }
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
      await tx.deletionMark.deleteMany({ where: { prefix: aPrefix } });
      // task→succeeded は Audio.create と同 tx 必須 (中間状態で recovery が failed に倒す)
      const finishedAt = new Date();
      await tx.task.update({
        where: { id: taskId },
        data: {
          status: "succeeded",
          finishedAt,
          audioId: a.id,
          expireAt: new Date(finishedAt.getTime() + TASK_SUCCESS_GRACE_MS),
        },
      });
      await tx.uploadChunk.deleteMany({ where: { uploadId: upload.id } });
      return Either.right(a);
    }),
  );
  if (Either.isLeft(allocResult)) {
    return Either.left(
      `project timeline cap exceeded: would end at ${allocResult.left.projEnd}s (max ${MAX_PROJECT_TIMING_SEC}s)`,
    );
  }
  return Either.right(undefined);
}

// cqt_spectrogram は Upload を持たない。失敗時は Spectrogram も failed に倒し、
// 書きかけの S3 prefix を eager に掃除する (mark は task 内で立っている)
async function executeSpectrogramTask(task: Task): Promise<void> {
  let result: Either.Either<void, string>;
  try {
    result = await runSpectrogramTask(task, TASK_GRACE_MS, TASK_SUCCESS_GRACE_MS);
  } catch (err) {
    result = Either.left(describeError(err));
  }
  if (Either.isLeft(result)) {
    const finishedAt = new Date();
    // audio/project DELETE が task/spectrogram 行ごと消すレースがあるので、
    // 行不在で throw しない updateMany にして必ず eager 掃除まで到達させる
    // (掃除し損ねても task 内で立てた spectrogramPrefix の mark を sweeper が拾う)
    await prisma.$transaction([
      prisma.task.updateMany({
        where: { id: task.id },
        data: {
          status: "failed",
          error: result.left,
          finishedAt,
          expireAt: new Date(finishedAt.getTime() + TASK_FAILURE_GRACE_MS),
        },
      }),
      prisma.spectrogram.updateMany({
        where: { id: task.id, status: "pending" },
        data: { status: "failed" },
      }),
    ]);
    if (task.audioId) {
      await eagerCleanupAndUnmark(spectrogramPrefix(task.projectId, task.audioId, task.id));
    }
  }
}

async function executeTask(taskId: string): Promise<void> {
  const claimed = await prisma.task.updateMany({
    where: { id: taskId, status: "pending" },
    data: { status: "running", startedAt: new Date() },
  });
  if (claimed.count === 0) return;

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return;
  if (task.type === "cqt_spectrogram") {
    await executeSpectrogramTask(task);
    return;
  }
  // Task.id === Upload.id 不変。Upload 不在は recovery 漏れか手動操作のみで実運用では起きない
  const upload = await prisma.upload.findUnique({ where: { id: task.id } });
  if (!upload) {
    const finishedAt = new Date();
    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: "failed",
        error: "task has no upload",
        finishedAt,
        expireAt: new Date(finishedAt.getTime() + TASK_FAILURE_GRACE_MS),
      },
    });
    return;
  }

  let result: TaskResult;
  try {
    result =
      task.type === "video_validation"
        ? await runVideoTask(task.id, upload)
        : await runAudioTask(task.id, upload);
  } catch (err) {
    result = Either.left(describeError(err));
  }

  // success は run* 内で同 tx flip + chunk 削除済み。failure もここで同 tx にする
  if (Either.isLeft(result)) {
    const finishedAt = new Date();
    await prisma.$transaction([
      prisma.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          error: result.left,
          finishedAt,
          expireAt: new Date(finishedAt.getTime() + TASK_FAILURE_GRACE_MS),
        },
      }),
      prisma.uploadChunk.deleteMany({ where: { uploadId: upload.id } }),
    ]);
  }

  // S3 prefix は eager に掃除。DB row は sweeper が expireAt で回収
  await eagerCleanupAndUnmark(uploadPrefix(upload.projectId, upload.id));
}

// dev HMR / test 横断で重複起動しないよう inflight set を global に置く
declare global {
  // eslint-disable-next-line no-var
  var __musicAnalyzerInflightTasks: Set<string> | undefined;
}
const inflight =
  globalThis.__musicAnalyzerInflightTasks ??
  (globalThis.__musicAnalyzerInflightTasks = new Set<string>());

export function enqueueTask(taskId: string): void {
  if (inflight.has(taskId)) return;
  inflight.add(taskId);
  void (async () => {
    try {
      await executeTask(taskId);
    } catch (err) {
      // executeTask が claim 前 (pending のまま) でも claim 後 (running) でも
      // throw しうる。どちらも failed に倒さないと UI が永遠 polling する
      const finishedAt = new Date();
      await prisma.task
        .updateMany({
          where: { id: taskId, status: { in: ["pending", "running"] } },
          data: {
            status: "failed",
            error: describeError(err),
            finishedAt,
            expireAt: new Date(finishedAt.getTime() + TASK_FAILURE_GRACE_MS),
          },
        })
        .catch(() => {
          /* DB 自体が死亡なら recovery 任せ */
        });
      await prisma.spectrogram
        .updateMany({
          where: { id: taskId, status: "pending" },
          data: { status: "failed" },
        })
        .catch(() => {});
    } finally {
      inflight.delete(taskId);
    }
  })();
}

export async function waitForInflightTasks(): Promise<void> {
  while (inflight.size > 0) await Bun.sleep(20);
}

// running 残骸を failed に倒し (関連 chunk 行も同時に削除)、pending を再 enqueue。
// 再 enqueue 前に mark を引き直して sweeper との race を避ける
export async function recoverTasksOnStartup(): Promise<void> {
  const orphaned = await prisma.task.findMany({
    where: { status: "running" },
    select: { id: true },
  });
  if (orphaned.length > 0) {
    const orphanedIds = orphaned.map((t) => t.id);
    const finishedAt = new Date();
    await prisma.$transaction([
      prisma.task.updateMany({
        where: { id: { in: orphanedIds } },
        data: {
          status: "failed",
          error: "process restarted during task",
          finishedAt,
          expireAt: new Date(finishedAt.getTime() + TASK_FAILURE_GRACE_MS),
        },
      }),
      prisma.uploadChunk.deleteMany({ where: { uploadId: { in: orphanedIds } } }),
      prisma.spectrogram.updateMany({
        where: { id: { in: orphanedIds }, status: "pending" },
        data: { status: "failed" },
      }),
    ]);
    console.error(`task-runner: marked ${orphaned.length} orphaned tasks as failed`);
  }
  const pending = await prisma.task.findMany({
    where: { status: "pending" },
    select: { id: true, projectId: true, type: true, audioId: true },
  });
  const refreshAt = new Date(Date.now() + TASK_GRACE_MS);
  for (const t of pending) {
    const prefix =
      t.type === "cqt_spectrogram"
        ? t.audioId && spectrogramPrefix(t.projectId, t.audioId, t.id)
        : uploadPrefix(t.projectId, t.id);
    if (prefix) {
      await prisma.deletionMark.updateMany({
        where: { prefix },
        data: { nextRetryAt: refreshAt },
      });
    }
    enqueueTask(t.id);
  }
}
