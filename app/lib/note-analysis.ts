// 単音のモード解析: 音を減衰調和振動子の集まりとしてモデル化し、partial ごとの
// 複素ヘテロダインエンベロープを抽出して対数振幅に Theil-Sen 回帰で減衰率をフィットする。
// 既存 CQT パイプラインとは独立の解析パス

export type ComplexEnvelope = {
  re: Float32Array<ArrayBuffer>;
  im: Float32Array<ArrayBuffer>;
  frames: number;
};

const DB_FLOOR_AMP = 1e-10;

function toDb(amp: number): number {
  return 20 * Math.log10(Math.max(amp, DB_FLOOR_AMP));
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function median(values: number[]): number {
  const s = values.toSorted((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function percentile(values: number[], p: number): number {
  const s = values.toSorted((a, b) => a - b);
  return s[Math.floor(p * (s.length - 1))]!;
}

// cqt.ts の correlateBinSlice と同じ Hann 窓掛け複素相関。絶対値を取らず re/im を返す。
// frame i の窓中心は i*hop、正規化 2/sum(window) で振幅 1 の正弦波 → 振幅 ~1
export function extractComplexEnvelope(
  samples: Float32Array<ArrayBuffer>,
  sampleRate: number,
  freqHz: number,
  taps: number,
  hop: number,
): ComplexEnvelope {
  const n = Math.max(3, Math.round(taps));
  const kr = new Float32Array(n);
  const ki = new Float32Array(n);
  let wSum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const phase = (2 * Math.PI * freqHz * (i - (n - 1) / 2)) / sampleRate;
    kr[i] = w * Math.cos(phase);
    ki[i] = -w * Math.sin(phase);
    wSum += w;
  }
  const norm = 2 / wSum;
  const frames = Math.max(1, Math.floor(samples.length / hop) + 1);
  const re = new Float32Array(frames);
  const im = new Float32Array(frames);
  const half = n >> 1;
  for (let i = 0; i < frames; i++) {
    const start = i * hop - half;
    const lo = Math.max(0, -start);
    const hi = Math.min(n, samples.length - start);
    let accRe = 0;
    let accIm = 0;
    for (let t = lo; t < hi; t++) {
      const s = samples[start + t]!;
      accRe += kr[t]! * s;
      accIm += ki[t]! * s;
    }
    // 窓内 tap 基準のカーネル位相を窓中心の搬送波位相で回転してベースバンド化
    // (位相増分 = 周波数差になる)
    const cycles = (freqHz * i * hop) / sampleRate;
    const ang = -2 * Math.PI * (cycles - Math.floor(cycles));
    const cs = Math.cos(ang);
    const sn = Math.sin(ang);
    re[i] = (accRe * cs - accIm * sn) * norm;
    im[i] = (accRe * sn + accIm * cs) * norm;
  }
  return { re, im, frames };
}

// 隣接フレーム間の位相増分から精密周波数。S = Σ z[i+1]·conj(z[i]) の複素和が
// 振幅²重み付き平均を内包する。測定範囲は carrier ± frameRate/2 (超えると折り返す)
export function instantFreqHz(
  env: ComplexEnvelope,
  hop: number,
  sampleRate: number,
  carrierHz: number,
): number {
  let sRe = 0;
  let sIm = 0;
  for (let i = 0; i + 1 < env.frames; i++) {
    const aRe = env.re[i + 1]!;
    const aIm = env.im[i + 1]!;
    const bRe = env.re[i]!;
    const bIm = env.im[i]!;
    sRe += aRe * bRe + aIm * bIm;
    sIm += aIm * bRe - aRe * bIm;
  }
  if (sRe === 0 && sIm === 0) return carrierHz;
  const frameRate = sampleRate / hop;
  return carrierHz + (Math.atan2(sIm, sRe) * frameRate) / (2 * Math.PI);
}

// ペアごとの傾きの中央値によるロバスト直線フィット。ペア総数が maxPairs 超なら
// seed 固定の LCG で決定的にサブサンプルする (結果の再現性のため Math.random 不可)
export function theilSen(
  xs: number[],
  ys: number[],
  maxPairs = 4000,
): { slope: number; intercept: number } {
  const n = xs.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  if (n === 1) return { slope: 0, intercept: ys[0]! };
  const slopes: number[] = [];
  if ((n * (n - 1)) / 2 <= maxPairs) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = xs[j]! - xs[i]!;
        if (dx !== 0) slopes.push((ys[j]! - ys[i]!) / dx);
      }
    }
  } else {
    let state = 0x2545f491;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    for (let s = 0; s < maxPairs; s++) {
      const i = Math.floor(next() * n);
      let j = Math.floor(next() * (n - 1));
      if (j >= i) j++;
      const dx = xs[j]! - xs[i]!;
      if (dx !== 0) slopes.push((ys[j]! - ys[i]!) / dx);
    }
  }
  if (slopes.length === 0) return { slope: 0, intercept: median(ys) };
  const slope = median(slopes);
  const intercept = median(xs.map((x, i) => ys[i]! - slope * x));
  return { slope, intercept };
}

