import { addAbortListener } from "node:events";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

export const MAX_DURATION_SEC = 3600;
// 1h@~17Mbps 相当。仕様 (1080p/8Mbps 出力) に十分余裕
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;
// TimeRuler tick 上限と整合する project timeline 全長
export const MAX_PROJECT_TIMING_SEC = 24 * 60 * 60;
export const THUMBNAIL_INTERVAL_SEC = 10;
export const THUMBNAIL_WIDTH = 320;

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

export type ProbeResult = {
  durationSec: number;
  videoStream: ProbeVideoStream | null;
  audioStream: ProbeAudioStream | null;
  formatName: string;
  sizeBytes: number;
};

export type ProbeVideoStream = {
  width: number;
  height: number;
  fps: number;
  codec: string;
  bitrate: number | null;
};

export type ProbeAudioStream = {
  sampleRate: number;
  channels: number;
  codec: string;
  bitrate: number | null;
};

type FfprobeJson = {
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    sample_rate?: string;
    channels?: number;
    bit_rate?: string;
    avg_frame_rate?: string;
    r_frame_rate?: string;
  }[];
  format?: {
    duration?: string;
    bit_rate?: string;
    size?: string;
    format_name?: string;
  };
};

export async function ffprobe(path: string): Promise<ProbeResult> {
  const proc = Bun.spawn(
    [FFPROBE, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`ffprobe failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
  }
  const json = JSON.parse(stdout) as FfprobeJson;
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  return {
    durationSec: parseFiniteNumber(json.format?.duration) ?? Number.NaN,
    formatName: json.format?.format_name ?? "",
    sizeBytes: parseFiniteNumber(json.format?.size) ?? 0,
    videoStream:
      v && v.width && v.height
        ? {
            width: v.width,
            height: v.height,
            fps: parseFps(v.avg_frame_rate ?? v.r_frame_rate ?? "0/1"),
            codec: v.codec_name ?? "",
            bitrate: parseFiniteNumber(v.bit_rate),
          }
        : null,
    audioStream: a
      ? {
          sampleRate: parseFiniteNumber(a.sample_rate) ?? 0,
          channels: a.channels ?? 0,
          codec: a.codec_name ?? "",
          bitrate: parseFiniteNumber(a.bit_rate),
        }
      : null,
  };
}

// ffprobe は値が取れないと "N/A" や undefined を返すので Number() で NaN になりうる。
// Prisma の Int 列に NaN を持ち込まないため、有限数だけ通して残りは null にする
export function parseFiniteNumber(value: string | undefined | null): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseFps(rate: string): number {
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return 0;
  return num / den;
}

async function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("ffmpeg aborted before start");
  const proc = Bun.spawn([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  using _abort = signal ? addAbortListener(signal, () => proc.kill()) : null;
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (signal?.aborted) throw new Error("ffmpeg aborted");
  if (exitCode !== 0) {
    throw new Error(`ffmpeg failed (exit ${exitCode}): ${stderr.slice(0, 1000)}`);
  }
}

// 1080p / 60fps / 8Mbps / yuv420p / H.264+AAC stereo 48kHzへ正規化
export async function transcodeVideo(
  input: string,
  output: string,
  hasAudio: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const audioArgs = hasAudio
    ? ["-c:a", "aac", "-profile:a", "aac_low", "-ar", "48000", "-ac", "2", "-b:a", "192k"]
    : ["-an"];
  await runFfmpeg(
    [
      "-i",
      input,
      "-vf",
      "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
      "-fpsmax",
      "60",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-b:v",
      "8M",
      "-maxrate",
      "8M",
      "-bufsize",
      "16M",
      "-pix_fmt",
      "yuv420p",
      ...audioArgs,
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      output,
    ],
    signal,
  );
}

export async function extractAudio(
  input: string,
  output: string,
  signal?: AbortSignal,
): Promise<void> {
  await runFfmpeg(
    [
      "-i",
      input,
      "-vn",
      "-c:a",
      "aac",
      "-profile:a",
      "aac_low",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      output,
    ],
    signal,
  );
}

export const transcodeAudio = extractAudio;

// HTMLMediaElement が再生しうる codec / container の許容セット
const BROWSER_AUDIO_CODECS = new Set([
  "aac",
  "mp3",
  "opus",
  "vorbis",
  "flac",
  "pcm_s16le",
  "pcm_s24le",
  "pcm_s32le",
  "pcm_f32le",
  "pcm_f64le",
  "pcm_s16be",
  "pcm_s24be",
]);
const BROWSER_AUDIO_FORMAT_TOKENS = ["mp3", "mp4", "m4a", "ogg", "flac", "wav", "webm", "matroska"];

export function isBrowserPlayableAudio(codec: string, formatName: string): boolean {
  if (!BROWSER_AUDIO_CODECS.has(codec)) return false;
  return formatName.split(",").some((t) => BROWSER_AUDIO_FORMAT_TOKENS.includes(t.trim()));
}

export type ThumbnailFile = {
  atSec: number;
  path: string;
  width: number;
  height: number;
};

// 0, 10, 20... 秒のサムネイルを outDir/thumb-NNNNNN.jpg に出力する
export async function extractThumbnails(
  input: string,
  outDir: string,
  durationSec: number,
  videoWidth: number,
  videoHeight: number,
): Promise<ThumbnailFile[]> {
  await mkdir(outDir, { recursive: true });
  // 1枚目はt=0、以降は前回選択から THUMBNAIL_INTERVAL_SEC 秒以上経った
  // 最初のフレームを取る。fps filter は midpoint からサンプリングするので
  // 短い動画で t=0 の最初のサムネが落ちることがあった。
  // mjpeg encoder は full-range YUV (yuvj420p) を要求するので明示変換する
  const select = `isnan(prev_selected_t)+gte(t-prev_selected_t\\,${THUMBNAIL_INTERVAL_SEC})`;
  await runFfmpeg([
    "-i",
    input,
    "-vf",
    `select=${select},scale=${THUMBNAIL_WIDTH}:-2,format=yuvj420p`,
    "-vsync",
    "vfr",
    "-q:v",
    "5",
    "-f",
    "image2",
    join(outDir, "thumb-%06d.jpg"),
  ]);
  const entries = (await readdir(outDir)).filter((n) => n.startsWith("thumb-")).toSorted();
  const ratio = videoHeight / videoWidth;
  const w = THUMBNAIL_WIDTH;
  const h = Math.max(2, Math.round((w * ratio) / 2) * 2);
  return entries
    .map((name, i) => ({
      atSec: i * THUMBNAIL_INTERVAL_SEC,
      path: join(outDir, name),
      width: w,
      height: h,
    }))
    .filter((t) => t.atSec <= durationSec);
}
