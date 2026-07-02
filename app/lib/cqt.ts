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
  /**
   * VQT 帯域幅下限 (Hz)。窓長を n = fs/(α·f + gamma) とし、低域で窓が伸びすぎるのを抑える
   * (α = 2^(1/B)-1)。0 (既定) なら純 constant-Q。autoGamma(binsPerOctave) が推奨値
   */
  gamma?: number;
};

// librosa 方式の VQT gamma。ERB (帯域幅 ≈ 24.7 + 0.108·f) に整合する帯域幅下限を
// binsPerOctave から導く。低域の時間分解能を上げる代わりに周波数分解能を落とす
export function autoGamma(binsPerOctave: number): number {
  const alpha = 2 ** (1 / binsPerOctave) - 1;
  return (24.7 * alpha) / 0.108;
}

export type CqtResult = {
  /** frame-major: magnitudes[frame * bins + bin], bin 0 が最低周波数 */
  magnitudes: Float32Array<ArrayBuffer>;
  frames: number;
  bins: number;
};

// 長い計算はサーバプロセス内で走るので、スライス境界で event loop に制御を返す。
// undefined なら yield なし (テスト等)
export type MaybeYield = () => Promise<void>;

export function makeCooperativeYield(intervalMs = 25): MaybeYield {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < intervalMs) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    last = performance.now();
  };
}

// 同期ホットループの 1 スライスあたりの処理量
const FRAME_SLICE = 2048;
const SAMPLE_SLICE = 1 << 16;
const QUANTIZE_SLICE = 1 << 20;

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

// octave o (0=最上位) の bin k の窓長 (tap 数)。VQT では α·f に gamma を足して低域の
// 窓長を頭打ちにする。gamma は絶対 Hz の下限なので octave ごとに実効値が 2^o 倍される
// (下位 octave ほど窓が短くなる)。gamma=0 なら全 octave で同一 = 純 constant-Q
function binTaps(p: CqtParams, gamma: number, o: number, k: number): number {
  const B = p.binsPerOctave;
  const alpha = 2 ** (1 / B) - 1;
  const f = cqtBinFrequency(p.fminHz, B, (p.octaves - 1) * B + k);
  return Math.max(2, Math.round(p.sampleRate / (alpha * f + gamma * 2 ** o)));
}

// 直接相関の概算 tap 反復回数 (実測 ~0.5-1G/s)。decode 前の compute 予算ゲート用。
// VQT では octave ごとに窓長が変わるので全 octave 分を合算する (gamma=0 なら octaves 倍と一致)
export function estimateCqtOps(samples: number, p: CqtParams): number {
  const gamma = p.gamma ?? 0;
  let kernelTaps = 0;
  for (let o = 0; o < p.octaves; o++) {
    for (let k = 0; k < p.binsPerOctave; k++) kernelTaps += binTaps(p, gamma, o, k);
  }
  const frames = Math.floor(samples / p.hop) + 1;
  return 2 * frames * kernelTaps;
}

