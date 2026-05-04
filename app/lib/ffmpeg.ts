import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_DURATION_SEC = 3600;
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
  const durationSec = Number(json.format?.duration ?? 0);
  return {
    durationSec,
    formatName: json.format?.format_name ?? "",
    sizeBytes: Number(json.format?.size ?? 0),
    videoStream:
      v && v.width && v.height
        ? {
            width: v.width,
            height: v.height,
            fps: parseFps(v.avg_frame_rate ?? v.r_frame_rate ?? "0/1"),
            codec: v.codec_name ?? "",
            bitrate: v.bit_rate ? Number(v.bit_rate) : null,
          }
        : null,
    audioStream: a
      ? {
          sampleRate: Number(a.sample_rate ?? 0),
          channels: a.channels ?? 0,
          codec: a.codec_name ?? "",
          bitrate: a.bit_rate ? Number(a.bit_rate) : null,
        }
      : null,
  };
}

function parseFps(rate: string): number {
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return 0;
  return num / den;
}

async function runFfmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg failed (exit ${exitCode}): ${stderr.slice(0, 1000)}`);
  }
}

// 1080p / 60fps / 8Mbps / yuv420p / H.264+AAC stereo 48kHzへ正規化
export async function transcodeVideo(input: string, output: string): Promise<void> {
  await runFfmpeg([
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
  ]);
}

export async function extractAudio(input: string, output: string): Promise<void> {
  await runFfmpeg([
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
  ]);
}

export type ThumbnailFile = {
  atSec: number;
  path: string;
  width: number;
  height: number;
};

// 0,10,20,...秒のサムネイルをoutDirへ出力。ファイル名はthumb-000010.jpg
export async function extractThumbnails(
  input: string,
  outDir: string,
  durationSec: number,
  videoWidth: number,
  videoHeight: number,
): Promise<ThumbnailFile[]> {
  await mkdir(outDir, { recursive: true });
  const fps = 1 / THUMBNAIL_INTERVAL_SEC;
  await runFfmpeg([
    "-i",
    input,
    "-vf",
    `fps=${fps},scale=${THUMBNAIL_WIDTH}:-2`,
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

export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
