import { Either } from "effect";
import { join } from "node:path";
import type { Task } from "../generated/prisma/client";
import { makeCooperativeYield } from "./cqt";
import { decodeAudioPcm } from "./ffmpeg";
import { markPrefixForDeletion } from "./gc";
import {
  MAX_NOTE_ANALYSIS_OPS,
  NOTE_BINS,
  NOTE_HOP,
  NOTE_SAMPLE_RATE,
  estimateNoteOps,
  estimateNotes,
  noteModel,
} from "./note-estimation";
import { prisma } from "./prisma";
import { getS3 } from "./s3";
import { MAX_ANALYSIS_BYTES } from "./spectrogram";
import { noteEstimationNotesKey, noteEstimationPrefix, uploadBytes } from "./storage";
import { tempDir } from "./temp-dir";

// PCM (downsample 中間込み ×1.5) + harmonic plane u8 + 確率 map float32 ×2 + 推論 chunk 分
function estimateNoteBytes(samples: number): number {
  const frames = Math.floor(samples / NOTE_HOP) + 1;
  const planes = noteModel.input.harmonics.length;
  return Math.round(4 * samples * 1.5 + frames * NOTE_BINS * (planes + 8) + 4 * frames * NOTE_BINS);
}

export async function runNoteEstimationTask(
  task: Task,
  graceMs: number,
  successGraceMs: number,
): Promise<Either.Either<void, string>> {
  const est = await prisma.noteEstimation.findUnique({
    where: { id: task.id },
    include: { audio: true },
  });
  if (!est) return Either.left("note estimation row not found");
  const audio = est.audio;

  const estSamples = Math.ceil(NOTE_SAMPLE_RATE * audio.durationSec);
  const estBytes = estimateNoteBytes(estSamples);
  if (estBytes > MAX_ANALYSIS_BYTES) {
    return Either.left(
      `estimated analysis memory ${Math.round(estBytes / 2 ** 20)}MB exceeds budget ` +
        `${MAX_ANALYSIS_BYTES / 2 ** 20}MB`,
    );
  }
  const estOps = estimateNoteOps(estSamples);
  if (estOps > MAX_NOTE_ANALYSIS_OPS) {
    return Either.left(
      `estimated compute ${Math.round(estOps / 1e9)}G ops exceeds budget ` +
        `${MAX_NOTE_ANALYSIS_OPS / 1e9}G (audio too long for note estimation)`,
    );
  }

  await using td = await tempDir("note-task");
  const inputPath = join(td.path, "audio.m4a");
  await Bun.write(inputPath, getS3().file(audio.audioKey));
  const samples = await decodeAudioPcm(inputPath, NOTE_SAMPLE_RATE);
  if (samples.length === 0) return Either.left("decoded audio is empty");

  const prefix = noteEstimationPrefix(audio.projectId, audio.id, est.id);
  await markPrefixForDeletion(prefix, graceMs);

  const result = await estimateNotes(samples, makeCooperativeYield());
  await uploadBytes(
    noteEstimationNotesKey(audio.projectId, audio.id, est.id),
    new TextEncoder().encode(JSON.stringify(result)),
    "application/json",
  );

  // task→succeeded と noteEstimation→ready は同 tx 必須 (中間状態で recovery が failed に倒す)
  const finishedAt = new Date();
  await prisma.$transaction([
    prisma.noteEstimation.update({ where: { id: est.id }, data: { status: "ready" } }),
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
