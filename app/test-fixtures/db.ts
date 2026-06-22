import { beforeAll, beforeEach } from "bun:test";
import assert from "node:assert";
import { prisma } from "../lib/prisma";
import { waitForInflightTasks } from "../lib/task-runner";

// FK 順: thumbnail → video, spectrogram → audio, task → upload → uploadChunk, deletionMark → project → user
export async function clearDb(): Promise<void> {
  await prisma.thumbnail.deleteMany();
  await prisma.video.deleteMany();
  await prisma.spectrogram.deleteMany();
  await prisma.audio.deleteMany();
  await prisma.task.deleteMany();
  await prisma.uploadChunk.deleteMany();
  await prisma.upload.deleteMany();
  await prisma.deletionMark.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();
}

// prisma を使う test は先頭で1回呼ぶ。beforeEach で clearDb が自動で入る
export function useDbFixture(): void {
  beforeAll(() => {
    assert(
      process.env.DATABASE_URL?.startsWith("file:"),
      "useDbFixture: DATABASE_URL not set. Run via `bun test` so bunfig preload runs.",
    );
  });
  // clearDb の前に inflight task を drain する。test が waitForInflightTasks を呼び忘れても、
  // 走行中の task が消えた行を触って異常終了したり次の test と race するのを防ぐ (idle なら即 return)
  beforeEach(async () => {
    await waitForInflightTasks();
    await clearDb();
  });
}