// octave o (bin = (octaves-1-o)*B .. (octaves-o)*B-1) 用のカーネル。正規化周波数 f/fs は
// 全 octave 不変なので指数部は最上位 octave の bin 周波数をそのまま使い、窓長だけ octave で
// 変える (VQT: 下位 octave ほど短い窓 → 低域の時間分解能が上がる)
function designOctaveKernel(p: CqtParams, gamma: number, o: number): Kernel {
  const B = p.binsPerOctave;
  const re: Float32Array<ArrayBuffer>[] = [];
  const im: Float32Array<ArrayBuffer>[] = [];
  const norm: number[] = [];
  for (let k = 0; k < B; k++) {
    const f = cqtBinFrequency(p.fminHz, B, (p.octaves - 1) * B + k);
    const n = binTaps(p, gamma, o, k);
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

function downsample2Slice(
  x: Float32Array<ArrayBuffer>,
  y: Float32Array<ArrayBuffer>,
  m0: number,
  m1: number,
): void {
  const c = (HALFBAND_TAPS - 1) / 2;
  for (let m = m0; m < m1; m++) {
    const base = 2 * m - c;
    const lo = Math.max(0, -base);
    const hi = Math.min(HALFBAND_TAPS, x.length - base);
    let acc = 0;
    for (let t = lo; t < hi; t++) acc += halfbandFir[t]! * x[base + t]!;
    y[m] = acc;
  }
}

export async function downsample2(
  x: Float32Array<ArrayBuffer>,
  maybeYield?: MaybeYield,
): Promise<Float32Array<ArrayBuffer>> {
  const outLen = Math.ceil(x.length / 2);
  const y = new Float32Array(outLen);
  for (let m0 = 0; m0 < outLen; m0 += SAMPLE_SLICE) {
    downsample2Slice(x, y, m0, Math.min(outLen, m0 + SAMPLE_SLICE));
    if (maybeYield) await maybeYield();
  }
  return y;
}

// 1 bin × 1 frame スライス分の直接相関。frame i の窓中心は signal[i * hop]
function correlateBinSlice(
  signal: Float32Array<ArrayBuffer>,
  hop: number,
  kr: Float32Array<ArrayBuffer>,
  ki: Float32Array<ArrayBuffer>,
  norm: number,
  out: Float32Array<ArrayBuffer>,
  bins: number,
  outBin: number,
  f0: number,
  f1: number,
): void {
  const n = kr.length;
  const half = n >> 1;
  for (let i = f0; i < f1; i++) {
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
    out[i * bins + outBin] = Math.sqrt(accRe * accRe + accIm * accIm) * norm;
  }
}

async function correlateOctave(
  signal: Float32Array<ArrayBuffer>,
  hop: number,
  frames: number,
  kernel: Kernel,
  out: Float32Array<ArrayBuffer>,
  bins: number,
  binOffset: number,
  maybeYield?: MaybeYield,
): Promise<void> {
  const B = kernel.re.length;
  for (let k = 0; k < B; k++) {
    for (let f0 = 0; f0 < frames; f0 += FRAME_SLICE) {
      correlateBinSlice(
        signal,
        hop,
        kernel.re[k]!,
        kernel.im[k]!,
        kernel.norm[k]!,
        out,
        bins,
        binOffset + k,
        f0,
        Math.min(frames, f0 + FRAME_SLICE),
      );
      if (maybeYield) await maybeYield();
    }
  }
}

export async function computeCqt(
  samples: Float32Array<ArrayBuffer>,
  p: CqtParams,
  maybeYield?: MaybeYield,
): Promise<CqtResult> {
  if (p.hop % 2 ** (p.octaves - 1) !== 0) {
    throw new Error(`cqt: hop ${p.hop} must be divisible by 2^(octaves-1)`);
  }
  const bins = p.binsPerOctave * p.octaves;
  // 最上位 octave のカーネルを全 octave で使い回すので、最上位 bin が Nyquist 超だと
  // plane 全体が aliasing する。caller は safeCqtOctaves で octave を絞ること
  const topBinHz = cqtBinFrequency(p.fminHz, p.binsPerOctave, bins - 1);
  if (topBinHz > p.sampleRate / 2) {
    throw new Error(
      `cqt: top bin ${Math.round(topBinHz)}Hz exceeds Nyquist ${p.sampleRate / 2}Hz ` +
        `(kernel aliases every octave; clamp octaves via safeCqtOctaves)`,
    );
  }
  const frames = Math.max(1, Math.floor(samples.length / p.hop) + 1);
  const out = new Float32Array(frames * bins);
  const gamma = p.gamma ?? 0;
  // VQT では octave ごとに窓長が異なるので octave 分のカーネルを設計する
  // (gamma=0 なら全 octave 同一 = 従来の 1 カーネル使い回しと等価)
  const kernels = Array.from({ length: p.octaves }, (_, o) => designOctaveKernel(p, gamma, o));
  let signal = samples;
  let hop = p.hop;
  for (let o = 0; o < p.octaves; o++) {
    await correlateOctave(
      signal,
      hop,
      frames,
      kernels[o]!,
      out,
      bins,
      (p.octaves - 1 - o) * p.binsPerOctave,
      maybeYield,
    );
    if (o + 1 < p.octaves) {
      signal = await downsample2(signal, maybeYield);
      hop >>= 1;
    }
  }
  return { magnitudes: out, frames, bins };
}

// 低域 fromBins 本の frame-major magnitudes を full (toBins) バッファに移し、高域を 0 で残す。
// harmonic plane の安全な octave 分だけ計算し、Nyquist 超の高域 octave を 0 にするため
export function padBinsToFull(
  mags: Float32Array<ArrayBuffer>,
  frames: number,
  fromBins: number,
  toBins: number,
): Float32Array<ArrayBuffer> {
  if (fromBins >= toBins) return mags;
  const out = new Float32Array(frames * toBins);
  for (let f = 0; f < frames; f++) {
    out.set(mags.subarray(f * fromBins, (f + 1) * fromBins), f * toBins);
  }
  return out;
}

// dB スケール [dbMin, dbMax] → Uint8 [0, 255]
export async function magnitudesToU8(
  mags: Float32Array<ArrayBuffer>,
  dbMin: number,
  dbMax: number,
  maybeYield?: MaybeYield,
): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(mags.length);
  const scale = 255 / (dbMax - dbMin);
  for (let i0 = 0; i0 < mags.length; i0 += QUANTIZE_SLICE) {
    const i1 = Math.min(mags.length, i0 + QUANTIZE_SLICE);
    for (let i = i0; i < i1; i++) {
      const db = 20 * Math.log10(Math.max(mags[i]!, 1e-10));
      out[i] = Math.max(0, Math.min(255, Math.round((db - dbMin) * scale)));
    }
    if (maybeYield) await maybeYield();
  }
  return out;
}
