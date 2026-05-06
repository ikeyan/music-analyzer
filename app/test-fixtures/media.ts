// ffmpeg 統合テスト用の小さな fixture media を temp に生成する。
// プロセス内で1度だけ生成 (cache) し、複数の test file から参照できる
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";

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

async function runFfmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg fixture generation failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
  }
}

export async function ensureMediaFixture(): Promise<MediaFixture> {
  if (cache) return cache;
  const dir = await mkdtemp(join(tmpdir(), "music-analyzer-test-media-"));
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
