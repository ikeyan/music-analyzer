import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { ApiAudio, ApiSpectrogram } from "../api/types";
import { loadLocal, saveLocal } from "../lib/local-store";
import {
  MAX_SPECTROGRAM_BINS,
  MAX_SPECTROGRAM_FMAX_HZ,
  type SpectrogramMeta,
  cqtRangeFromCenter,
} from "../lib/spectrogram";

// audio track ごとに表示する spectrogram の選択。mode は "h{n}" (単一 harmonic) か
// "rgb" (先頭 3 harmonics を R/G/B に割り当てる合成表示)
export type SpectrogramSelection = { specId: string; mode: string };

export const SPECTROGRAM_STRIP_HEIGHT = 128;
const PREFETCH_PX = 256;
// 1 エントリが最大 ~1MiB (タイル) / ~4MiB (canvas) になりうるのでバイト予算で LRU する
const TILE_CACHE_MAX_BYTES = 64 << 20;
const CANVAS_CACHE_MAX_BYTES = 96 << 20;
const TILE_FAIL_COOLDOWN_MS = 10_000;

const metaCache = new Map<string, Promise<SpectrogramMeta>>();

function fetchMeta(spec: ApiSpectrogram): Promise<SpectrogramMeta> {
  let p = metaCache.get(spec.id);
  if (!p) {
    p = fetch(spec.metaUrl).then((r) => {
      if (!r.ok) throw new Error(`spectrogram meta: HTTP ${r.status}`);
      return r.json() as Promise<SpectrogramMeta>;
    });
    p.catch(() => metaCache.delete(spec.id));
    metaCache.set(spec.id, p);
  }
  return p;
}

// タイルバイト列の共有キャッシュ。Map の挿入順を LRU として使う
const tileBytes = new Map<string, Uint8Array>();
let tileBytesTotal = 0;
const tileInflight = new Set<string>();
const tileFailedUntil = new Map<string, number>();
const tileListeners = new Set<() => void>();

function putTileBytes(url: string, data: Uint8Array): void {
  tileBytes.set(url, data);
  tileBytesTotal += data.byteLength;
  while (tileBytesTotal > TILE_CACHE_MAX_BYTES) {
    const oldest = tileBytes.entries().next().value;
    if (!oldest) break;
    tileBytes.delete(oldest[0]);
    tileBytesTotal -= oldest[1].byteLength;
  }
}

function getTileBytes(url: string): Uint8Array | null {
  const hit = tileBytes.get(url);
  if (hit) {
    tileBytes.delete(url);
    tileBytes.set(url, hit);
    return hit;
  }
  const failedUntil = tileFailedUntil.get(url);
  if (failedUntil !== undefined && Date.now() < failedUntil) return null;
  if (!tileInflight.has(url)) {
    tileInflight.add(url);
    void (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          tileFailedUntil.set(url, Date.now() + TILE_FAIL_COOLDOWN_MS);
          return;
        }
        tileFailedUntil.delete(url);
        putTileBytes(url, new Uint8Array(await res.arrayBuffer()));
        for (const l of tileListeners) l();
      } catch {
        tileFailedUntil.set(url, Date.now() + TILE_FAIL_COOLDOWN_MS);
      } finally {
        tileInflight.delete(url);
      }
    })();
  }
  return null;
}

// inferno 風 colormap (256 段 RGB)
const COLORMAP: Uint8Array = (() => {
  const stops = [
    [0, 0, 4],
    [31, 12, 72],
    [85, 15, 109],
    [136, 34, 106],
    [186, 54, 85],
    [227, 89, 51],
    [249, 140, 10],
    [249, 201, 50],
    [252, 255, 164],
  ];
  const map = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const pos = (i / 255) * (stops.length - 1);
    const lo = Math.min(stops.length - 2, Math.floor(pos));
    const f = pos - lo;
    for (let c = 0; c < 3; c++) {
      map[i * 3 + c] = Math.round(stops[lo]![c]! * (1 - f) + stops[lo + 1]![c]! * f);
    }
  }
  return map;
})();

// swap 表示 (color=harmonic, 横位置=振幅) で harmonic ごとに割り当てる固定色
const HARMONIC_RGB: [number, number, number][] = [
  [255, 255, 255],
  [56, 189, 248],
  [250, 204, 21],
  [244, 114, 182],
  [74, 222, 128],
  [251, 146, 60],
  [167, 139, 250],
  [248, 113, 113],
];

function modeHarmonics(meta: SpectrogramMeta, mode: string): number[] {
  if (mode === "rgb") return meta.harmonics.slice(0, 3);
  const h = Number(mode.slice(1));
  return [meta.harmonics.includes(h) ? h : (meta.harmonics[0] ?? 1)];
}

const canvasCache = new Map<string, HTMLCanvasElement>();
let canvasCacheBytes = 0;

function putCanvas(key: string, canvas: HTMLCanvasElement): void {
  canvasCache.set(key, canvas);
  canvasCacheBytes += canvas.width * canvas.height * 4;
  while (canvasCacheBytes > CANVAS_CACHE_MAX_BYTES) {
    const oldest = canvasCache.entries().next().value;
    if (!oldest) break;
    canvasCache.delete(oldest[0]);
    canvasCacheBytes -= oldest[1].width * oldest[1].height * 4;
  }
}

