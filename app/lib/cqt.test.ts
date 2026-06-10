import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import { computeCqt, cqtBinFrequency, downsample2, magnitudesToU8 } from "./cqt";

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
  it("正弦波の周波数 bin が argmax", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: B * OCTAVES - 1 }), (bin) => {
        const f = cqtBinFrequency(FMIN, B, bin);
        const { magnitudes, frames, bins } = computeCqt(sine(f, 1.5, FS), {
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

  it("中心 bin の振幅は ~1 に正規化される", () => {
    const bin = 3 * B;
    const f = cqtBinFrequency(FMIN, B, bin);
    const { magnitudes, frames, bins } = computeCqt(sine(f, 1.5, FS), {
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

  it("hop が 2^(octaves-1) の倍数でないと throw", () => {
    expect(() =>
      computeCqt(new Float32Array(256), {
        sampleRate: FS,
        binsPerOctave: B,
        octaves: 5,
        fminHz: FMIN,
        hop: 24,
      }),
    ).toThrow();
  });
});

describe("downsample2", () => {
  // 性質: f << fs/4 の正弦波は 1/2 間引き後も中央部の振幅 ~1 を保つ
  // 入力: 周波数 [50, 800] Hz (fs=8000)
  it("低周波正弦波の振幅を保つ", () => {
    fc.assert(
      fc.property(fc.integer({ min: 50, max: 800 }), (f) => {
        const y = downsample2(sine(f, 0.5, FS));
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

  it("出力長は ceil(n/2)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), (n) => {
        expect(downsample2(new Float32Array(n)).length).toBe(Math.ceil(n / 2));
      }),
      { numRuns: 20 },
    );
  });
});

describe("magnitudesToU8", () => {
  it("0dB→255, -80dB以下→0, 単調", () => {
    const u8 = magnitudesToU8(new Float32Array([1, 1e-4, 1e-6, 0.1, 0.01]), -80, 0);
    expect(u8[0]).toBe(255);
    expect(u8[1]).toBe(0);
    expect(u8[2]).toBe(0);
    expect(u8[3]!).toBeGreaterThan(u8[4]!);
  });
});
