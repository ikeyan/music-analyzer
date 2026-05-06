// ffmpeg 統合テスト用の小さな fixture media を temp に生成する。
// プロセス内で1度だけ生成 (lazy cache) して、複数の test file から useMediaFixture() で参照する
import { $ } from "bun";
import { beforeAll } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const STARTUP_TIMEOUT_MS = 30_000;

export type MediaFixture = {
  /** 11秒の H.264 + AAC mp4 (映像 + 音声)。10s 間隔のサムネイルテストで 2枚出るよう少し長め */
  videoMp4: string;
  /** 11秒の H.264 mp4 (音声なし) — 画面録画系のシナリオ */
  silentMp4: string;
  /** 1秒の MP3 (音声単独) */
  audioMp3: string;
  /** 1秒の WAV (PCM s16le、音声単独) */
  audioWav: string;
  /** ffprobe が parse 失敗する非 media ファイル */
  corruptFile: string;
};

let cache: MediaFixture | null = null;
let initPromise: Promise<MediaFixture> | null = null;

async function runFfmpeg(args: string[]): Promise<void> {
  const result = await $`${FFMPEG} -hide_banner -loglevel error -y ${args}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `ffmpeg fixture generation failed (exit ${result.exitCode}): ${result.stderr.toString().slice(0, 500)}`,
    );
  }
}

async function init(): Promise<MediaFixture> {
  const dir = await mkdtemp(join(tmpdir(), "music-analyzer-test-media-"));
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* exit handler では throw できない */
    }
  });

  const videoMp4 = join(dir, "video.mp4");
  const silentMp4 = join(dir, "silent.mp4");
  const audioMp3 = join(dir, "audio.mp3");
  const audioWav = join(dir, "audio.wav");
  const corruptFile = join(dir, "corrupt.bin");

  // 青色映像 + 440Hz サイン波 11秒。preset ultrafast で高速生成
  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x240:r=30:d=11",
    "-f",
    "lavfi",
    "-i",
    "sine=f=440:d=11",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    videoMp4,
  ]);

  // 赤色映像 11秒、音声なし
  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x240:r=30:d=11",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    silentMp4,
  ]);

  await runFfmpeg(["-f", "lavfi", "-i", "sine=f=440:d=1", "-c:a", "libmp3lame", audioMp3]);
  await runFfmpeg(["-f", "lavfi", "-i", "sine=f=440:d=1", "-c:a", "pcm_s16le", audioWav]);
  await writeFile(corruptFile, "this is not media data\n");

  cache = { videoMp4, silentMp4, audioMp3, audioWav, corruptFile };
  return cache;
}

async function ensureMediaFixture(): Promise<MediaFixture> {
  if (!initPromise) initPromise = init();
  return await initPromise;
}

// media を使う test ファイルが先頭で1回呼ぶ。返り値の getter で fixture path を取る
export function useMediaFixture(): () => MediaFixture {
  beforeAll(async () => {
    await ensureMediaFixture();
  }, STARTUP_TIMEOUT_MS);
  return () => {
    if (!cache) throw new Error("useMediaFixture: not initialized (beforeAll not run yet)");
    return cache;
  };
}