// 必要タイルのバイト列が揃っていれば描画済み canvas を返す。未取得は fetch を蹴って null
function renderTile(
  spec: ApiSpectrogram,
  meta: SpectrogramMeta,
  mode: string,
  level: number,
  index: number,
): HTMLCanvasElement | null {
  const cacheKey = `${spec.id}:${mode}:${level}:${index}`;
  const cached = canvasCache.get(cacheKey);
  if (cached) {
    canvasCache.delete(cacheKey);
    canvasCache.set(cacheKey, cached);
    return cached;
  }
  const framesAtLevel = Math.ceil(meta.frames / 2 ** level);
  const frames = Math.min(meta.tileFrames, framesAtLevel - index * meta.tileFrames);
  if (frames <= 0) return null;
  const harmonics = modeHarmonics(meta, mode);
  const bytes: Uint8Array[] = [];
  let missing = false;
  for (const h of harmonics) {
    const b = getTileBytes(`${spec.tileUrlBase}/${h}/${level}/${index}`);
    if (b) bytes.push(b);
    else missing = true;
  }
  if (missing) return null;

  const bins = meta.bins;
  const canvas = document.createElement("canvas");
  canvas.width = frames;
  canvas.height = bins;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(frames, bins);
  const px = img.data;
  for (let y = 0; y < bins; y++) {
    const bin = bins - 1 - y;
    for (let x = 0; x < frames; x++) {
      const o = (y * frames + x) * 4;
      const i = x * bins + bin;
      if (mode === "rgb") {
        px[o] = bytes[0]?.[i] ?? 0;
        px[o + 1] = bytes[1]?.[i] ?? 0;
        px[o + 2] = bytes[2]?.[i] ?? 0;
      } else {
        const v = bytes[0]![i]!;
        px[o] = COLORMAP[v * 3]!;
        px[o + 1] = COLORMAP[v * 3 + 1]!;
        px[o + 2] = COLORMAP[v * 3 + 2]!;
      }
      px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  putCanvas(cacheKey, canvas);
  return canvas;
}

// timeline 座標 (px) 系で viewport 周辺だけ描画する spectrogram バンド。
// タイルは zoom に応じた pyramid level を選び、可視範囲 + PREFETCH_PX のみ lazy fetch
export function SpectrogramStrip({
  spec,
  mode,
  audio,
  pxPerSec,
  viewportLeft,
  viewportWidth,
  top,
  height,
}: {
  spec: ApiSpectrogram;
  mode: string;
  audio: ApiAudio;
  pxPerSec: number;
  viewportLeft: number;
  viewportWidth: number;
  top: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [meta, setMeta] = useState<SpectrogramMeta | null>(null);
  const [tilesVersion, setTilesVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchMeta(spec)
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [spec]);

  useEffect(() => {
    const bump = () => setTilesVersion((v) => v + 1);
    tileListeners.add(bump);
    return () => {
      tileListeners.delete(bump);
    };
  }, []);

  const projLow = Math.min(audio.projStartSec, audio.projEndSec);
  const projHigh = Math.max(audio.projStartSec, audio.projEndSec);
  const visLeft = Math.max(Math.floor(projLow * pxPerSec), Math.floor(viewportLeft - PREFETCH_PX));
  const visRight = Math.min(
    Math.ceil(projHigh * pxPerSec),
    Math.ceil(viewportLeft + viewportWidth + PREFETCH_PX),
  );
  const width = Math.max(0, visRight - visLeft);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !meta || width <= 0) return;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);

    const dProj = audio.projEndSec - audio.projStartSec;
    const dSrc = audio.srcEndSec - audio.srcStartSec;
    if (dProj === 0 || dSrc === 0) return;
    // s: src秒 → proj秒 の倍率 (逆再生は負)
    const s = dProj / dSrc;
    const srcAt = (px: number) =>
      audio.srcStartSec + ((visLeft + px) / pxPerSec - audio.projStartSec) / s;
    const srcA = srcAt(0);
    const srcB = srcAt(width);
    const srcLo = Math.max(0, Math.min(srcA, srcB));
    const srcHi = Math.min(meta.durationSec, Math.max(srcA, srcB));
    if (srcHi <= srcLo) return;

    const pxPerSrcSec = pxPerSec * Math.abs(s);
    const fps0 = meta.sampleRate / meta.hop;
    const level = Math.max(0, Math.min(meta.levels - 1, Math.ceil(Math.log2(fps0 / pxPerSrcSec))));
    const fps = fps0 / 2 ** level;
    const framesAtLevel = Math.ceil(meta.frames / 2 ** level);
    const f0 = Math.max(0, Math.floor(srcLo * fps));
    const f1 = Math.min(framesAtLevel, Math.ceil(srcHi * fps));
    if (f1 <= f0) return;

    for (let t = Math.floor(f0 / meta.tileFrames); t * meta.tileFrames < f1; t++) {
      const tile = renderTile(spec, meta, mode, level, t);
      if (!tile) continue;
      const sT0 = (t * meta.tileFrames) / fps;
      const sT1 = Math.min((t + 1) * meta.tileFrames, framesAtLevel) / fps;
      const x0 = (audio.projStartSec + (sT0 - audio.srcStartSec) * s) * pxPerSec - visLeft;
      const x1 = (audio.projStartSec + (sT1 - audio.srcStartSec) * s) * pxPerSec - visLeft;
      if (x1 >= x0) {
        ctx.drawImage(tile, x0, 0, x1 - x0, height);
      } else {
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(tile, -x0, 0, x0 - x1, height);
        ctx.restore();
      }
    }
  }, [
    spec,
    meta,
    mode,
    width,
    height,
    visLeft,
    pxPerSec,
    tilesVersion,
    audio.srcStartSec,
    audio.srcEndSec,
    audio.projStartSec,
    audio.projEndSec,
  ]);

  if (width <= 0) return null;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        left: visLeft,
        top,
        width,
        height,
        borderRadius: 4,
        pointerEvents: "none",
      }}
    />
  );
}

