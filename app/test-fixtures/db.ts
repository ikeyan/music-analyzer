import { beforeAll, beforeEach } from "bun:test";
import assert from "node:assert";
import { prisma } from "../lib/prisma";

// FK 順: thumbnail → video, audio, task → upload → uploadChunk, deletionMark → project → user
export async function clearDb(): Promise<void> {
  await prisma.thumbnail.deleteMany();
  await prisma.video.deleteMany();
  await prisma.audio.deleteMany();
  await prisma.task.deleteMany();
  await prisma.uploadChunk.deleteMany();
  await prisma.upload.deleteMany();
  await prisma.deletionMark.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();
}

// prisma を使う test は先頭で1回呼ぶ。beforeEach(clearDb) が自動で入る
export function useDbFixture(): void {
  beforeAll(() => {
    assert(
      process.env.DATABASE_URL?.startsWith("file:"),
      "useDbFixture: DATABASE_URL not set. Run via `bun test` so bunfig preload runs.",
    );
  });
  beforeEach(clearDb);
}
