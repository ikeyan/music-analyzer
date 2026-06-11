import type { MaybeYield } from "./cqt";

// CQT spectrogram のタイル layout と解析パラメータ導出。
// S3 上の構造: meta.json + tiles/h{harmonic}/{level}/{index}.bin
// タイルは frame-major の Uint8 (frames × bins)、level L は L-1 を time 方向に 2:1 max-pool

export const SPECTROGRAM_DB_MIN = -80;
export const SPECTROGRAM_DB_MAX = 0;
export const SPECTROGRAM_TILE_FRAMES = 2048;
// 最上位 bin (fmin * 2^octaves * max(harmonics)) の許容上限。decode fs の Nyquist を保証する
export const MAX_SPECTROGRAM_FMAX_HZ = 20000;
// fminHz * harmonic の解析下限。窓長が極端に伸びるのを防ぐ
export const MIN_SPECTROGRAM_FMIN_HZ = 8;
export const MAX_SPECTROGRAM_BINS = 512;
export const MAX_SPECTROGRAM_HARMONICS = 8;
// level0 の frame 数上限 (~2^18)。長尺でも 1 harmonic あたり数十 MB に収める
export const MAX_SPECTROGRAM_FRAMES = 1 << 18;
// 1 task が同時に保持するバッファの概算ピーク上限。decode 前に見積もって拒否する
export const MAX_ANALYSIS_BYTES = 768 << 20;
// 1 task の直接相関 tap 反復の上限 (~0.5-1G/s なので数分相当)。低周波 × 高 bins で
// カーネルが極端に伸びる組み合わせが直列 queue を長時間占有するのを防ぐ
export const MAX_ANALYSIS_OPS = 150e9;

export type SpectrogramMeta = {
  version: 1;
  binsPerOctave: number;
  octaves: number;
  fminHz: number;
  harmonics: number[];
  sampleRate: number;
  hop: number;
  frames: number;
  bins: number;
  tileFrames: number;
  levels: number;
  dbMin: number;
  dbMax: number;
  durationSec: number;
};

export function parseHarmonics(json: string): number[] {
  const parsed: unknown = JSON.parse(json);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((h) => typeof h === "number" && Number.isInteger(h) && h >= 1)
  ) {
    throw new Error(`invalid harmonics: ${json}`);
  }
  return parsed as number[];
}

export function analysisSampleRate(fmaxHz: number): number {
  return Math.min(48000, Math.max(3000, Math.ceil(fmaxHz * 2.56)));
}

// hop は 2 冪: octave 整列 (2^(octaves-1) の倍数) と frame 数上限を同時に満たす
export function chooseHop(sampleRate: number, octaves: number, samples: number): number {
  const e = Math.max(
    octaves - 1,
    Math.round(Math.log2(sampleRate / 100)),
    Math.ceil(Math.log2(Math.max(1, samples) / MAX_SPECTROGRAM_FRAMES)),
  );
  return 2 ** e;
}

// PCM (downsample 中間込みで ×1.5) + Float32 magnitudes + Uint8 level0/pyramid (< ×3)
export function estimateAnalysisBytes(samples: number, hop: number, bins: number): number {
  const frames = Math.floor(samples / hop) + 1;
  return Math.round(4 * samples * 1.5 + 4 * frames * bins + 3 * frames * bins);
}

export type PyramidLevel = {
  frames: number;
  /** frame-major (frames × bins) */
  data: Uint8Array<ArrayBuffer>;
};

export function levelCount(frames: number, tileFrames = SPECTROGRAM_TILE_FRAMES): number {
  let levels = 1;
  let f = frames;
  while (f > tileFrames) {
    f = Math.ceil(f / 2);
    levels++;
  }
  return levels;
}

const PYRAMID_FRAME_SLICE = 4096;

export async function buildPyramid(
  level0: Uint8Array<ArrayBuffer>,
  frames: number,
  bins: number,
  tileFrames = SPECTROGRAM_TILE_FRAMES,
  maybeYield?: MaybeYield,
): Promise<PyramidLevel[]> {
  const levels: PyramidLevel[] = [{ frames, data: level0 }];
  let prev = levels[0]!;
  while (prev.frames > tileFrames) {
    const nextFrames = Math.ceil(prev.frames / 2);
    const next = new Uint8Array(nextFrames * bins);
    for (let i0 = 0; i0 < nextFrames; i0 += PYRAMID_FRAME_SLICE) {
      const i1 = Math.min(nextFrames, i0 + PYRAMID_FRAME_SLICE);
      for (let i = i0; i < i1; i++) {
        const a = 2 * i;
        const b = Math.min(2 * i + 1, prev.frames - 1);
        for (let k = 0; k < bins; k++) {
          next[i * bins + k] = Math.max(prev.data[a * bins + k]!, prev.data[b * bins + k]!);
        }
      }
      if (maybeYield) await maybeYield();
    }
    prev = { frames: nextFrames, data: next };
    levels.push(prev);
  }
  return levels;
}

export function tileCount(frames: number, tileFrames = SPECTROGRAM_TILE_FRAMES): number {
  return Math.max(1, Math.ceil(frames / tileFrames));
}

// frame-major なのでタイルは連続領域の subarray
export function sliceTile(
  level: PyramidLevel,
  bins: number,
  index: number,
  tileFrames = SPECTROGRAM_TILE_FRAMES,
): Uint8Array<ArrayBuffer> {
  const start = index * tileFrames;
  const end = Math.min(start + tileFrames, level.frames);
  return level.data.subarray(start * bins, end * bins);
}