export function fitDecay(
  tSec: number[],
  db: number[],
): { dbPerSec: number; interceptDb: number; r2: number } {
  const { slope, intercept } = theilSen(tSec, db);
  const mean = db.reduce((s, y) => s + y, 0) / db.length;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < db.length; i++) {
    ssRes += (db[i]! - (slope * tSec[i]! + intercept)) ** 2;
    ssTot += (db[i]! - mean) ** 2;
  }
  return { dbPerSec: slope, interceptDb: intercept, r2: ssTot > 0 ? 1 - ssRes / ssTot : 1 };
}

const BEAT_MIN_LAG = 3;
const BEAT_MIN_STRENGTH = 0.35;

// フィット残差の正規化自己相関ピークからうなり (連成・重複音の証拠) を検出する。
// 単調減衰の裾 (最小 lag) を拾わないよう局所ピークだけを候補にする
export function detectBeat(
  residualDb: number[],
  frameRate: number,
): { hz: number; strength: number } | null {
  const n = residualDb.length;
  const maxLag = Math.floor(n / 2);
  if (maxLag < BEAT_MIN_LAG) return null;
  const mean = residualDb.reduce((s, v) => s + v, 0) / n;
  const x = residualDb.map((v) => v - mean);
  let energy = 0;
  for (const v of x) energy += v * v;
  if (energy === 0) return null;
  const r = new Float64Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += x[i]! * x[i + lag]!;
    r[lag] = acc / energy;
  }
  let best = -1;
  for (let lag = BEAT_MIN_LAG; lag <= maxLag; lag++) {
    const prev = r[lag - 1]!;
    const next = lag + 1 <= maxLag ? r[lag + 1]! : Number.NEGATIVE_INFINITY;
    if (r[lag]! >= prev && r[lag]! >= next && (best < 0 || r[lag]! > r[best]!)) best = lag;
  }
  if (best < 0 || r[best]! < BEAT_MIN_STRENGTH) return null;
  return { hz: frameRate / best, strength: r[best]! };
}

export type PartialFit = {
  k: number;
  /** 実測 (位相微分) */
  freqHz: number;
  /** k·f0 (inharmonicity 補正なし) からのずれ */
  centsFromHarmonic: number;
  /** フィット不能なら null (interceptDb/r2/tau60Sec も同時に null) */
  dbPerSec: number | null;
  interceptDb: number | null;
  /** dbPerSec >= -1e-6 なら null */
  tau60Sec: number | null;
  r2: number | null;
  snrDb: number;
  beat: { hz: number; strength: number } | null;
  /** 間引き後 */
  envelopeDb: number[];
};

export type NoteAnalysis = {
  f0Hz: number;
  /** 有効実測点 2 未満なら null */
  inharmonicityB: number | null;
  onsetSec: number;
  fitStartSec: number;
  /** 間引き前 */
  frameRate: number;
  /** envelopeDb[i] の時刻 = i·envStride/frameRate */
  envStride: number;
  sampleRate: number;
  partials: PartialFit[];
};

const REFINE_GUARD_OCT = 1 / 6;
const B_MAX = 0.02;
const B_FIT_MIN_SNR_DB = 10;
const FIT_MIN_FRAMES = 8;
const FIT_SNR_MARGIN_DB = 6;
const ENV_MAX_POINTS = 240;

type TrackedPartial = { k: number; freqHz: number; amp: Float32Array<ArrayBuffer>; db: number[] };