// track 行の pointer 位置。yRatio は spectrogram 帯内の縦位置 (0=上端)、帯外は null
export type LensHover = {
  projT: number;
  yRatio: number | null;
  clientX: number;
  clientY: number;
};

const LENS_AXIS_W = 58;
export const LENS_STRIPE_DEFAULT_W = 16;
export const LENS_STRIPE_MIN_W = 6;
export const LENS_STRIPE_MAX_W = 80;
const LENS_LABEL_H = 14;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function noteName(freq: number): string {
  const midi = Math.round(69 + 12 * Math.log2(freq / 440));
  if (!Number.isFinite(midi) || midi < 0 || midi > 127) return "";
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function formatHz(freq: number): string {
  return freq >= 1000 ? `${(freq / 1000).toFixed(1)}k` : `${Math.round(freq)}`;
}

// harmonic CQT lens: ポインタ時刻の縦スライスを harmonic ごとに並べる浮動パネル。
// 行 b は f0 候補 fmin*2^(b/B) で揃え、列 h はその第 h 倍音の強度 (= HCQT の depth 軸)。
// ピッチのある音は水平の明るい行になり、行に沿って倍音エンベロープが読める
export function HarmonicLens({
  spec,
  audio,
  projT,
  yRatio,
  anchorX,
  anchorY,
  placement = "float",
  title,
  fillHeight,
  swap = false,
  onToggleSwap,
  interactive = false,
  maxHarmonic,
  onSetMaxHarmonic,
  onHeightResize,
  stripeW = LENS_STRIPE_DEFAULT_W,
  onSetStripeW,
  onHoverYRatio,
}: {
  spec: ApiSpectrogram;
  audio: ApiAudio;
  projT: number;
  yRatio: number | null;
  // placement="float" では anchor 座標に fixed 配置、"inline" では親の flで横並び
  anchorX?: number;
  anchorY?: number;
  placement?: "float" | "inline";
  title?: string;
  // inline で pane 高さに合わせて縦に伸ばす CQT 描画高さ (px)
  fillHeight?: number;
  // swap: color=harmony・横位置(bar長)=振幅 に入れ替える (既定は color=振幅)
  swap?: boolean;
  onToggleSwap?: () => void;
  // float で pointer 操作を許可する (Ctrl/Cmd で追従停止して触れるようにするとき)
  interactive?: boolean;
  // 表示する倍音の上限。未計算の倍数は最近傍の計算済み plane を bin 方向に平行移動して近似
  maxHarmonic?: number;
  onSetMaxHarmonic?: (n: number) => void;
  // float で高さを変えるハンドル用 (現在の displayH を渡して新しい高さを返す)
  onHeightResize?: (h: number) => void;
  // 1 plane 幅 (project 共通)。内側四角形の右端ハンドルで変更する
  stripeW?: number;
  onSetStripeW?: (w: number) => void;
  // 内側 CQT を hover したときの縦位置 (0=上端, 1=下端)。null = leave
  onHoverYRatio?: (yRatio: number | null) => void;
}) {
  const heightDrag = useRef<{ sy: number; orig: number } | null>(null);
  const stripeDrag = useRef<{ sx: number; orig: number; last: number } | null>(null);
  // ドラッグ中だけ列レイアウトを固定したまま canvas を preview 幅で再描画する
  const [dragStripeW, setDragStripeW] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [meta, setMeta] = useState<SpectrogramMeta | null>(null);
  const [tilesVersion, setTilesVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchMeta(spec)
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [spec]);

  useEffect(() => {
    const bump = () => setTilesVersion((v) => v + 1);
    tileListeners.add(bump);
    return () => {
      tileListeners.delete(bump);
    };
  }, []);

  // layout は spec だけで決まる (meta 到着前にパネル寸法が変わらないように)。
  // 表示倍音は 1..maxH (既定は計算済み最大倍音)。未計算の倍数も列として出す
  const maxH = Math.max(1, Math.round(maxHarmonic ?? Math.max(...spec.harmonics)));
  const numH = maxH;
  const bins = spec.binsPerOctave * spec.octaves;
  const displayH = fillHeight ?? Math.min(320, Math.max(144, bins * 2));
  // 列footprintは commit 済み stripeW で決まる。ドラッグ中の canvas だけ preview 幅で描く
  const effStripeW = dragStripeW ?? stripeW;
  const canvasW = LENS_AXIS_W + numH * stripeW;
  const drawW = LENS_AXIS_W + numH * effStripeW;
  const canvasH = displayH + LENS_LABEL_H;

  const dProj = audio.projEndSec - audio.projStartSec;
  const dSrc = audio.srcEndSec - audio.srcStartSec;
  const srcT =
    dProj === 0 || dSrc === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            audio.durationSec,
            audio.srcStartSec + (projT - audio.projStartSec) * (dSrc / dProj),
          ),
        );
  const binSel =
    yRatio === null ? null : Math.min(bins - 1, Math.max(0, Math.floor((1 - yRatio) * bins)));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !meta) return;
    if (canvas.width !== drawW) canvas.width = drawW;
    if (canvas.height !== canvasH) canvas.height = canvasH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    const fps0 = meta.sampleRate / meta.hop;
    const frame = Math.min(meta.frames - 1, Math.max(0, Math.round(srcT * fps0)));
    const tileIdx = Math.floor(frame / meta.tileFrames);
    const frameInTile = frame - tileIdx * meta.tileFrames;

    // 各表示倍音 h の候補 source を「サブ bin 丸め誤差」昇順で並べる。描画時に bin ごとに
    // カバーできる最小誤差の source を選ぶ。harmonic plane は同一 VQT を log 周波数で
    // ずらしたものなので値はほぼ厳密に一致し、誤差は bin 丸めのみ (shift=B*log2(h/h0))。
    // base plane (h0=0, [fmin,Nyquist]) は全表示 bin を覆う fallback で高域切れを無くす
    const candidates: { h0: number; shift: number; err: number; planeBins: number }[][] = [];
    for (let hi = 0; hi < numH; hi++) {
      const h = hi + 1;
      const cs = meta.harmonics.map((h0) => {
        const s = spec.binsPerOctave * Math.log2(h / h0);
        const shift = Math.round(s);
        return { h0, shift, err: Math.abs(s - shift), planeBins: meta.bins };
      });
      if (meta.baseBins) {
        const s = spec.binsPerOctave * Math.log2(h);
        const shift = Math.round(s);
        cs.push({ h0: 0, shift, err: Math.abs(s - shift), planeBins: meta.baseBins });
      }
      cs.sort((a, b) => a.err - b.err);
      candidates.push(cs);
    }

    // 計算済み plane + base のタイルを集める。1 つでも未取得なら前フレーム保持
    const srcTiles = new Map<number, Uint8Array | null>();
    let anyMissing = false;
    for (const h0 of meta.baseBins ? [0, ...meta.harmonics] : meta.harmonics) {
      const b = getTileBytes(`${spec.tileUrlBase}/${h0}/0/${tileIdx}`);
      srcTiles.set(h0, b);
      if (!b) anyMissing = true;
    }
    if (anyMissing) return;

    const sampleAt = (hi: number, b: number): number => {
      for (const c of candidates[hi]!) {
        const rb = b + c.shift;
        if (rb >= 0 && rb < c.planeBins) {
          return srcTiles.get(c.h0)![frameInTile * c.planeBins + rb]!;
        }
      }
      return 0;
    };

    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, drawW, canvasH);

    // CQT 本体。通常は color=振幅 (harmonic ごとに 1px 列→引き伸ばし)。swap では
    // color=harmonic (固定色)・横方向の bar 長=振幅 にして、振幅を位置で読めるようにする
    const off = document.createElement("canvas");
    const octx = off.getContext("2d");
    if (!octx) return;
    if (swap) {
      const W = effStripeW;
      off.width = numH * W;
      off.height = bins;
      const img = octx.createImageData(numH * W, bins);
      const px = img.data;
      for (let hi = 0; hi < numH; hi++) {
        const c = HARMONIC_RGB[hi % HARMONIC_RGB.length]!;
        for (let b = 0; b < bins; b++) {
          const v = sampleAt(hi, b);
          const barLen = Math.round((v / 255) * W);
          const row = bins - 1 - b;
          for (let x = 0; x < W; x++) {
            const o = (row * numH * W + hi * W + x) * 4;
            const inBar = x < barLen;
            px[o] = inBar ? c[0] : 12;
            px[o + 1] = inBar ? c[1] : 12;
            px[o + 2] = inBar ? c[2] : 12;
            px[o + 3] = 255;
          }
        }
      }
      octx.putImageData(img, 0, 0);
      ctx.drawImage(off, 0, 0, numH * W, bins, LENS_AXIS_W, 0, numH * W, displayH);
    } else {
      off.width = numH;
      off.height = bins;
      const img = octx.createImageData(numH, bins);
      const px = img.data;
      for (let hi = 0; hi < numH; hi++) {
        for (let b = 0; b < bins; b++) {
          const o = ((bins - 1 - b) * numH + hi) * 4;
          const v = sampleAt(hi, b);
          px[o] = COLORMAP[v * 3]!;
          px[o + 1] = COLORMAP[v * 3 + 1]!;
          px[o + 2] = COLORMAP[v * 3 + 2]!;
          px[o + 3] = 255;
        }
      }
      octx.putImageData(img, 0, 0);
      ctx.drawImage(off, 0, 0, numH, bins, LENS_AXIS_W, 0, numH * effStripeW, displayH);
    }

    // 列区切り + オクターブ目盛 + harmonic ラベル
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath();
    for (let hi = 1; hi < numH; hi++) {
      const x = LENS_AXIS_W + hi * effStripeW + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, displayH);
    }
    ctx.stroke();
    ctx.font = "9px system-ui, sans-serif";
    ctx.fillStyle = "#aaa";
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (let o = 0; o <= spec.octaves; o++) {
      const y = Math.round(displayH * (1 - (o * spec.binsPerOctave) / bins));
      const f = spec.fminHz * 2 ** o;
      ctx.beginPath();
      ctx.moveTo(LENS_AXIS_W, y + 0.5);
      ctx.lineTo(drawW, y + 0.5);
      ctx.stroke();
      ctx.fillText(`${noteName(f)} ${formatHz(f)}`, LENS_AXIS_W - 4, Math.max(6, y));
    }
    ctx.textAlign = "center";
    // ×n が 1 plane 幅に収まらなくなったら間引く
    const labelStep = Math.max(1, Math.ceil(ctx.measureText(`×${numH}~`).width / effStripeW));
    for (let hi = 0; hi < numH; hi++) {
      if (hi % labelStep !== 0) continue;
      // 計算済み倍音は明るく、近似 (非計算 = shift で補間) は暗めで区別する
      const approx = !meta.harmonics.includes(hi + 1);
      ctx.fillStyle = approx ? "#7a7a7a" : "#ccc";
      ctx.fillText(
        `×${hi + 1}${approx ? "~" : ""}`,
        LENS_AXIS_W + (hi + 0.5) * effStripeW,
        displayH + LENS_LABEL_H / 2 + 1,
      );
    }

    if (binSel !== null) {
      const rowH = displayH / bins;
      const y = displayH * (1 - (binSel + 1) / bins);
      ctx.strokeStyle = "#fff";
      ctx.strokeRect(LENS_AXIS_W + 0.5, y + 0.5, numH * effStripeW - 1, Math.max(1, rowH));
      // 白線の左に 2 段ラベル: 上=step, 下=note + Hz
      const fSel = spec.fminHz * 2 ** (binSel / spec.binsPerOctave);
      const l1 = `${Math.floor(binSel / spec.binsPerOctave)}oct +${binSel % spec.binsPerOctave}/${spec.binsPerOctave}`;
      const l2 = `${noteName(fSel)} ${formatHz(fSel)}Hz`;
      const yc = y + rowH / 2;
      ctx.font = "8px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "alphabetic";
      const tw = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width);
      const rx = LENS_AXIS_W - 3;
      ctx.fillStyle = "rgba(0,0,0,0.82)";
      ctx.fillRect(rx - tw - 2, yc - 10, tw + 4, 20);
      ctx.fillStyle = "#fff";
      ctx.fillText(l1, rx, yc - 1);
      ctx.fillText(l2, rx, yc + 8);
    }
  }, [meta, spec, srcT, binSel, tilesVersion, numH, bins, displayH, drawW, canvasH, swap, effStripeW]);

  const panelW = canvasW + 18;
  const panelH = canvasH + 40;
  const floatStyle: CSSProperties =
    placement === "float"
      ? (() => {
          let left = (anchorX ?? 0) + 18;
          if (left + panelW > window.innerWidth - 8) left = (anchorX ?? 0) - panelW - 12;
          const top = Math.max(
            8,
            Math.min(window.innerHeight - panelH - 8, (anchorY ?? 0) - panelH / 2),
          );
          return { position: "fixed", left, top, zIndex: 50 };
        })()
      : { position: "relative", flex: "0 0 auto" };

  return (
    <div
      aria-hidden="true"
      style={{
        ...floatStyle,
        background: "rgba(17,17,17,0.95)",
        border: "1px solid #444",
        borderRadius: 6,
        padding: "4px 8px 6px",
        pointerEvents: placement === "inline" || interactive ? "auto" : "none",
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
      }}
    >
      {(onToggleSwap || onSetMaxHarmonic) && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: 2,
            right: 3,
            display: "flex",
            alignItems: "center",
            gap: 3,
            zIndex: 2,
          }}
        >
          {onSetMaxHarmonic && (
            <input
              type="number"
              min={1}
              max={32}
              value={maxH}
              aria-label="表示倍音の上限"
              title="表示する倍音の上限 (未計算の倍数は近似表示)"
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (Number.isFinite(n)) onSetMaxHarmonic(Math.max(1, Math.min(32, n)));
              }}
              style={{ width: 34, height: 15, fontSize: 10, padding: "0 2px" }}
            />
          )}
          {onToggleSwap && (
            <input
              type="checkbox"
              aria-label="振幅を位置で表示 (color↔harmony)"
              checked={swap}
              onChange={onToggleSwap}
              style={{ margin: 0, width: 12, height: 12, cursor: "pointer" }}
            />
          )}
        </div>
      )}
      {title && (
        <div
          style={{
            color: "#fff",
            fontSize: 11,
            fontWeight: 600,
            marginBottom: 2,
            maxWidth: Math.max(30, canvasW - 56),
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </div>
      )}
      {placement === "float" && (
        <div
          style={{
            color: "#ddd",
            fontSize: 11,
            fontVariantNumeric: "tabular-nums",
            marginBottom: 2,
            whiteSpace: "nowrap",
          }}
        >
          t={srcT.toFixed(2)}s
        </div>
      )}
      <div style={{ position: "relative", width: canvasW, height: canvasH }}>
        <canvas
          ref={canvasRef}
          onPointerMove={
            onHoverYRatio
              ? (e) => {
                  const oy = e.nativeEvent.offsetY;
                  onHoverYRatio(
                    oy >= 0 && oy <= displayH ? Math.min(1, Math.max(0, 1 - oy / displayH)) : null,
                  );
                }
              : undefined
          }
          onPointerLeave={onHoverYRatio ? () => onHoverYRatio(null) : undefined}
          style={{
            width: drawW,
            height: canvasH,
            display: "block",
            position: "absolute",
            left: 0,
            top: 0,
          }}
        />
        {onSetStripeW && (placement === "inline" || interactive) && (
          <div
            aria-hidden="true"
            onPointerDown={(e) => {
              stripeDrag.current = { sx: e.clientX, orig: stripeW, last: stripeW };
              e.currentTarget.setPointerCapture(e.pointerId);
              e.preventDefault();
              e.stopPropagation();
            }}
            onPointerMove={(e) => {
              const d = stripeDrag.current;
              if (!d) return;
              const w = Math.round(
                Math.max(
                  LENS_STRIPE_MIN_W,
                  Math.min(LENS_STRIPE_MAX_W, d.orig + (e.clientX - d.sx) / numH),
                ),
              );
              d.last = w;
              setDragStripeW(w);
            }}
            onPointerUp={(e) => {
              const d = stripeDrag.current;
              stripeDrag.current = null;
              try {
                e.currentTarget.releasePointerCapture(e.pointerId);
              } catch {}
              if (d) onSetStripeW(d.last);
              setDragStripeW(null);
            }}
            style={{
              position: "absolute",
              left: LENS_AXIS_W + numH * effStripeW - 3,
              top: 0,
              width: 7,
              height: displayH,
              cursor: "ew-resize",
              background: dragStripeW != null ? "rgba(120,180,255,0.5)" : "rgba(255,255,255,0.12)",
              zIndex: 3,
            }}
          />
        )}
      </div>
      {onHeightResize && interactive && (
        <div
          aria-hidden="true"
          onPointerDown={(e) => {
            heightDrag.current = { sy: e.clientY, orig: displayH };
            e.currentTarget.setPointerCapture(e.pointerId);
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerMove={(e) => {
            const d = heightDrag.current;
            if (!d) return;
            onHeightResize(Math.max(100, Math.min(800, d.orig + (e.clientY - d.sy))));
          }}
          onPointerUp={(e) => {
            heightDrag.current = null;
            try {
              e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {}
          }}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 9,
            cursor: "ns-resize",
            background: "rgba(255,255,255,0.15)",
          }}
        />
      )}
    </div>
  );
}

export type SpectrogramCreateParams = {
  binsPerOctave: number;
  octaves: number;
  fminHz: number;
  harmonics: number[];
};

const HARMONIC_CHOICES = [1, 2, 3, 4, 5, 6];

function specLabel(s: ApiSpectrogram): string {
  return `${s.binsPerOctave}bins/oct × ${s.octaves}oct, fmin=${s.fminHz}Hz, h=[${s.harmonics.join(",")}]`;
}

function statusBadge(status: ApiSpectrogram["status"]): { label: string; color: string } {
  switch (status) {
    case "pending":
      return { label: "生成中…", color: "#1f6feb" };
    case "ready":
      return { label: "完了", color: "#1a7f37" };
    case "failed":
      return { label: "失敗", color: "crimson" };
  }
}

type CqtForm = {
  binsPerOctave: string;
  centerHz: string;
  octavesDown: string;
  octavesUp: string;
  harmonics: number[];
};

const DEFAULT_CQT_FORM: CqtForm = {
  binsPerOctave: "12",
  centerHz: "440",
  octavesDown: "4",
  octavesUp: "4",
  harmonics: [1],
};

// ModalShell (project-detail 側) の中身として描く。表示選択は audio ごとに 1 つ。
// 生成フォームの値は projectId 単位で localStorage に保存して次回も引き継ぐ
export function SpectrogramDialogBody({
  projectId,
  audio,
  view,
  onChangeView,
  onCreate,
  onDelete,
}: {
  projectId: string;
  audio: ApiAudio;
  view: SpectrogramSelection | null;
  onChangeView: (v: SpectrogramSelection | null) => void;
  onCreate: (p: SpectrogramCreateParams) => Promise<{ ok: true } | { error: string }>;
  onDelete: (specId: string) => Promise<{ ok: true } | { error: string }>;
}) {
  const formKey = `cqtForm:${projectId}`;
  const [form, setForm] = useState<CqtForm>(() => ({
    ...DEFAULT_CQT_FORM,
    ...loadLocal<Partial<CqtForm>>(formKey, {}),
  }));
  // busy は操作単位で分ける: 生成中でも別 CQT の削除/表示切替を妨げないようにする
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    saveLocal(formKey, form);
  }, [formKey, form]);

  const setField = <K extends keyof CqtForm>(k: K, v: CqtForm[K]): void =>
    setForm((f) => ({ ...f, [k]: v }));

  async function create(): Promise<void> {
    const b = Number(form.binsPerOctave);
    const center = Number(form.centerHz);
    const down = Number(form.octavesDown);
    const up = Number(form.octavesUp);
    if (!Number.isInteger(b) || b < 1) {
      setError("bins/octave は正の整数で指定してください");
      return;
    }
    if (!Number.isInteger(down) || down < 0 || !Number.isInteger(up) || up < 0 || down + up < 1) {
      setError("オクターブ数は 0 以上の整数、上下合計 1 以上で指定してください");
      return;
    }
    if (!Number.isFinite(center) || center <= 0) {
      setError("中心周波数は正の有限数で指定してください");
      return;
    }
    if (center * 2 ** up > MAX_SPECTROGRAM_FMAX_HZ) {
      setError(`基本レンジ上端 (中心×2^上) は ${MAX_SPECTROGRAM_FMAX_HZ}Hz 以下にしてください`);
      return;
    }
    if (form.harmonics.length === 0) {
      setError("harmonics を 1 つ以上選択してください");
      return;
    }
    const { fminHz, octaves } = cqtRangeFromCenter(center, down, up);
    // h=1 は低域近似元として常に含める
    const harmonics = Array.from(new Set([1, ...form.harmonics])).toSorted((a, x) => a - x);
    setCreating(true);
    setError(null);
    const result = await onCreate({ binsPerOctave: b, octaves, fminHz, harmonics });
    setCreating(false);
    if ("error" in result) setError(result.error);
  }

  async function remove(specId: string): Promise<void> {
    if (!confirm("この spectrogram を削除しますか？")) return;
    setDeleting((d) => new Set(d).add(specId));
    setError(null);
    const result = await onDelete(specId);
    setDeleting((d) => {
      const n = new Set(d);
      n.delete(specId);
      return n;
    });
    if ("error" in result) setError(result.error);
    else if (view?.specId === specId) onChangeView(null);
  }

  const b = Number(form.binsPerOctave);
  const center = Number(form.centerHz);
  const down = Number(form.octavesDown);
  const up = Number(form.octavesUp);
  const formValid =
    Number.isInteger(b) &&
    b >= 1 &&
    Number.isInteger(down) &&
    down >= 0 &&
    Number.isInteger(up) &&
    up >= 0 &&
    down + up >= 1 &&
    Number.isFinite(center) &&
    center > 0;
  const { fminHz: derivedFmin, octaves: derivedOct } = formValid
    ? cqtRangeFromCenter(center, down, up)
    : { fminHz: Number.NaN, octaves: Number.NaN };
  const maxBinHz = formValid ? derivedFmin * 2 ** ((b * derivedOct - 1) / b) : Number.NaN;
  const baseTopHz = formValid ? center * 2 ** up : Number.NaN;
  const baseTopOver = formValid && baseTopHz > MAX_SPECTROGRAM_FMAX_HZ;

  return (
    <div>
      {error && (
        <p
          role="alert"
          style={{
            color: "crimson",
            background: "#fff5f5",
            border: "1px solid crimson",
            padding: "0.4rem 0.6rem",
            borderRadius: 4,
            margin: "0.5rem 0",
            fontSize: 13,
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </p>
      )}

      <section style={specSectionStyle}>
        <h3 style={specH3Style}>生成済み</h3>
        {audio.spectrograms.length === 0 && (
          <p style={{ fontSize: 12, color: "#666", margin: "0.25rem 0" }}>まだありません。</p>
        )}
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: "0.4rem" }}>
          {audio.spectrograms.map((spec) => {
            const badge = statusBadge(spec.status);
            const selectValue = view?.specId === spec.id ? view.mode : "";
            return (
              <li
                key={spec.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  fontSize: 12,
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontFamily: "monospace" }}>{specLabel(spec)}</span>
                <span style={{ color: badge.color, fontWeight: 600 }}>{badge.label}</span>
                {/* 生成中 (pending) でも表示を先に選べる: ready になった瞬間に反映される */}
                {spec.status !== "failed" && (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    表示
                    <select
                      value={selectValue}
                      onChange={(e) => {
                        const mode = e.target.value;
                        onChangeView(mode === "" ? null : { specId: spec.id, mode });
                      }}
                    >
                      <option value="">非表示</option>
                      {spec.harmonics.map((h) => (
                        <option key={h} value={`h${h}`}>
                          h{h} (×{h} 倍音)
                        </option>
                      ))}
                      {spec.harmonics.length >= 2 && (
                        <option value="rgb">
                          RGB 合成 (h{spec.harmonics.slice(0, 3).join(",h")})
                        </option>
                      )}
                    </select>
                  </label>
                )}
                <button
                  type="button"
                  onClick={() => remove(spec.id)}
                  disabled={deleting.has(spec.id) || spec.status === "pending"}
                >
                  {deleting.has(spec.id) ? "削除中…" : "削除"}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section style={specSectionStyle}>
        <h3 style={specH3Style}>新規生成</h3>
        <div style={specRowStyle}>
          <label style={specLabelStyle}>
            bins / octave
            <input
              type="number"
              min="1"
              max="96"
              step="1"
              list="bins-per-octave-presets"
              value={form.binsPerOctave}
              onChange={(e) => setField("binsPerOctave", e.target.value)}
              disabled={creating}
              style={{ width: 80 }}
            />
            <datalist id="bins-per-octave-presets">
              {[12, 19, 24, 31, 36, 41, 48, 53, 62, 72, 82].map((bpo) => (
                <option key={bpo} value={String(bpo)} />
              ))}
            </datalist>
          </label>
          <label style={specLabelStyle}>
            中心周波数 (Hz)
            <input
              type="number"
              min="1"
              step="0.001"
              value={form.centerHz}
              onChange={(e) => setField("centerHz", e.target.value)}
              disabled={creating}
              style={{ width: 100 }}
            />
          </label>
          <label style={specLabelStyle}>
            ↓ oct
            <input
              type="number"
              min="0"
              max="10"
              step="1"
              value={form.octavesDown}
              onChange={(e) => setField("octavesDown", e.target.value)}
              disabled={creating}
              style={{ width: 56 }}
            />
          </label>
          <label style={specLabelStyle}>
            ↑ oct
            <input
              type="number"
              min="0"
              max="10"
              step="1"
              value={form.octavesUp}
              onChange={(e) => setField("octavesUp", e.target.value)}
              disabled={creating}
              style={{ width: 56 }}
            />
          </label>
        </div>
        {formValid && (
          <p
            style={{ fontSize: 11, margin: "0.3rem 0 0", color: baseTopOver ? "crimson" : "#666" }}
          >
            範囲 {formatHz(derivedFmin)}Hz {noteName(derivedFmin)} 〜 {formatHz(maxBinHz)}Hz{" "}
            {noteName(maxBinHz)}（中心 {formatHz(center)}Hz {noteName(center)}、{derivedOct}oct ×{" "}
            {b}bins = {b * derivedOct} bins）
            {baseTopOver && ` — 上端 ${formatHz(baseTopHz)}Hz が ${MAX_SPECTROGRAM_FMAX_HZ}Hz 超`}
          </p>
        )}
        <p style={{ fontSize: 11, color: "#666", margin: "0.2rem 0 0" }}>
          n 平均律は bins/octave に n（細かくするならその倍数）を指定。最大 96、 bins/octave ×
          octaves ≤ {MAX_SPECTROGRAM_BINS}。オクターブ線は中心から上下に並びます。
        </p>
        <div style={{ ...specRowStyle, marginTop: "0.5rem" }}>
          <span style={{ fontSize: 12, color: "#444" }}>harmonics:</span>
          {HARMONIC_CHOICES.map((h) => (
            <label
              key={h}
              style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 12 }}
            >
              <input
                type="checkbox"
                checked={h === 1 || form.harmonics.includes(h)}
                onChange={(e) =>
                  setField(
                    "harmonics",
                    e.target.checked
                      ? [...form.harmonics, h].toSorted((a, x) => a - x)
                      : form.harmonics.filter((x) => x !== h),
                  )
                }
                // h=1 は低域の近似元として常に計算する (off 不可)
                disabled={creating || h === 1}
              />
              ×{h}
            </label>
          ))}
        </div>
        <p style={{ fontSize: 11, color: "#666", margin: "0.4rem 0" }}>
          harmonic CQT は選んだ各倍音 (中心×h) ごとに CQT を計算します。複数選ぶと RGB
          合成表示が使えます。×1 は低域の近似元として常に計算します。レンズでは未計算の
          倍数も、計算済み plane を bin 方向に平行移動して近似表示します。
          {MAX_SPECTROGRAM_FMAX_HZ}Hz を超える高域は自動で黒く（クランプ）表示されます。
        </p>
        <button type="button" onClick={create} disabled={creating || baseTopOver || !formValid}>
          {creating ? "開始中…" : "生成開始"}
        </button>
      </section>
    </div>
  );
}

const specSectionStyle: CSSProperties = {
  margin: "0.75rem 0",
  paddingTop: "0.75rem",
  borderTop: "1px solid #eee",
};

const specH3Style: CSSProperties = {
  margin: "0 0 0.5rem",
  fontSize: 14,
};

const specRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-end",
  gap: "0.6rem",
};

const specLabelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  fontSize: 12,
  color: "#444",
};
