// Constant-Q Transform。最上位オクターブのカーネルだけ設計し、信号を 1/2 ずつ
// 再帰的にダウンサンプルして全オクターブに同一カーネルを適用する (librosa と同方式)。
// 正規化周波数 f/fs がオクターブごとに不変なのでカーネルを共有できる

export type CqtParams = {
  sampleRate: number;
  binsPerOctave: number;
  octaves: number;
  /** 最下位 bin の中心周波数 (Hz) */
  fminHz: number;
  /** sampleRate 基準の hop。2^(octaves-1) の倍数であること */
  hop: number;
};

export type CqtResult = {
  /** frame-major: magnitudes[frame * bins + bin], bin 0 が最低周波数 */
  magnitudes: Float32Array<ArrayBuffer>;
  frames: number;
  bins: number;
};

type Kernel = {
  /** bin ごとの窓掛け複素指数 (実部/虚部) */
  re: Float32Array<ArrayBuffer>[];
  im: Float32Array<ArrayBuffer>[];
  /** 振幅 1 の正弦波が振幅 ~1 で出るよう 2/sum(window) */
  norm: number[];
};

export function cqtBinFrequency(fminHz: number, binsPerOctave: number, bin: number): number {
  return fminHz * 2 ** (bin / binsPerOctave);
}

// 最上位オクターブ (bin = (octaves-1)*B .. octaves*B-1) 用のカーネル
function designTopOctaveKernel(p: CqtParams): Kernel {
  const B = p.binsPerOctave;
  const q = 1 / (2 ** (1 / B) - 1);
  const re: Float32Array<ArrayBuffer>[] = [];
  const im: Float32Array<ArrayBuffer>[] = [];
  const norm: number[] = [];
  for (let k = 0; k < B; k++) {
    const f = cqtBinFrequency(p.fminHz, B, (p.octaves - 1) * B + k);
    const n = Math.max(2, Math.round((q * p.sampleRate) / f));
    const wRe = new Float32Array(n);
    const wIm = new Float32Array(n);
    let wSum = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      const phase = (2 * Math.PI * f * (i - (n - 1) / 2)) / p.sampleRate;
      wRe[i] = w * Math.cos(phase);
      wIm[i] = -w * Math.sin(phase);
      wSum += w;
    }
    re.push(wRe);
    im.push(wIm);
    norm.push(2 / wSum);
  }
  return { re, im, norm };
}

// 半帯域 FIR (windowed sinc, 47 tap) + 1/2 間引き。y[m] ≈ lowpass(x)[2m]
const HALFBAND_TAPS = 47;
const halfbandFir: Float32Array<ArrayBuffer> = (() => {
  const h = new Float32Array(HALFBAND_TAPS);
  const c = (HALFBAND_TAPS - 1) / 2;
  let sum = 0;
  for (let i = 0; i < HALFBAND_TAPS; i++) {
    const t = i - c;
    const sinc = t === 0 ? 0.5 : Math.sin(0.5 * Math.PI * t) / (Math.PI * t);
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (HALFBAND_TAPS - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (HALFBAND_TAPS - 1));
    h[i] = sinc * w;
    sum += h[i]!;
  }
  for (let i = 0; i < HALFBAND_TAPS; i++) h[i] = h[i]! / sum;
  return h;
})();

export function downsample2(x: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const outLen = Math.ceil(x.length / 2);
  const y = new Float32Array(outLen);
  const c = (HALFBAND_TAPS - 1) / 2;
  for (let m = 0; m < outLen; m++) {
    const base = 2 * m - c;
    const lo = Math.max(0, -base);
    const hi = Math.min(HALFBAND_TAPS, x.length - base);
    let acc = 0;
    for (let t = lo; t < hi; t++) acc += halfbandFir[t]! * x[base + t]!;
    y[m] = acc;
  }
  return y;
}

// 1 オクターブ分の直接相関。frame i の窓中心は signal[i * hop]
function correlateOctave(
  signal: Float32Array<ArrayBuffer>,
  hop: number,
  frames: number,
  kernel: Kernel,
  out: Float32Array<ArrayBuffer>,
  bins: number,
  binOffset: number,
): void {
  const B = kernel.re.length;
  for (let k = 0; k < B; k++) {
    const kr = kernel.re[k]!;
    const ki = kernel.im[k]!;
    const n = kr.length;
    const half = n >> 1;
    const norm = kernel.norm[k]!;
    for (let i = 0; i < frames; i++) {
      const start = i * hop - half;
      const lo = Math.max(0, -start);
      const hi = Math.min(n, signal.length - start);
      let accRe = 0;
      let accIm = 0;
      for (let t = lo; t < hi; t++) {
        const s = signal[start + t]!;
        accRe += kr[t]! * s;
        accIm += ki[t]! * s;
      }
      out[i * bins + binOffset + k] = Math.sqrt(accRe * accRe + accIm * accIm) * norm;
    }
  }
}

export function computeCqt(samples: Float32Array<ArrayBuffer>, p: CqtParams): CqtResult {
  if (p.hop % 2 ** (p.octaves - 1) !== 0) {
    throw new Error(`cqt: hop ${p.hop} must be divisible by 2^(octaves-1)`);
  }
  const bins = p.binsPerOctave * p.octaves;
  const frames = Math.max(1, Math.floor(samples.length / p.hop) + 1);
  const out = new Float32Array(frames * bins);
  const kernel = designTopOctaveKernel(p);
  let signal = samples;
  let hop = p.hop;
  for (let o = 0; o < p.octaves; o++) {
    correlateOctave(signal, hop, frames, kernel, out, bins, (p.octaves - 1 - o) * p.binsPerOctave);
    if (o + 1 < p.octaves) {
      signal = downsample2(signal);
      hop >>= 1;
    }
  }
  return { magnitudes: out, frames, bins };
}

// dB スケール [dbMin, dbMax] → Uint8 [0, 255]
export function magnitudesToU8(
  mags: Float32Array<ArrayBuffer>,
  dbMin: number,
  dbMax: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(mags.length);
  const scale = 255 / (dbMax - dbMin);
  for (let i = 0; i < mags.length; i++) {
    const db = 20 * Math.log10(Math.max(mags[i]!, 1e-10));
    out[i] = Math.max(0, Math.min(255, Math.round((db - dbMin) * scale)));
  }
  return out;
}
