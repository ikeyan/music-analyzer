// bunfig.toml の preload (db-preload.ts) で temp DB と schema は process 単位で
// 1度だけセットされる。ここでは bun:test の lifecycle hook に乗せて、テスト
// ファイルが先頭で useDbFixture() を呼ぶだけで beforeEach (clearDb) が
// 自動で入るようにする (prisma を使うテストは必ず空 DB から始まる契約)
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

export function useDbFixture(): void {
  beforeAll(() => {
    if (!process.env.DATABASE_URL?.startsWith("file:")) {
      throw new Error(
        "useDbFixture: DATABASE_URL not set. Run via `bun test` so bunfig preload runs.",
      );
    }
  });
  beforeEach(clearDb);
}
