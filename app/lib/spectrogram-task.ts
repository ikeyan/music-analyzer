import { Either } from "effect";
import { join } from "node:path";
import type { Task } from "../generated/prisma/client";
import { computeCqt, estimateCqtOps, magnitudesToU8, makeCooperativeYield } from "./cqt";
import { decodeAudioPcm } from "./ffmpeg";
import { markPrefixForDeletion } from "./gc";
import { prisma } from "./prisma";
import { getS3 } from "./s3";
import {
  MAX_ANALYSIS_BYTES,
  MAX_ANALYSIS_OPS,
  SPECTROGRAM_DB_MAX,
  SPECTROGRAM_DB_MIN,
  SPECTROGRAM_TILE_FRAMES,
  type SpectrogramMeta,
  analysisSampleRate,
  buildPyramid,
  chooseHop,
  estimateAnalysisBytes,
  parseHarmonics,
  sliceTile,
  tileCount,
} from "./spectrogram";
import { spectrogramMetaKey, spectrogramPrefix, spectrogramTileKey, uploadBytes } from "./storage";
import { tempDir } from "./temp-dir";

const UPLOAD_CONCURRENCY = 16;

async function runPool(jobs: (() => Promise<void>)[], concurrency: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      await job();
    }
  });
  const results = await Promise.allSettled(workers);
  const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} tile uploads failed`);
  }
}

// executeTask の TASK_GRACE_MS と同じ猶予で S3 prefix を守る (循環 import 回避で値を直書きしない)
export async function runSpectrogramTask(
  task: Task,
  graceMs: number,
  successGraceMs: number,
): Promise<Either.Either<void, string>> {
  const spec = await prisma.spectrogram.findUnique({
    where: { id: task.id },
    include: { audio: true },
  });
  if (!spec) return Either.left("spectrogram row not found");
  const audio = spec.audio;
  const harmonics = parseHarmonics(spec.harmonics);

  const fmaxHz = spec.fminHz * 2 ** spec.octaves * Math.max(...harmonics);
  const sampleRate = analysisSampleRate(fmaxHz);
  const bins = spec.binsPerOctave * spec.octaves;
  // decode 前に PCM + magnitudes + タイル列の合計ピークを見積もってゲートする
  const estSamples = Math.ceil(sampleRate * audio.durationSec);
  const estHop = chooseHop(sampleRate, spec.octaves, estSamples);
  const estBytes = estimateAnalysisBytes(estSamples, estHop, bins);
  if (estBytes > MAX_ANALYSIS_BYTES) {
    return Either.left(
      `estimated analysis memory ${Math.round(estBytes / 2 ** 20)}MB exceeds budget ` +
        `${MAX_ANALYSIS_BYTES / 2 ** 20}MB. Reduce octaves / fmin / binsPerOctave / harmonics.`,
    );
  }
  // 低周波 × 高 bins はカーネルが伸びて演算量が爆発するので compute 予算でもゲートする
  let estOps = 0;
  for (const h of harmonics) {
    estOps += estimateCqtOps(estSamples, {
      sampleRate,
      binsPerOctave: spec.binsPerOctave,
      octaves: spec.octaves,
      fminHz: spec.fminHz * h,
      hop: estHop,
    });
  }
  if (estOps > MAX_ANALYSIS_OPS) {
    return Either.left(
      `estimated compute ${Math.round(estOps / 1e9)}G ops exceeds budget ` +
        `${MAX_ANALYSIS_OPS / 1e9}G. Reduce binsPerOctave / duration or raise fmin.`,
    );
  }

  await using td = await tempDir("cqt-task");
  const inputPath = join(td.path, "audio.m4a");
  await Bun.write(inputPath, getS3().file(audio.audioKey));
  const samples = await decodeAudioPcm(inputPath, sampleRate);
  if (samples.length === 0) return Either.left("decoded audio is empty");

  const hop = chooseHop(sampleRate, spec.octaves, samples.length);

  const prefix = spectrogramPrefix(audio.projectId, audio.id, spec.id);
  await markPrefixForDeletion(prefix, graceMs);

  let frames = 0;
  let levels = 0;
  // DSP は in-process で走るので、協調 yield で event loop を塞がないようにする
  const maybeYield = makeCooperativeYield();
  for (const h of harmonics) {
    const result = await computeCqt(
      samples,
      {
        sampleRate,
        binsPerOctave: spec.binsPerOctave,
        octaves: spec.octaves,
        fminHz: spec.fminHz * h,
        hop,
      },
      maybeYield,
    );
    frames = result.frames;
    const pyramid = await buildPyramid(
      await magnitudesToU8(result.magnitudes, SPECTROGRAM_DB_MIN, SPECTROGRAM_DB_MAX, maybeYield),
      result.frames,
      bins,
      SPECTROGRAM_TILE_FRAMES,
      maybeYield,
    );
    levels = pyramid.length;
    const jobs: (() => Promise<void>)[] = [];
    for (const [level, levelData] of pyramid.entries()) {
      for (let i = 0; i < tileCount(levelData.frames); i++) {
        const tile = sliceTile(levelData, bins, i);
        jobs.push(() =>
          uploadBytes(
            spectrogramTileKey(audio.projectId, audio.id, spec.id, h, level, i),
            tile,
            "application/octet-stream",
          ),
        );
      }
    }
    await runPool(jobs, UPLOAD_CONCURRENCY);
  }

  const meta: SpectrogramMeta = {
    version: 1,
    binsPerOctave: spec.binsPerOctave,
    octaves: spec.octaves,
    fminHz: spec.fminHz,
    harmonics,
    sampleRate,
    hop,
    frames,
    bins,
    tileFrames: SPECTROGRAM_TILE_FRAMES,
    levels,
    dbMin: SPECTROGRAM_DB_MIN,
    dbMax: SPECTROGRAM_DB_MAX,
    durationSec: samples.length / sampleRate,
  };
  await uploadBytes(
    spectrogramMetaKey(audio.projectId, audio.id, spec.id),
    new TextEncoder().encode(JSON.stringify(meta)),
    "application/json",
  );

  // task→succeeded と spectrogram→ready は同 tx 必須 (中間状態で recovery が failed に倒す)
  const finishedAt = new Date();
  await prisma.$transaction([
    prisma.spectrogram.update({ where: { id: spec.id }, data: { status: "ready" } }),
    prisma.deletionMark.deleteMany({ where: { prefix } }),
    prisma.task.update({
      where: { id: task.id },
      data: {
        status: "succeeded",
        finishedAt,
        audioId: audio.id,
        expireAt: new Date(finishedAt.getTime() + successGraceMs),
      },
    }),
  ]);
  return Either.right(undefined);
}
