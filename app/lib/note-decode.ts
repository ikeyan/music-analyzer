// 学習側 decode_v2.py と挙動を一致させる (note-decode-cases.json で検証)

export type DecodedNote = {
  /** 開始 frame (含む) */
  startFrame: number;
  /** 終了 frame (含まない) */
  endFrame: number;
  bin: number;
  /** 区間の active 確率平均 */
  confidence: number;
};

export type DecodeParams = {
  /** これ以上で note 開始 */
  onThreshold: number;
  /** これ未満で note 終了 (hysteresis) */
  offThreshold: number;
  /** onset 確率がこの値以上のピークで継続中の note を分割する */
  onsetThreshold: number;
  minFrames: number;
  /** active 確率の移動平均幅 (frame、奇数)。1 で無効 */
  smooth: number;
  /** onset ピークで分割するのに必要な経過 frame 数 */
  splitMinFrames: number;
  /** 同 bin で終了→開始の隙間がこれ以下なら結合 (0 で無効) */
  mergeGap: number;
  /** 結合先の開始 frame に onset ピークがあれば結合しない */
  mergeOnsetBlock: boolean;
  /** 結合後の最小長 (0 で無効) */
  minFramesFinal: number;
  /** 隣接 ±nmsBins bin で時間が重なる弱い note を落とす (0 で無効) */
  nmsBins: number;
  /** NMS の重なり判定: 短い方の長さに対する割合 */
  nmsOverlap: number;
  nmsMode: "mean" | "sum";
  /** 下の bin (harmOffsets 分) により強い note が重なっていれば落とす。null で無効 */
  harmMargin: number | null;
  harmOverlap: number;
  harmOffsets: number[];
  minConf: number;
  /** 開始 frame を最大この分だけ遡る (立ち上がりを含める) */
  backtrack: number;
  /** 直前 onsetSnap frame 内の onset ピークに開始を合わせる (0 で無効) */
  onsetSnap: number;
};

export const DEFAULT_DECODE_PARAMS: DecodeParams = {
  onThreshold: 0.5,
  offThreshold: 0.3,
  onsetThreshold: 0.5,
  minFrames: 3,
  smooth: 1,
  splitMinFrames: 1,
  mergeGap: 0,
  mergeOnsetBlock: true,
  minFramesFinal: 0,
  nmsBins: 0,
  nmsOverlap: 0.5,
  nmsMode: "mean",
  harmMargin: null,
  harmOverlap: 0.5,
  harmOffsets: [41, 65, 82],
  minConf: 0,
  backtrack: 0,
  onsetSnap: 0,
};

type Note = { start: number; end: number; bin: number; conf: number };

// frame 方向の移動平均 (両端は 0 padding)
function movingMean(
  active: Float32Array<ArrayBuffer>,
  frames: number,
  bins: number,
  w: number,
): Float32Array<ArrayBuffer> {
  if (w <= 1) return active;
  const k = Math.floor(w / 2);
  const out = new Float32Array(frames * bins);
  for (let b = 0; b < bins; b++) {
    let sum = 0;
    for (let f = 0; f < Math.min(frames, k); f++) sum += active[f * bins + b]!;
    for (let f = 0; f < frames; f++) {
      const add = f + k;
      if (add < frames) sum += active[add * bins + b]!;
      const drop = f - k - 1;
      if (drop >= 0) sum -= active[drop * bins + b]!;
      out[f * bins + b] = sum / w;
    }
  }
  return out;
}

function segments(
  active: Float32Array<ArrayBuffer>,
  onset: Float32Array<ArrayBuffer>,
  frames: number,
  bins: number,
  p: DecodeParams,
): Note[] {
  const notes: Note[] = [];
  const peakBin = (f: number, b: number): boolean => {
    const i = f * bins + b;
    const v = active[i]!;
    if (b > 0 && active[i - 1]! >= v) return false;
    if (b + 1 < bins && active[i + 1]! > v) return false;
    return true;
  };
  const peakOnset = (f: number, b: number): boolean => {
    const i = f * bins + b;
    const v = onset[i]!;
    if (v < p.onsetThreshold) return false;
    if (f > 0 && onset[i - bins]! > v) return false;
    if (f + 1 < frames && onset[i + bins]! >= v) return false;
    return true;
  };
  for (let b = 0; b < bins; b++) {
    let r0 = 0;
    while (r0 < frames) {
      if (active[r0 * bins + b]! < p.offThreshold) {
        r0++;
        continue;
      }
      let r1 = r0;
      while (r1 < frames && active[r1 * bins + b]! >= p.offThreshold) r1++;
      let start = -1;
      let sum = 0;
      let prevEnd = 0;
      for (let f = r0; f < r1; f++) {
        const v = active[f * bins + b]!;
        if (start < 0) {
          if (v >= p.onThreshold && peakBin(f, b)) {
            start = f;
            sum = v;
            let lo = Math.max(r0, prevEnd, f - p.backtrack);
            if (p.onsetSnap > 0) {
              for (let k = Math.max(r0, prevEnd, f - p.onsetSnap); k < f; k++) {
                if (peakOnset(k, b)) {
                  lo = k;
                  break;
                }
              }
            }
            if (lo < f) {
              start = lo;
              sum = 0;
              for (let k = lo; k <= f; k++) sum += active[k * bins + b]!;
            }
          }
          continue;
        }
        if (f - start >= p.splitMinFrames && peakOnset(f, b)) {
          if (f - start >= p.minFrames) {
            notes.push({ start, end: f, bin: b, conf: sum / (f - start) });
          }
          prevEnd = f;
          start = -1;
          sum = 0;
          if (v >= p.onThreshold) {
            start = f;
            sum = v;
          }
          continue;
        }
        sum += v;
      }
      if (start >= 0 && r1 - start >= p.minFrames) {
        notes.push({ start, end: r1, bin: b, conf: sum / (r1 - start) });
      }
      r0 = r1;
    }
  }
  return notes;
}

