import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import {
  type ComplexEnvelope,
  analyzeNote,
  detectBeat,
  extractComplexEnvelope,
  fitDecay,
  instantFreqHz,
  theilSen,
} from "./note-analysis";

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

type SynthPartial = {
  freqHz: number;
  amp: number;
  dbPerSec: number;
  phase: number;
  startSec?: number;
};

// Σ a·e^(-α t)·sin(2π f t + φ) + seeded uniform noise。α = -dbPerSec·ln10/20
function synth(
  partials: SynthPartial[],
  seconds: number,
  fs: number,
  noiseAmp: number,
  seed: number,
): Float32Array<ArrayBuffer> {
  const x = new Float32Array(Math.round(seconds * fs));
  for (const p of partials) {
    const alpha = (-p.dbPerSec * Math.LN10) / 20;
    const i0 = Math.round((p.startSec ?? 0) * fs);
    for (let i = i0; i < x.length; i++) {
      const t = (i - i0) / fs;
      x[i]! += p.amp * Math.exp(-alpha * t) * Math.sin(2 * Math.PI * p.freqHz * t + p.phase);
    }
  }
  if (noiseAmp > 0) {
    const rand = lcg(seed);
    for (let i = 0; i < x.length; i++) x[i]! += noiseAmp * (rand() * 2 - 1);
  }
  return x;
}

describe("theilSen", () => {
  // 性質: 30% の対称な外れ値混入でも slope を ±5% で復元
  // 入力: slope∈[-50,-5], intercept∈[-20,20], seed
  it("30% の外れ値混入でも slope を ±5% で復元", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -50, max: -5, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (slope, intercept, seed) => {
          const rand = lcg(seed);
          const n = 100;
          const xs: number[] = [];
          const ys: number[] = [];
          for (let i = 0; i < n; i++) {
            const x = i / n;
            xs.push(x);
            let y = slope * x + intercept;
            if (i % 10 < 3) y += (rand() < 0.5 ? 1 : -1) * (50 + rand() * 100);
            ys.push(y);
          }
          const fit = theilSen(xs, ys);
          expect(Math.abs(fit.slope - slope)).toBeLessThanOrEqual(0.05 * Math.abs(slope));
        },
      ),
      { numRuns: 20 },
    );
  });

  it("全ペアが同一 x でも NaN を出さない", () => {
    const fit = theilSen([1, 1, 1], [2, 4, 6]);
    expect(fit.slope).toBe(0);
    expect(fit.intercept).toBe(4);
  });
});

