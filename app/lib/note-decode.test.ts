import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import decodeCases from "../test-fixtures/note-decode-cases.json";
import { DEFAULT_DECODE_PARAMS, type DecodeParams, decodeNotes } from "./note-decode";

function grid(
  frames: number,
  bins: number,
  fill: (f: number, b: number) => number,
): Float32Array<ArrayBuffer> {
  const a = new Float32Array(frames * bins);
  for (let f = 0; f < frames; f++) for (let b = 0; b < bins; b++) a[f * bins + b] = fill(f, b);
  return a;
}

describe("decodeNotes", () => {
  // 性質: 1 bin の矩形パルス (長さ len ≥ minFrames) はちょうど 1 note になり区間が一致する
  // 入力: frames∈[8,40], start/len で矩形を置く
  it("矩形パルスを 1 note として切り出す", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: 40 }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 3, max: 10 }),
        fc.integer({ min: 0, max: 4 }),
        (frames, start, len, bin) => {
          const end = Math.min(frames, start + len);
          const active = grid(frames, 5, (f, b) =>
            b === bin && f >= start && f < end ? 0.9 : 0.05,
          );
          const onset = grid(frames, 5, () => 0);
          const notes = decodeNotes(active, onset, frames, 5);
          if (end - start >= DEFAULT_DECODE_PARAMS.minFrames) {
            expect(notes).toEqual([
              { startFrame: start, endFrame: end, bin, confidence: expect.closeTo(0.9, 5) },
            ]);
          } else {
            expect(notes).toEqual([]);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it("hysteresis: off 閾値未満まで下がるまで継続し、隣接 bin の裾は抑制する", () => {
    // bin1 が本体 (0.9)、bin0/bin2 は裾 (0.6 > onThreshold)。frame 5 で 0.4 (off 未満ではない) → 継続
    const active = grid(10, 3, (f, b) => {
      if (f >= 8) return 0;
      const v = f === 5 ? 0.4 : 0.9;
      return b === 1 ? v : v * 0.7;
    });
    const onset = grid(10, 3, () => 0);
    expect(decodeNotes(active, onset, 10, 3)).toEqual([
      { startFrame: 0, endFrame: 8, bin: 1, confidence: expect.closeTo((0.9 * 7 + 0.4) / 8, 5) },
    ]);
  });

  it("onset ピークで同音の連打を分割する", () => {
    const active = grid(12, 1, () => 0.9);
    const onset = grid(12, 1, (f) => (f === 0 || f === 6 ? 0.8 : f === 5 || f === 7 ? 0.3 : 0));
    expect(decodeNotes(active, onset, 12, 1).map((n) => [n.startFrame, n.endFrame])).toEqual([
      [0, 6],
      [6, 12],
    ]);
  });

  it("同点の隣接 bin は低い bin が勝つ", () => {
    const active = grid(6, 3, (_f, b) => (b >= 1 ? 0.8 : 0));
    const notes = decodeNotes(
      active,
      grid(6, 3, () => 0),
      6,
      3,
    );
    expect(notes.map((n) => n.bin)).toEqual([1]);
  });
});

// 学習側 decode_v2.py の出力を fixture 化したものと一致することで、Python と TS のデコーダの同一性を担保する
describe("decodeNotes fixture (decode_v2.py cross-check)", () => {
  type Case = {
    frames: number;
    bins: number;
    active: number[];
    onset: number[];
    params: DecodeParams;
    expected: { startFrame: number; endFrame: number; bin: number; confidence: number }[];
  };
  const cases = decodeCases as Case[];
  it("全ケースで start/end/bin/confidence が一致する", () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const got = decodeNotes(
        new Float32Array(c.active),
        new Float32Array(c.onset),
        c.frames,
        c.bins,
        c.params,
      );
      expect(got.map((n) => [n.startFrame, n.endFrame, n.bin])).toEqual(
        c.expected.map((n) => [n.startFrame, n.endFrame, n.bin]),
      );
      for (const [i, n] of got.entries()) {
        expect(n.confidence).toBeCloseTo(c.expected[i]!.confidence, 4);
      }
    }
  });
});
