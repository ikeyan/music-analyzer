import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import {
  type ConvLayer,
  type Tensor,
  convNetHaloFrames,
  runConvNet,
  validateConvNet,
} from "./conv-net";

function tensor(
  channels: number,
  frames: number,
  bins: number,
  fill: (c: number, f: number, b: number) => number,
): Tensor {
  const data = new Float32Array(channels * frames * bins);
  for (let c = 0; c < channels; c++) {
    for (let f = 0; f < frames; f++) {
      for (let b = 0; b < bins; b++) data[(c * frames + f) * bins + b] = fill(c, f, b);
    }
  }
  return { channels, frames, bins, data };
}

function delta(inC: number, outC: number, kt: number, kb: number): ConvLayer {
  // 中心 tap だけ 1 の恒等 kernel (in→out は ci === co のみ)
  const w = Array.from({ length: outC * inC * kt * kb }, () => 0);
  for (let co = 0; co < outC; co++) {
    if (co < inC) w[((co * inC + co) * kt + (kt - 1) / 2) * kb + (kb - 1) / 2] = 1;
  }
  return { in: inC, out: outC, kt, kb, w, b: Array.from({ length: outC }, () => 0), act: "none" };
}

describe("conv-net", () => {
  // 性質: 中心 tap のみ 1 の kernel は frame 方向の halo を落とした恒等写像
  // 入力: channels∈[1,3], frames∈[5,12], bins∈[1,6], kernel (kt,kb) ∈ {1,3,5}²
  it("恒等 kernel は halo を除いて入力をそのまま返す", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 5, max: 12 }),
        fc.integer({ min: 1, max: 6 }),
        fc.constantFrom(1, 3, 5),
        fc.constantFrom(1, 3, 5),
        async (c, frames, bins, kt, kb) => {
          const x = tensor(c, frames, bins, (ci, f, b) => ci * 100 + f * 10 + b);
          const net = { layers: [delta(c, c, kt, kb)] };
          validateConvNet(net, c);
          const y = await runConvNet(net, x);
          const halo = convNetHaloFrames(net);
          expect(y.frames).toBe(frames - 2 * halo);
          for (let ci = 0; ci < c; ci++) {
            for (let f = 0; f < y.frames; f++) {
              for (let b = 0; b < bins; b++) {
                expect(y.data[(ci * y.frames + f) * bins + b]).toBe(ci * 100 + (f + halo) * 10 + b);
              }
            }
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  it("bin 方向は zero padding、bias と ReLU が効く", async () => {
    // 1ch, 3 frames, 3 bins。kernel (1,3) = [1, 0, -1] (左隣 - 右隣) + bias
    const x = tensor(1, 3, 3, (_c, f, b) => f * 3 + b + 1); // rows: [1,2,3],[4,5,6],[7,8,9]
    const layer: ConvLayer = { in: 1, out: 1, kt: 1, kb: 3, w: [1, 0, -1], b: [0.5], act: "relu" };
    const y = await runConvNet({ layers: [layer] }, x);
    // out[b] = x[b-1] - x[b+1] + 0.5 → b=0: 0-2+.5=-1.5→0, b=1: 1-3+.5=-1.5→0, b=2: 2-0+.5=2.5
    expect(Array.from(y.data.subarray(0, 3))).toEqual([0, 0, 2.5]);
    expect(Array.from(y.data.subarray(6, 9))).toEqual([0, 0, 8.5]);
  });

  it("多層で channel が接続され halo が加算される", async () => {
    const net = { layers: [delta(2, 3, 3, 1), { ...delta(3, 1, 5, 3), act: "relu" as const }] };
    validateConvNet(net, 2);
    expect(convNetHaloFrames(net)).toBe(3);
    const x = tensor(2, 9, 2, (c, f) => (c === 0 ? f - 4 : 100));
    const y = await runConvNet(net, x);
    expect(y.channels).toBe(1);
    expect(y.frames).toBe(3);
    // ch0 の frame 3..5 → -1, 0, 1 を ReLU
    expect(Array.from(y.data)).toEqual([0, 0, 0, 0, 1, 1]);
  });

  it("dilation は tap 間隔を広げ halo も dilation 倍になる", async () => {
    // 1ch, kernel (3,3) dilation (2,2): taps at frame ±2, bin ±2。w = 中心 0、四隅 0、上下左右 1
    const w = [0, 1, 0, 1, 0, 1, 0, 1, 0];
    const layer: ConvLayer = { in: 1, out: 1, kt: 3, kb: 3, w, b: [0], act: "none", dt: 2, db: 2 };
    const net = { layers: [layer] };
    validateConvNet(net, 1);
    expect(convNetHaloFrames(net)).toBe(2);
    const x = tensor(1, 7, 5, (_c, f, b) => f * 10 + b);
    const y = await runConvNet(net, x);
    expect(y.frames).toBe(3);
    // 出力 frame 0 = 入力 frame 2: (f-2,b) + (f+2,b) + (f,b-2) + (f,b+2)、範囲外 bin は 0
    const at = (f: number, b: number) => y.data[f * 5 + b]!;
    const v = (f: number, b: number) => f * 10 + b;
    expect(at(0, 2)).toBe(v(0, 2) + v(4, 2) + v(2, 0) + v(2, 4));
    expect(at(0, 0)).toBe(v(0, 0) + v(4, 0) + 0 + v(2, 2));
    expect(at(2, 4)).toBe(v(2, 4) + v(6, 4) + v(4, 2) + 0);
  });

  // 性質: halo 分 0 埋めした入力 + valid 指定の結果は、層ごとに frame 方向も zero padding する
  //       (PyTorch の padding=same) 参照実装と一致する
  // 入力: 2 層 ReLU (bias 正)、frames∈[1,8]、kernel kt∈{1,3,5}、重みは小整数
  it("valid 指定時は層ごとの zero padding と一致する", async () => {
    const layerArb = (cin: number, cout: number) =>
      fc
        .record({
          kt: fc.constantFrom(1, 3, 5),
          w: fc.array(fc.integer({ min: -2, max: 2 }), { minLength: 75, maxLength: 75 }),
          b: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: cout, maxLength: cout }),
        })
        .map(
          ({ kt, w, b }): ConvLayer => ({
            in: cin,
            out: cout,
            kt,
            kb: 1,
            w: w.slice(0, cout * cin * kt),
            b,
            act: "relu",
          }),
        );
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        layerArb(1, 2),
        layerArb(2, 1),
        fc.array(fc.integer({ min: -3, max: 3 }), { minLength: 8, maxLength: 8 }),
        async (frames, l1, l2, xs) => {
          const net = { layers: [l1, l2] };
          const halo = convNetHaloFrames(net);
          const padded = tensor(1, frames + 2 * halo, 1, (_c, f) =>
            f >= halo && f < halo + frames ? xs[f - halo]! : 0,
          );
          const y = await runConvNet(net, padded, undefined, { start: halo, end: halo + frames });
          let ref = tensor(1, frames, 1, (_c, f) => xs[f]!);
          for (const l of net.layers) {
            const h = (l.kt - 1) / 2;
            ref = tensor(l.out, frames, 1, (co, f) => {
              let acc = l.b[co]!;
              for (let ci = 0; ci < l.in; ci++) {
                for (let t = 0; t < l.kt; t++) {
                  const g = f + t - h;
                  if (g >= 0 && g < frames)
                    acc += l.w[(co * l.in + ci) * l.kt + t]! * ref.data[ci * frames + g]!;
                }
              }
              return Math.max(0, acc);
            });
          }
          expect(Array.from(y.data)).toEqual(Array.from(ref.data));
        },
      ),
      { numRuns: 30 },
    );
  });

  it("validateConvNet は channel / kernel 不整合を弾く", () => {
    expect(() => validateConvNet({ layers: [delta(2, 1, 3, 3)] }, 1)).toThrow(/channels/);
    expect(() => validateConvNet({ layers: [delta(1, 1, 2, 3)] }, 1)).toThrow(/odd/);
    const bad = delta(1, 1, 3, 3);
    expect(() => validateConvNet({ layers: [{ ...bad, w: bad.w.slice(1) }] }, 1)).toThrow(
      /mismatch/,
    );
  });
});