describe("instantFreqHz", () => {
  // 性質: 一定周波数の複素指数 z[i]=e^(j2πΔf·i·hop/fs) から carrier+Δf を sub-bin 復元
  // 入力: Δf∈[-40,40] (< frameRate/2=100), carrier∈[100,400]
  it("一定周波数の複素指数で周波数を sub-bin 復元", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -40, max: 40, noNaN: true }),
        fc.integer({ min: 100, max: 400 }),
        (df, carrier) => {
          const fs = 8000;
          const hop = 40;
          const frames = 100;
          const re = new Float32Array(frames);
          const im = new Float32Array(frames);
          for (let i = 0; i < frames; i++) {
            const ph = (2 * Math.PI * df * i * hop) / fs;
            re[i] = Math.cos(ph);
            im[i] = Math.sin(ph);
          }
          const env: ComplexEnvelope = { re, im, frames };
          expect(Math.abs(instantFreqHz(env, hop, fs, carrier) - (carrier + df))).toBeLessThan(
            0.05,
          );
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("extractComplexEnvelope", () => {
  // 性質: 振幅 1 の正弦波の中央フレームで |envelope| ≈ 1 (正規化 2/sum(window))
  // 入力: f∈[200,1500] (fs=8000)
  it("振幅 1 の正弦波の中央フレームで envelope ≈ 1", () => {
    fc.assert(
      fc.property(fc.integer({ min: 200, max: 1500 }), (f) => {
        const fs = 8000;
        const x = synth([{ freqHz: f, amp: 1, dbPerSec: 0, phase: 0.7 }], 0.5, fs, 0, 1);
        const env = extractComplexEnvelope(x, fs, f, 400, 40);
        const mid = env.frames >> 1;
        const mag = Math.hypot(env.re[mid]!, env.im[mid]!);
        expect(mag).toBeGreaterThan(0.9);
        expect(mag).toBeLessThan(1.1);
      }),
      { numRuns: 15 },
    );
  });

  it("taps < 3 は 3 に clamp され有限値を返す", () => {
    const fs = 8000;
    const x = synth([{ freqHz: 440, amp: 1, dbPerSec: 0, phase: 0 }], 0.1, fs, 0, 1);
    const env = extractComplexEnvelope(x, fs, 440, 2, 40);
    for (let i = 0; i < env.frames; i++) {
      expect(Number.isFinite(env.re[i]!)).toBe(true);
      expect(Number.isFinite(env.im[i]!)).toBe(true);
    }
  });
});

describe("analyzeNote", () => {
  // 性質: 単一減衰正弦波 (クリーン) で dbPerSec を ±15%、freq を ±0.5% で復元
  // 入力: fs∈[8000,16000], f0∈[200,800], dbPerSec∈[-40,-10]、ヒントは 2% ずらす
  it("単一減衰正弦波で dbPerSec ±15%・freq ±0.5% 復元", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8000, max: 16000 }),
        fc.double({ min: 200, max: 800, noNaN: true }),
        fc.double({ min: -40, max: -10, noNaN: true }),
        (fs, f0, dps) => {
          const x = synth([{ freqHz: f0, amp: 1, dbPerSec: dps, phase: 1.1 }], 1.5, fs, 0, 1);
          const a = analyzeNote(x, fs, { f0Hz: f0 * 1.02, maxPartials: 3 });
          const p1 = a.partials[0]!;
          expect(p1.dbPerSec).not.toBeNull();
          expect(Math.abs(p1.dbPerSec! - dps)).toBeLessThanOrEqual(0.15 * Math.abs(dps));
          expect(Math.abs(p1.freqHz - f0)).toBeLessThanOrEqual(0.005 * f0);
        },
      ),
      { numRuns: 10 },
    );
  });

  // 性質: SNR ~20dB の白色雑音付きでも dbPerSec を ±30% で復元
  // 入力: fs∈[8000,16000], f0∈[250,600], dbPerSec∈[-40,-15], noise seed
  it("SNR 20dB の白色雑音付きでも dbPerSec ±30%", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8000, max: 16000 }),
        fc.double({ min: 250, max: 600, noNaN: true }),
        fc.double({ min: -40, max: -15, noNaN: true }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (fs, f0, dps, seed) => {
          // 振幅 1 の正弦波 (RMS 1/√2) に対し uniform noise 0.12 (RMS ≈ 0.069) → SNR ≈ 20dB
          const x = synth([{ freqHz: f0, amp: 1, dbPerSec: dps, phase: 0.4 }], 1.5, fs, 0.12, seed);
          const a = analyzeNote(x, fs, { f0Hz: f0, maxPartials: 3 });
          const p1 = a.partials[0]!;
          expect(p1.dbPerSec).not.toBeNull();
          expect(Math.abs(p1.dbPerSec! - dps)).toBeLessThanOrEqual(0.3 * Math.abs(dps));
        },
      ),
      { numRuns: 8 },
    );
  });

  // 性質: f_k = k·f0·√(1+B·k²) の inharmonic な倍音列から B をオーダー復元 (推定/真値∈[0.3,3])
  // 入力: B∈[1e-4,1e-3], K∈[4,6], f0∈[250,400]
  it("inharmonic な倍音列で B をオーダー復元", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e-4, max: 1e-3, noNaN: true }),
        fc.integer({ min: 4, max: 6 }),
        fc.double({ min: 250, max: 400, noNaN: true }),
        (b, numPartials, f0) => {
          const fs = 12000;
          const partials: SynthPartial[] = [];
          for (let k = 1; k <= numPartials; k++) {
            partials.push({
              freqHz: k * f0 * Math.sqrt(1 + b * k * k),
              amp: 1 / k,
              dbPerSec: -12 - 2 * k,
              phase: k,
            });
          }
          const x = synth(partials, 1.2, fs, 0, 1);
          const a = analyzeNote(x, fs, { f0Hz: f0, maxPartials: numPartials });
          expect(a.inharmonicityB).not.toBeNull();
          const ratio = a.inharmonicityB! / b;
          expect(ratio).toBeGreaterThanOrEqual(0.3);
          expect(ratio).toBeLessThanOrEqual(3);
        },
      ),
      { numRuns: 8 },
    );
  });
});

