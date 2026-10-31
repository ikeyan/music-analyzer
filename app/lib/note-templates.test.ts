import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import { kmeansProfiles, noteProfiles, templateChannels } from "./note-templates";

describe("note-templates", () => {
  it("noteProfiles はノート中央区間の plane 平均を h=1 相対で返し、短い区間や範囲外は捨てる", () => {
    // plane h の値 = h * 10 + frame (frame 依存は平均で消えない → 中央区間 [2, end-1) の平均)
    const read = (h: number, f: number) => h * 10 + f;
    const profs = noteProfiles(
      [
        { startFrame: 0, endFrame: 10, bin: 3, confidence: 1 },
        { startFrame: 0, endFrame: 10, bin: 99, confidence: 1 }, // bin 範囲外
        { startFrame: 95, endFrame: 100, bin: 1, confidence: 1 }, // frame 範囲外 (b > frames)
      ],
      3,
      98,
      8,
      read,
    );
    expect(profs).toHaveLength(1);
    // frame 2..8 の平均 = 5 → [0+5, 10+5, 20+5] - 5 = [0, 10, 20]
    expect(Array.from(profs[0]!)).toEqual([0, 10, 20]);
  });

  // 性質: 2 つの離れたクラスタからなる点群は K=2 でちょうどその 2 中心に収束し、明るい順に並ぶ
  // 入力: 中心 a < b (差 ≥ 2)、各クラスタ 3〜8 点、ばらつき ±0.1
  it("kmeansProfiles は分離した 2 クラスタを見つけ明るさ順に返す", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -5, max: 0 }),
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 3, max: 8 }),
        fc.integer({ min: 3, max: 8 }),
        (a, gap, na, nb) => {
          const b = a + gap;
          const pts = [
            ...Array.from({ length: na }, (_, i) =>
              Float32Array.from([0, a + 0.1 * (i % 3) - 0.1]),
            ),
            ...Array.from({ length: nb }, (_, i) =>
              Float32Array.from([0, b + 0.1 * (i % 3) - 0.1]),
            ),
          ];
          const c = kmeansProfiles(pts, 2);
          expect(c).toHaveLength(2);
          expect(c[0]![1]).toBeCloseTo(a, 0);
          expect(c[1]![1]).toBeCloseTo(b, 0);
          expect(c[0]![1]).toBeLessThan(c[1]![1]!);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("プロファイルが K 未満なら 0 プロファイルで埋める", () => {
    const c = kmeansProfiles([Float32Array.from([0, 2, 2])], 3);
    expect(c).toHaveLength(3);
    expect(c.map((v) => Array.from(v))).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 2, 2],
    ]);
  });

  it("templateChannels はテンプレートの単位ベクトルと h=1 相対プロファイルの内積", () => {
    // 2 bin × 1 frame、plane 値: h0 = 1、h1 = 1 + bin、h2 = 1 + 2·bin → 相対 [0, bin, 2bin]
    const read = (h: number, _f: number, b: number) => 1 + h * b;
    const [ch] = templateChannels([Float32Array.from([0, 3, 4])], 3, 1, 2, read);
    // bin 0: 0、bin 1: (3·1 + 4·2) / 5 = 2.2
    expect(ch![0]).toBeCloseTo(0, 5);
    expect(ch![1]).toBeCloseTo(2.2, 4);
  });
});
