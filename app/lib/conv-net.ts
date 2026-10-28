import type { MaybeYield } from "./cqt";

// (channel, frame, bin) の 3 次元テンソルに対する小さな 2D CNN の推論。PyTorch で学習した
// Conv2d(kernel=(kt, kb), padding=same, stride 1) の重みを JSON で受け取る

export type ConvLayer = {
  in: number;
  out: number;
  /** frame 方向 kernel 長 (奇数) */
  kt: number;
  /** bin 方向 kernel 長 (奇数) */
  kb: number;
  /** PyTorch と同じ [out][in][kt][kb] を平坦化した重み */
  w: number[];
  b: number[];
  act: "relu" | "none";
  /** dilation (省略時 1)。tap 間隔が dt / db になる */
  dt?: number;
  db?: number;
};

function dilation(l: ConvLayer): { dt: number; db: number } {
  return { dt: l.dt ?? 1, db: l.db ?? 1 };
}

export type ConvNet = {
  layers: ConvLayer[];
};

export function validateConvNet(net: ConvNet, inputChannels: number): void {
  let ch = inputChannels;
  for (const [i, l] of net.layers.entries()) {
    if (l.in !== ch) throw new Error(`conv-net: layer ${i} expects ${l.in} channels, got ${ch}`);
    if (l.kt % 2 !== 1 || l.kb % 2 !== 1) {
      throw new Error(`conv-net: layer ${i} kernel (${l.kt}, ${l.kb}) must be odd`);
    }
    if (l.w.length !== l.out * l.in * l.kt * l.kb || l.b.length !== l.out) {
      throw new Error(`conv-net: layer ${i} weight/bias size mismatch`);
    }
    const { dt, db } = dilation(l);
    if (!Number.isInteger(dt) || dt < 1 || !Number.isInteger(db) || db < 1) {
      throw new Error(`conv-net: layer ${i} dilation must be a positive integer`);
    }
    ch = l.out;
  }
}

// 各層の出力は frame 方向に (kt-1)/2 ずつ縮む (zero padding は bin 方向のみ)。呼び出し側は
// 前後にその分の halo を付けて chunk 処理し、中央部分だけを採用する
export function convNetHaloFrames(net: ConvNet): number {
  return net.layers.reduce((acc, l) => acc + (dilation(l).dt * (l.kt - 1)) / 2, 0);
}

export type Tensor = {
  channels: number;
  frames: number;
  bins: number;
  /** data[(c * frames + f) * bins + b] */
  data: Float32Array<ArrayBuffer>;
};

// async 関数内に置くと JIT 最適化が外れ 5 倍以上遅くなるため同期関数に分離
function accumulatePair(
  x: Tensor,
  l: ConvLayer,
  co: number,
  ci: number,
  out: Float32Array<ArrayBuffer>,
  frames: number,
): void {
  const { dt: dilT, db: dilB } = dilation(l);
  const hb = (dilB * (l.kb - 1)) / 2;
  const bins = x.bins;
  const w = l.w;
  const oBase = co * frames * bins;
  for (let dt = 0; dt < l.kt; dt++) {
    for (let db = 0; db < l.kb; db++) {
      const wv = w[((co * l.in + ci) * l.kt + dt) * l.kb + db]!;
      if (wv === 0) continue;
      const shift = db * dilB - hb;
      const b0 = Math.max(0, -shift);
      const b1 = Math.min(bins, bins - shift);
      for (let f = 0; f < frames; f++) {
        const iRow = (ci * x.frames + f + dt * dilT) * bins + shift;
        const oRow = oBase + f * bins;
        for (let b = b0; b < b1; b++) out[oRow + b] += wv * x.data[iRow + b]!;
      }
    }
  }
}

async function convLayer(x: Tensor, l: ConvLayer, maybeYield?: MaybeYield): Promise<Tensor> {
  const { dt: dilT } = dilation(l);
  const ht = (dilT * (l.kt - 1)) / 2;
  const frames = x.frames - 2 * ht;
  if (frames <= 0) throw new Error("conv-net: not enough frames for kernel");
  const bins = x.bins;
  const out = new Float32Array(l.out * frames * bins);
  for (let co = 0; co < l.out; co++) {
    out.fill(l.b[co]!, co * frames * bins, (co + 1) * frames * bins);
    for (let ci = 0; ci < l.in; ci++) {
      accumulatePair(x, l, co, ci, out, frames);
      // 1 (co, ci) 分 (数 ms) ごとに event loop へ制御を返す
      if (maybeYield) await maybeYield();
    }
  }
  if (l.act === "relu") {
    for (let i = 0; i < out.length; i++) if (out[i]! < 0) out[i] = 0;
  }
  return { channels: l.out, frames, bins, data: out };
}

// 入力 (channels × frames × bins) → 出力 (lastOut × (frames - 2·halo) × bins)
export async function runConvNet(
  net: ConvNet,
  x: Tensor,
  maybeYield?: MaybeYield,
): Promise<Tensor> {
  let cur = x;
  for (const l of net.layers) cur = await convLayer(cur, l, maybeYield);
  return cur;
}