describe("analyzeNote options", () => {
  // 性質: 減衰正弦波より大きい同一周波数の定常成分に埋もれた partial は、fitEndSec の
  // 尾部床で peak−床 < 4dB となり collided=true / フィット不能になる
  // 入力: f∈[300,600], 定常振幅 s∈[2,4] (peak/床 ≤ (1+s)/s ≤ 3.5dB < 4dB), 位相
  it("同一周波数の定常成分との衝突は collided=true", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 300, max: 600, noNaN: true }),
        fc.double({ min: 2, max: 4, noNaN: true }),
        fc.double({ min: 0, max: 6, noNaN: true }),
        (f, steadyAmp, phase) => {
          const fs = 8000;
          const x = synth(
            [
              { freqHz: f, amp: 1, dbPerSec: -40, phase: 0.8 },
              { freqHz: f, amp: steadyAmp, dbPerSec: 0, phase },
            ],
            1.5,
            fs,
            0,
            1,
          );
          const a = analyzeNote(x, fs, {
            f0Hz: f,
            maxPartials: 1,
            f0Refine: false,
            fitEndSec: 0.4,
          });
          const p1 = a.partials[0]!;
          expect(p1.collided).toBe(true);
          expect(p1.dbPerSec).toBeNull();
        },
      ),
      { numRuns: 10 },
    );
  });

  // 性質: 26% 離れた定常妨害音があっても windowPeriods=10 の狭帯域なら dbPerSec ±20% で復元
  // 入力: f0∈[300,500], dbPerSec∈[-40,-20] (妨害音 1.26·f0, 振幅 0.8)
  it("26% 離れた妨害音があっても windowPeriods=10 で dbPerSec ±20%", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 300, max: 500, noNaN: true }),
        fc.double({ min: -40, max: -20, noNaN: true }),
        (f0, dps) => {
          const fs = 8000;
          const x = synth(
            [
              { freqHz: f0, amp: 1, dbPerSec: dps, phase: 0.3 },
              { freqHz: 1.26 * f0, amp: 0.8, dbPerSec: 0, phase: 1.7 },
            ],
            1.5,
            fs,
            0,
            1,
          );
          const a = analyzeNote(x, fs, {
            f0Hz: f0,
            maxPartials: 1,
            f0Refine: false,
            windowPeriods: 10,
          });
          const p1 = a.partials[0]!;
          expect(p1.dbPerSec).not.toBeNull();
          expect(Math.abs(p1.dbPerSec! - dps)).toBeLessThanOrEqual(0.2 * Math.abs(dps));
        },
      ),
      { numRuns: 10 },
    );
  });

  // 性質: 4 回繰り返しの同期平均は、重い外れ値ノイズ下でも単発解析より dbPerSec 誤差が
  // 悪化しない (±0.1·|dps| の許容内。改善幅は assert しない)
  // 入力: f0∈[300,500], dbPerSec∈[-35,-20], spike noise の seed
  it("repeat 同期平均は外れ値ノイズ下で単発より悪化しない", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 300, max: 500, noNaN: true }),
        fc.double({ min: -35, max: -20, noNaN: true }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (f0, dps, seed) => {
          const fs = 8000;
          const periodSec = 0.8;
          const count = 4;
          const durSec = 0.7;
          const totalSec = durSec + periodSec * (count - 1);
          const x = synth(
            Array.from({ length: count }, (_, r) => ({
              freqHz: f0,
              amp: 1,
              dbPerSec: dps,
              phase: 0.9 + 1.3 * r,
              startSec: r * periodSec,
            })),
            totalSec,
            fs,
            0,
            1,
          );
          const rand = lcg(seed);
          for (let i = 0; i < x.length; i++) {
            if (rand() < 0.015) x[i]! += (rand() * 2 - 1) * 4;
          }
          const base = { f0Hz: f0, maxPartials: 1, f0Refine: false } as const;
          const single = analyzeNote(x.subarray(0, Math.round(durSec * fs)), fs, base);
          const repeated = analyzeNote(x, fs, { ...base, repeat: { periodSec, count } });
          const errSingle = Math.abs(single.partials[0]!.dbPerSec! - dps);
          const errRepeat = Math.abs(repeated.partials[0]!.dbPerSec! - dps);
          expect(repeated.params.repeat).toEqual({ periodSec, count });
          expect(errRepeat).toBeLessThanOrEqual(errSingle + 0.1 * Math.abs(dps));
        },
      ),
      { numRuns: 6 },
    );
  });

  // 性質: f0Refine=false なら精密化されず f0Hz は入力そのまま返る (信号は 1% ずらす)
  it("f0Refine=false のとき f0Hz が入力そのまま返る", () => {
    fc.assert(
      fc.property(fc.double({ min: 100, max: 800, noNaN: true }), (f0) => {
        const fs = 8000;
        const x = synth([{ freqHz: f0 * 1.01, amp: 1, dbPerSec: -20, phase: 1 }], 0.4, fs, 0, 1);
        const a = analyzeNote(x, fs, { f0Hz: f0, maxPartials: 1, f0Refine: false });
        expect(a.f0Hz).toBe(f0);
        expect(a.params.f0Refine).toBe(false);
      }),
      { numRuns: 10 },
    );
  });

  it("onsetSearchEndSec で領域後半のより大きい音を onset に選ばない", () => {
    const fs = 8000;
    const f0 = 400;
    const x = synth(
      [
        { freqHz: f0, amp: 0.25, dbPerSec: -30, phase: 0.5, startSec: 0.1 },
        { freqHz: f0, amp: 1, dbPerSec: -30, phase: 2.1, startSec: 1.0 },
      ],
      1.5,
      fs,
      0,
      1,
    );
    const base = { f0Hz: f0, maxPartials: 1, f0Refine: false } as const;
    const limited = analyzeNote(x, fs, { ...base, onsetSearchEndSec: 0.5 });
    expect(limited.onsetSec).toBeGreaterThan(0.05);
    expect(limited.onsetSec).toBeLessThan(0.3);
    const unlimited = analyzeNote(x, fs, base);
    expect(unlimited.onsetSec).toBeGreaterThan(0.9);
  });
});