export function analyzeNote(
  samples: Float32Array<ArrayBuffer>,
  sampleRate: number,
  opts: { f0Hz: number; maxPartials: number; hop?: number },
): NoteAnalysis {
  const hop = opts.hop ?? Math.max(1, Math.round(sampleRate / 200));
  const frameRate = sampleRate / hop;

  // f0 精密化 (1 回反復)。ヒントから 1/6 oct 超は隣接音への誤収束とみなしヒントを維持
  const hint = opts.f0Hz;
  const refineTaps = clampNum(Math.round((8 * sampleRate) / hint), 3, Math.floor(sampleRate * 0.4));
  let f0 = hint;
  for (let pass = 0; pass < 2; pass++) {
    const env = extractComplexEnvelope(samples, sampleRate, f0, refineTaps, hop);
    const measured = instantFreqHz(env, hop, sampleRate, f0);
    f0 = measured > 0 && Math.abs(Math.log2(measured / hint)) <= REFINE_GUARD_OCT ? measured : hint;
  }

  // 隣接 partial は k によらず f0 Hz 間隔なので全 partial 共通の窓で分離できる
  const taps = clampNum(Math.round((4 * sampleRate) / f0), 3, Math.floor(sampleRate * 0.2));
  const frames = Math.max(1, Math.floor(samples.length / hop) + 1);
  const tracked: TrackedPartial[] = [];
  let inharmB = 0;
  let bNum = 0;
  let bDen = 0;
  let bPoints = 0;
  for (let k = 1; k <= opts.maxPartials; k++) {
    const fPred = k * f0 * Math.sqrt(1 + inharmB * k * k);
    if (fPred > 0.45 * sampleRate) break;
    const env = extractComplexEnvelope(samples, sampleRate, fPred, taps, hop);
    const amp = new Float32Array(env.frames);
    let peakAmp = 0;
    for (let i = 0; i < env.frames; i++) {
      const a = Math.hypot(env.re[i]!, env.im[i]!);
      amp[i] = a;
      if (a > peakAmp) peakAmp = a;
    }
    const db = Array.from(amp, toDb);
    const fk = instantFreqHz(env, hop, sampleRate, fPred);
    tracked.push({ k, freqHz: fk, amp, db });
    // (fk/(k·f0))² - 1 = B·k² を振幅²重み付き最小二乗で逐次更新。
    // 窓の主弁を外れた実測値 (別 partial / ノイズ由来) と、instantFreqHz の
    // 測定範囲 ±frameRate/2 の折り返し境界に近い実測値は除外する
    const provisionalSnr = toDb(peakAmp) - percentile(db, 0.1);
    if (
      k >= 2 &&
      peakAmp > 0 &&
      Math.abs(fk - fPred) < Math.min(0.25 * f0, 0.4 * (frameRate / 2)) &&
      provisionalSnr >= B_FIT_MIN_SNR_DB
    ) {
      const y = (fk / (k * f0)) ** 2 - 1;
      const w = peakAmp * peakAmp;
      bNum += w * y * k * k;
      bDen += w * k ** 4;
      bPoints++;
      inharmB = clampNum(bNum / bDen, 0, B_MAX);
    }
  }

  const totalPow = new Float64Array(frames);
  for (const p of tracked) {
    for (let i = 0; i < frames; i++) totalPow[i] += p.amp[i]! * p.amp[i]!;
  }
  let onsetFrame = 0;
  for (let i = 1; i < frames; i++) {
    if (totalPow[i]! > totalPow[onsetFrame]!) onsetFrame = i;
  }
  // 窓が attack をまたぐ区間はフィットから除外する
  const fitStartFrame = onsetFrame + Math.ceil(taps / (2 * hop));
  const preFrames = onsetFrame - Math.ceil(taps / hop);
  const stride = Math.ceil(frames / ENV_MAX_POINTS);

  const partials: PartialFit[] = tracked.map(({ k, freqHz, db }) => {
    const noiseDb = preFrames >= 8 ? median(db.slice(0, preFrames)) : percentile(db, 0.1);
    const peakDb = Math.max(...db);
    let fitEnd = -1;
    for (let i = frames - 1; i >= fitStartFrame; i--) {
      if (db[i]! > noiseDb + FIT_SNR_MARGIN_DB) {
        fitEnd = i;
        break;
      }
    }
    let fit: { dbPerSec: number; interceptDb: number; r2: number } | null = null;
    let beat: { hz: number; strength: number } | null = null;
    if (fitEnd - fitStartFrame + 1 >= FIT_MIN_FRAMES) {
      const ts: number[] = [];
      const ys: number[] = [];
      for (let i = fitStartFrame; i <= fitEnd; i++) {
        ts.push(i / frameRate);
        ys.push(db[i]!);
      }
      fit = fitDecay(ts, ys);
      const f = fit;
      const residual = ts.map((t, i) => ys[i]! - (f.dbPerSec * t + f.interceptDb));
      beat = detectBeat(residual, frameRate);
    }
    // ピーク保存の間引き (stride 内 max)
    const envelopeDb: number[] = [];
    for (let j = 0; j * stride < frames; j++) {
      let m = Number.NEGATIVE_INFINITY;
      const end = Math.min(frames, (j + 1) * stride);
      for (let i = j * stride; i < end; i++) m = Math.max(m, db[i]!);
      envelopeDb.push(m);
    }
    return {
      k,
      freqHz,
      centsFromHarmonic: freqHz > 0 ? 1200 * Math.log2(freqHz / (k * f0)) : 0,
      dbPerSec: fit ? fit.dbPerSec : null,
      interceptDb: fit ? fit.interceptDb : null,
      tau60Sec: fit && fit.dbPerSec < -1e-6 ? 60 / -fit.dbPerSec : null,
      r2: fit ? fit.r2 : null,
      snrDb: peakDb - noiseDb,
      beat,
      envelopeDb,
    };
  });

  return {
    f0Hz: f0,
    inharmonicityB: bPoints >= 2 ? inharmB : null,
    onsetSec: onsetFrame / frameRate,
    fitStartSec: fitStartFrame / frameRate,
    frameRate,
    envStride: stride,
    sampleRate,
    partials,
  };
}
