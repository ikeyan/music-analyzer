import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import {
  MAX_SPECTROGRAM_FRAMES,
  SPECTROGRAM_TILE_FRAMES,
  buildPyramid,
  chooseHop,
  cqtRangeFromCenter,
  levelCount,
  parseHarmonics,
  safeCqtOctaves,
  sliceTile,
  tileCount,
} from "./spectrogram";

describe("chooseHop", () => {
  // 性質: hop は 2^(octaves-1) の倍数で、frame 数が MAX_SPECTROGRAM_FRAMES に収まる
  // 入力: fs ∈ [3000, 48000], octaves ∈ [1, 10], samples ∈ [1, 2^28]
  it("octave 整列と frame 上限を満たす", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3000, max: 48000 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 2 ** 28 }),
        (fs, octaves, samples) => {
          const hop = chooseHop(fs, octaves, samples);
          expect(hop % 2 ** (octaves - 1)).toBe(0);
          expect(Math.floor(samples / hop) + 1).toBeLessThanOrEqual(MAX_SPECTROGRAM_FRAMES + 1);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("buildPyramid / sliceTile", () => {
  // 性質: 最終 level は tileFrames 以下、level L+1 の各値は L の隣接 2 frame の max
  // 入力: frames ∈ [1, 4*tile], bins ∈ [1, 8] のランダム Uint8
  it("max-pool ピラミッドを構成する", async () => {
    const tile = 16;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer(),
        async (frames, bins, seed) => {
          const data = new Uint8Array(frames * bins);
          for (let i = 0; i < data.length; i++) data[i] = (seed + i * 2654435761) & 0xff;
          const levels = await buildPyramid(data, frames, bins, tile);
          expect(levels.length).toBe(levelCount(frames, tile));
          expect(levels[levels.length - 1]!.frames).toBeLessThanOrEqual(tile);
          for (let l = 1; l < levels.length; l++) {
            const prev = levels[l - 1]!;
            const cur = levels[l]!;
            for (let i = 0; i < cur.frames; i++) {
              const a = 2 * i;
              const b = Math.min(2 * i + 1, prev.frames - 1);
              for (let k = 0; k < bins; k++) {
                expect(cur.data[i * bins + k]).toBe(
                  Math.max(prev.data[a * bins + k]!, prev.data[b * bins + k]!),
                );
              }
            }
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  // 性質: 全タイルの連結が level データ全体に等しい
  it("タイル分割は全データを過不足なく覆う", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 * SPECTROGRAM_TILE_FRAMES }),
        fc.integer({ min: 1, max: 4 }),
        (frames, bins) => {
          const data = new Uint8Array(frames * bins).fill(7);
          const level = { frames, data };
          let total = 0;
          for (let i = 0; i < tileCount(frames); i++) total += sliceTile(level, bins, i).length;
          expect(total).toBe(frames * bins);
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe("cqtRangeFromCenter", () => {
  // 性質: octaves = down+up、中心は最低 bin の octavesDown 上 (fmin*2^down == center)
  // 入力: center∈[8,4000], down/up∈[0,8]
  it("中心と上下オクターブから fmin/octaves を導く", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: 4000 }),
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 0, max: 8 }),
        (center, down, up) => {
          const { fminHz, octaves } = cqtRangeFromCenter(center, down, up);
          expect(octaves).toBe(down + up);
          expect(fminHz * 2 ** down).toBeCloseTo(center, 6);
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe("safeCqtOctaves", () => {
  // 性質: safe∈[0,octaves]、safe>=1 なら最上位 bin fmin*2^(safe-1/B) <= fmax、
  // 全 octave の最上位 bin が収まるなら octaves をそのまま返す
  // 入力: fmin∈[8,4000], B∈[12,48], octaves∈[1,10], fmax∈[8,20000]
  it("最上位 bin が fmax 以下になる octave 数を返す", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: 4000 }),
        fc.integer({ min: 12, max: 48 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 8, max: 20000 }),
        (fmin, bpo, octaves, fmax) => {
          const safe = safeCqtOctaves(fmin, bpo, octaves, fmax);
          expect(safe).toBeGreaterThanOrEqual(0);
          expect(safe).toBeLessThanOrEqual(octaves);
          if (safe >= 1)
            expect(fmin * 2 ** (safe - 1 / bpo)).toBeLessThanOrEqual(fmax * (1 + 1e-9));
          if (fmin * 2 ** (octaves - 1 / bpo) <= fmax * (1 - 1e-9)) expect(safe).toBe(octaves);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("parseHarmonics", () => {
  it("正常系と異常系", () => {
    expect(parseHarmonics("[1,2,3]")).toEqual([1, 2, 3]);
    expect(() => parseHarmonics("[]")).toThrow();
    expect(() => parseHarmonics("[0]")).toThrow();
    expect(() => parseHarmonics('["a"]')).toThrow();
    expect(() => parseHarmonics("[1.5]")).toThrow();
  });
});