describe("detectBeat", () => {
  // 性質: 近接 2 周波数の合成のエンベロープ残差から beat ≈ |Δf| を検出 (±15%)
  // 入力: Δf∈[8,25], f1∈[400,600] (fs=8000, frameRate=200)
  it("近接 2 周波数の合成で beat ≈ |Δf| を検出", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 8, max: 25, noNaN: true }),
        fc.double({ min: 400, max: 600, noNaN: true }),
        (dfHz, f1) => {
          const fs = 8000;
          const hop = 40;
          const frameRate = fs / hop;
          const taps = 160;
          const x = synth(
            [
              { freqHz: f1, amp: 1, dbPerSec: 0, phase: 0.5 },
              { freqHz: f1 + dfHz, amp: 0.5, dbPerSec: 0, phase: 2 },
            ],
            1.2,
            fs,
            0,
            1,
          );
          const env = extractComplexEnvelope(x, fs, f1, taps, hop);
          const skip = Math.ceil(taps / (2 * hop));
          const ts: number[] = [];
          const db: number[] = [];
          for (let i = skip; i < env.frames - skip; i++) {
            ts.push(i / frameRate);
            db.push(20 * Math.log10(Math.max(Math.hypot(env.re[i]!, env.im[i]!), 1e-10)));
          }
          const fit = fitDecay(ts, db);
          const residual = db.map((y, i) => y - (fit.dbPerSec * ts[i]! + fit.interceptDb));
          const beat = detectBeat(residual, frameRate);
          expect(beat).not.toBeNull();
          expect(Math.abs(beat!.hz - dfHz)).toBeLessThanOrEqual(0.15 * dfHz);
        },
      ),
      { numRuns: 10 },
    );
  });

  it("一定値の残差では null", () => {
    expect(
      detectBeat(
        Array.from({ length: 50 }, () => 3),
        200,
      ),
    ).toBeNull();
  });

  it("フレーム数が少なすぎる場合は null", () => {
    expect(detectBeat([1, -1, 1, -1, 1], 200)).toBeNull();
  });
});
