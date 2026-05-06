import { beforeAll, beforeEach } from "bun:test";
import { prisma } from "../lib/prisma";

// FK 順: thumbnail → video, audio, deletionMark → project → user
export async function clearDb(): Promise<void> {
  await prisma.thumbnail.deleteMany();
  await prisma.video.deleteMany();
  await prisma.audio.deleteMany();
  await prisma.deletionMark.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();
}

function assertDatabaseUrlSet(url: string | undefined): asserts url is string {
  if (!url?.startsWith("file:")) {
    throw new Error(
      "useDbFixture: DATABASE_URL not set. Run via `bun test` so bunfig preload runs.",
    );
  }
}

// prisma を使う test は先頭で1回呼ぶ。beforeEach(clearDb) が自動で入る
export function useDbFixture(): void {
  beforeAll(() => {
    assertDatabaseUrlSet(process.env.DATABASE_URL);
  });
  beforeEach(clearDb);
}
