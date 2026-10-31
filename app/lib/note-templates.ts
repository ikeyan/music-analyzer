// 曲内の音色テンプレート。学習側 train_timbre.py の song_templates / template_channels と
// 構成・順序まで同一でなければならない

import type { DecodedNote } from "./note-decode";

/** harmonic plane の正規化値 ((dB + offset) / scale) を返す */
export type PlaneReader = (plane: number, frame: number, bin: number) => number;

// ノート区間の両端 (立ち上がり / 減衰) を除いた中央部で平均する
export function noteProfiles(
  notes: DecodedNote[],
  planes: number,
  frames: number,
  bins: number,
  read: PlaneReader,
): Float32Array<ArrayBuffer>[] {
  const out: Float32Array<ArrayBuffer>[] = [];
  for (const n of notes) {
    const a = n.startFrame + 2;
    const b = Math.max(a + 1, n.endFrame - 1);
    if (b > frames || n.bin >= bins) continue;
    const prof = new Float32Array(planes);
    for (let h = 0; h < planes; h++) {
      let sum = 0;
      for (let f = a; f < b; f++) sum += read(h, f, n.bin);
      prof[h] = sum / (b - a);
    }
    const base = prof[0]!;
    for (let h = 0; h < planes; h++) prof[h]! -= base;
    out.push(prof);
  }
  return out;
}

// pass 2 は channel 順に依存するため初期化・出力順とも train_timbre.py の kmeans と同一に保つ
export function kmeansProfiles(
  profiles: Float32Array<ArrayBuffer>[],
  k: number,
  iterations = 30,
): Float32Array<ArrayBuffer>[] {
  const dim = profiles[0]?.length ?? 0;
  const pts = profiles.slice();
  while (pts.length < k) pts.push(new Float32Array(dim));
  const sum = (p: Float32Array<ArrayBuffer>) => p.reduce((a, v) => a + v, 0);
  const order = pts.map((_, i) => i).toSorted((i, j) => sum(pts[i]!) - sum(pts[j]!));
  const centers = Array.from({ length: k }, (_, c) =>
    Float32Array.from(pts[order[Math.floor(((c + 0.5) * pts.length) / k)]!]!),
  );
  const labels = new Int32Array(pts.length);
  for (let it = 0; it < iterations; it++) {
    for (const [i, p] of pts.entries()) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        let d = 0;
        for (let h = 0; h < dim; h++) d += (p[h]! - centers[c]![h]!) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      labels[i] = best;
    }
    for (let c = 0; c < k; c++) {
      const acc = new Float32Array(dim);
      let n = 0;
      for (const [i, p] of pts.entries()) {
        if (labels[i] !== c) continue;
        for (let h = 0; h < dim; h++) acc[h]! += p[h]!;
        n++;
      }
      if (n > 0) for (let h = 0; h < dim; h++) centers[c]![h] = acc[h]! / n;
    }
  }
  return centers.toSorted((a, b) => sum(a) - sum(b));
}

// channel_k[f, b] = Σ_h (C_k[h] / ‖C_k‖) · (x_h[f, b] − x_1[f, b])
export function templateChannels(
  centers: Float32Array<ArrayBuffer>[],
  planes: number,
  frames: number,
  bins: number,
  read: PlaneReader,
): Float32Array<ArrayBuffer>[] {
  return centers.map((c) => {
    let norm = 0;
    for (let h = 0; h < planes; h++) norm += c[h]! ** 2;
    norm = Math.sqrt(norm) + 1e-6;
    const out = new Float32Array(frames * bins);
    for (let f = 0; f < frames; f++) {
      for (let b = 0; b < bins; b++) {
        const base = read(0, f, b);
        let acc = 0;
        for (let h = 1; h < planes; h++) acc += (c[h]! / norm) * (read(h, f, b) - base);
        out[f * bins + b] = acc;
      }
    }
    return out;
  });
}