function mergeGaps(
  notes: Note[],
  onset: Float32Array<ArrayBuffer>,
  bins: number,
  p: DecodeParams,
): Note[] {
  if (p.mergeGap <= 0) return notes;
  const byBin = new Map<number, Note[]>();
  for (const n of notes.toSorted((a, b) => a.bin - b.bin || a.start - b.start)) {
    let list = byBin.get(n.bin);
    if (!list) byBin.set(n.bin, (list = []));
    list.push(n);
  }
  const out: Note[] = [];
  for (const [b, list] of byBin) {
    let cur = list[0]!;
    for (const n of list.slice(1)) {
      const blocked = p.mergeOnsetBlock && onset[n.start * bins + b]! >= p.onsetThreshold;
      if (n.start - cur.end <= p.mergeGap && !blocked) {
        const d0 = cur.end - cur.start;
        const d1 = n.end - n.start;
        cur = {
          start: cur.start,
          end: n.end,
          bin: b,
          conf: (cur.conf * d0 + n.conf * d1) / (d0 + d1),
        };
      } else {
        out.push(cur);
        cur = n;
      }
    }
    out.push(cur);
  }
  return out;
}

function overlap(a: Note, b: Note): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function nms(notes: Note[], p: DecodeParams): Note[] {
  if (p.nmsBins <= 0) return notes;
  const strength = (n: Note) => (p.nmsMode === "mean" ? n.conf : n.conf * (n.end - n.start));
  const order = notes
    .map((_, i) => i)
    .toSorted((i, j) => strength(notes[j]!) - strength(notes[i]!));
  const byBin = new Map<number, number[]>();
  notes.forEach((n, i) => {
    let list = byBin.get(n.bin);
    if (!list) byBin.set(n.bin, (list = []));
    list.push(i);
  });
  const alive = notes.map(() => true);
  for (const i of order) {
    if (!alive[i]) continue;
    const n = notes[i]!;
    for (let db = -p.nmsBins; db <= p.nmsBins; db++) {
      if (db === 0) continue;
      for (const j of byBin.get(n.bin + db) ?? []) {
        if (!alive[j] || j === i) continue;
        const m = notes[j]!;
        if (overlap(n, m) > p.nmsOverlap * Math.min(n.end - n.start, m.end - m.start))
          alive[j] = false;
      }
    }
  }
  return notes.filter((_, i) => alive[i]);
}

function suppressHarmonics(notes: Note[], p: DecodeParams): Note[] {
  if (p.harmMargin === null) return notes;
  const margin = p.harmMargin;
  const byBin = new Map<number, Note[]>();
  for (const n of notes) {
    let list = byBin.get(n.bin);
    if (!list) byBin.set(n.bin, (list = []));
    list.push(n);
  }
  return notes.filter((n) => {
    for (const off of p.harmOffsets) {
      for (const m of byBin.get(n.bin - off) ?? []) {
        if (overlap(n, m) > p.harmOverlap * (n.end - n.start) && m.conf >= n.conf + margin) {
          return false;
        }
      }
    }
    return true;
  });
}

export function decodeNotes(
  active: Float32Array<ArrayBuffer>,
  onset: Float32Array<ArrayBuffer>,
  frames: number,
  bins: number,
  p: DecodeParams = DEFAULT_DECODE_PARAMS,
): DecodedNote[] {
  const smoothed = movingMean(active, frames, bins, p.smooth);
  let notes = segments(smoothed, onset, frames, bins, p);
  notes = mergeGaps(notes, onset, bins, p);
  if (p.minFramesFinal > 0) notes = notes.filter((n) => n.end - n.start >= p.minFramesFinal);
  if (p.minConf > 0) notes = notes.filter((n) => n.conf >= p.minConf);
  notes = nms(notes, p);
  notes = suppressHarmonics(notes, p);
  return notes
    .toSorted((a, b) => a.start - b.start || a.bin - b.bin)
    .map((n) => ({ startFrame: n.start, endFrame: n.end, bin: n.bin, confidence: n.conf }));
}
