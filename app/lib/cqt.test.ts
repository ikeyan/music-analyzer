import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import {
  autoGamma,
  computeCqt,
  cqtBinFrequency,
  downsample2,
  magnitudesToU8,
  padBinsToFull,
} from "./cqt";

const FS = 8000;
const B = 12;
const OCTAVES = 5;
const FMIN = 55;
const HOP = 64;

function sine(freq: number, seconds: number, fs: number): Float32Array<ArrayBuffer> {
  const x = new Float32Array(Math.round(seconds * fs));
  for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * freq * i) / fs);
  return x;
}

describe("computeCqt", () => {
  // 性質: bin 中心周波数の正弦波は全オクターブでその bin が argmax になる
  // 入力: bin ∈ [0, B*octaves)
  it("正弦波の周波数 bin が argmax", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: B * OCTAVES - 1 }), async (bin) => {
        const f = cqtBinFrequency(FMIN, B, bin);
        const { magnitudes, frames, bins } = await computeCqt(sine(f, 1.5, FS), {
          sampleRate: FS,
          binsPerOctave: B,
          octaves: OCTAVES,
          fminHz: FMIN,
          hop: HOP,
        });
        const mid = Math.floor(frames / 2);
        let best = 0;
        for (let k = 1; k < bins; k++) {
          if (magnitudes[mid * bins + k]! > magnitudes[mid * bins + best]!) best = k;
        }
        expect(best).toBe(bin);
      }),
      { numRuns: 15 },
    );
  });

  it("中心 bin の振幅は ~1 に正規化される", async () => {
    const bin = 3 * B;
    const f = cqtBinFrequency(FMIN, B, bin);
    const { magnitudes, frames, bins } = await computeCqt(sine(f, 1.5, FS), {
      sampleRate: FS,
      binsPerOctave: B,
      octaves: OCTAVES,
      fminHz: FMIN,
      hop: HOP,
    });
    const mid = Math.floor(frames / 2);
    expect(magnitudes[mid * bins + bin]!).toBeGreaterThan(0.9);
    expect(magnitudes[mid * bins + bin]!).toBeLessThan(1.1);
  });

  // 性質: VQT (gamma>0) は低域の窓長を頭打ちにするので、急な onset の magnitude が
  // 0.1→0.9 に立ち上がる frame 幅が純 constant-Q より狭い
  it("VQT は低域 onset の時間方向の滲みを constant-Q より狭める", async () => {
    const bin = B; // 下から 2 番目の octave の最下 bin
    const f = cqtBinFrequency(FMIN, B, bin);
    const onset = 8000;
    const x = new Float32Array(16000);
    for (let i = onset; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * f * i) / FS);
    const base = { sampleRate: FS, binsPerOctave: B, octaves: OCTAVES, fminHz: FMIN, hop: HOP };
    const riseFrames = async (gamma: number): Promise<number> => {
      const { magnitudes, frames, bins } = await computeCqt(x, { ...base, gamma });
      const col = (fr: number) => magnitudes[fr * bins + bin]!;
      const steady = col(frames - 1);
      let lo = -1;
      for (let fr = 0; fr < frames; fr++) {
        if (lo < 0 && col(fr) >= 0.1 * steady) lo = fr;
        if (col(fr) >= 0.9 * steady) return fr - lo;
      }
      return frames;
    };
    expect(await riseFrames(autoGamma(B))).toBeLessThan(await riseFrames(0));
  });

  it("窓長が丸めで 2 tap になる高域 bin でも NaN を出さない", async () => {
    // fs/(alpha*f)=2.29 → 丸めで 2 tap。Hann 窓は両端 0 なので和が 0 になり NaN が出ていた
    const { magnitudes } = await computeCqt(sine(3500, 0.5, FS), {
      sampleRate: FS,
      binsPerOctave: 1,
      octaves: 1,
      fminHz: 3500,
      hop: 64,
    });
    expect(magnitudes.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("最上位 bin が Nyquist 超だと throw (kernel aliasing 防止)", () => {
    // top bin 3000*2^(23/12) ≈ 11.3kHz > Nyquist 4kHz
    expect(
      computeCqt(new Float32Array(512), {
        sampleRate: FS,
        binsPerOctave: B,
        octaves: 2,
        fminHz: 3000,
        hop: 64,
      }),
    ).rejects.toThrow(/Nyquist/);
  });

  it("hop が 2^(octaves-1) の倍数でないと throw", () => {
    expect(
      computeCqt(new Float32Array(256), {
        sampleRate: FS,
        binsPerOctave: B,
        octaves: 5,
        fminHz: FMIN,
        hop: 24,
      }),
    ).rejects.toThrow();
  });
});

describe("downsample2", () => {
  // 性質: f << fs/4 の正弦波は 1/2 間引き後も中央部の振幅 ~1 を保つ
  // 入力: 周波数 [50, 800] Hz (fs=8000)
  it("低周波正弦波の振幅を保つ", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 50, max: 800 }), async (f) => {
        const y = await downsample2(sine(f, 0.5, FS));
        let peak = 0;
        for (let i = Math.floor(y.length / 4); i < Math.floor((3 * y.length) / 4); i++) {
          peak = Math.max(peak, Math.abs(y[i]!));
        }
        expect(peak).toBeGreaterThan(0.9);
        expect(peak).toBeLessThan(1.1);
      }),
      { numRuns: 10 },
    );
  });

  it("出力長は ceil(n/2)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1000 }), async (n) => {
        expect((await downsample2(new Float32Array(n))).length).toBe(Math.ceil(n / 2));
      }),
      { numRuns: 20 },
    );
  });
});

describe("padBinsToFull", () => {
  // 性質: 低域 fromBins 本はそのまま、残り (toBins-fromBins) は 0、frame-major で配置
  // 入力: frames∈[1,5], fromBins∈[1,12], extra∈[0,12]
  it("低域を保ち高域を 0 padding する", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 0, max: 12 }),
        (frames, fromBins, extra) => {
          const toBins = fromBins + extra;
          const src = new Float32Array(frames * fromBins);
          for (let i = 0; i < src.length; i++) src[i] = i + 1;
          const out = padBinsToFull(src, frames, fromBins, toBins);
          expect(out.length).toBe(frames * toBins);
          for (let f = 0; f < frames; f++) {
            for (let b = 0; b < toBins; b++) {
              expect(out[f * toBins + b]).toBe(b < fromBins ? src[f * fromBins + b]! : 0);
            }
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("magnitudesToU8", () => {
  it("0dB→255, -80dB以下→0, 単調", async () => {
    const u8 = await magnitudesToU8(new Float32Array([1, 1e-4, 1e-6, 0.1, 0.01]), -80, 0);
    expect(u8[0]).toBe(255);
    expect(u8[1]).toBe(0);
    expect(u8[2]).toBe(0);
    expect(u8[3]!).toBeGreaterThan(u8[4]!);
  });
});
