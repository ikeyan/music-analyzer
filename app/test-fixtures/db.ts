// テスト DB のセットアップは bunfig.toml の preload (db-preload.ts) で済ませてあるので、
// テスト本体ではこの clearDb() を beforeEach 等で呼んでテーブルを空に戻すだけでよい
import { prisma } from "../lib/prisma";

// FK 順序: thumbnail → video, audio, deletionMark → project → user
export async function clearDb(): Promise<void> {
  await prisma.thumbnail.deleteMany();
  await prisma.video.deleteMany();
  await prisma.audio.deleteMany();
  await prisma.deletionMark.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();
}
