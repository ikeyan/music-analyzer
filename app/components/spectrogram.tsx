import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { ApiAudio, ApiSpectrogram } from "../api/types";
import { MAX_SPECTROGRAM_BINS, type SpectrogramMeta } from "../lib/spectrogram";

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

const LENS_AXIS_W = 44;
const LENS_STRIPE_W = 16;
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
}: {
  spec: ApiSpectrogram;
  audio: ApiAudio;
  projT: number;
  yRatio: number | null;
  anchorX: number;
  anchorY: number;
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

  // layout は spec だけで決まる (meta 到着前にパネル寸法が変わらないように)
  const numH = spec.harmonics.length;
  const bins = spec.binsPerOctave * spec.octaves;
  const displayH = Math.min(320, Math.max(144, bins * 2));
  const canvasW = LENS_AXIS_W + numH * LENS_STRIPE_W;
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
    if (canvas.width !== canvasW) canvas.width = canvasW;
    if (canvas.height !== canvasH) canvas.height = canvasH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, canvasW, canvasH);

    const fps0 = meta.sampleRate / meta.hop;
    const frame = Math.min(meta.frames - 1, Math.max(0, Math.round(srcT * fps0)));
    const tileIdx = Math.floor(frame / meta.tileFrames);
    const offset = (frame - tileIdx * meta.tileFrames) * meta.bins;

    // 1 harmonic = 1px 列の ImageData を作って横に引き伸ばす
    const off = document.createElement("canvas");
    off.width = numH;
    off.height = bins;
    const octx = off.getContext("2d");
    if (!octx) return;
    const img = octx.createImageData(numH, bins);
    const px = img.data;
    for (let hi = 0; hi < numH; hi++) {
      const bytes = getTileBytes(`${spec.tileUrlBase}/${meta.harmonics[hi]}/0/${tileIdx}`);
      for (let b = 0; b < bins; b++) {
        const o = ((bins - 1 - b) * numH + hi) * 4;
        if (bytes) {
          const v = bytes[offset + b]!;
          px[o] = COLORMAP[v * 3]!;
          px[o + 1] = COLORMAP[v * 3 + 1]!;
          px[o + 2] = COLORMAP[v * 3 + 2]!;
        } else {
          px[o] = 70;
          px[o + 1] = 70;
          px[o + 2] = 70;
        }
        px[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.drawImage(off, 0, 0, numH, bins, LENS_AXIS_W, 0, numH * LENS_STRIPE_W, displayH);

    // 列区切り + オクターブ目盛 + harmonic ラベル
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath();
    for (let hi = 1; hi < numH; hi++) {
      const x = LENS_AXIS_W + hi * LENS_STRIPE_W + 0.5;
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
      ctx.beginPath();
      ctx.moveTo(LENS_AXIS_W, y + 0.5);
      ctx.lineTo(canvasW, y + 0.5);
      ctx.stroke();
      ctx.fillText(formatHz(spec.fminHz * 2 ** o), LENS_AXIS_W - 4, Math.max(6, y));
    }
    ctx.textAlign = "center";
    ctx.fillStyle = "#ccc";
    for (let hi = 0; hi < numH; hi++) {
      ctx.fillText(
        `×${meta.harmonics[hi]}`,
        LENS_AXIS_W + (hi + 0.5) * LENS_STRIPE_W,
        displayH + LENS_LABEL_H / 2 + 1,
      );
    }

    if (binSel !== null) {
      const rowH = displayH / bins;
      const y = displayH * (1 - (binSel + 1) / bins);
      ctx.strokeStyle = "#fff";
      ctx.strokeRect(LENS_AXIS_W + 0.5, y + 0.5, numH * LENS_STRIPE_W - 1, Math.max(1, rowH));
    }
  }, [meta, spec, srcT, binSel, tilesVersion, numH, bins, displayH, canvasW, canvasH]);

  const panelW = canvasW + 18;
  const panelH = canvasH + 40;
  let left = anchorX + 18;
  if (left + panelW > window.innerWidth - 8) left = anchorX - panelW - 12;
  const top = Math.max(8, Math.min(window.innerHeight - panelH - 8, anchorY - panelH / 2));

  const f0 = binSel === null ? null : spec.fminHz * 2 ** (binSel / spec.binsPerOctave);
  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 50,
        background: "rgba(17,17,17,0.95)",
        border: "1px solid #444",
        borderRadius: 6,
        padding: "4px 8px 6px",
        pointerEvents: "none",
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
      }}
    >
      <div
        style={{
          color: "#ddd",
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
          marginBottom: 2,
          whiteSpace: "nowrap",
        }}
      >
        t={srcT.toFixed(2)}s{f0 !== null && ` / f0候補 ${f0.toFixed(1)}Hz ${noteName(f0)}`}
      </div>
      <canvas ref={canvasRef} style={{ width: canvasW, height: canvasH, display: "block" }} />
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

// ModalShell (project-detail 側) の中身として描く。表示選択は audio ごとに 1 つ
export function SpectrogramDialogBody({
  audio,
  view,
  onChangeView,
  onCreate,
  onDelete,
}: {
  audio: ApiAudio;
  view: SpectrogramSelection | null;
  onChangeView: (v: SpectrogramSelection | null) => void;
  onCreate: (p: SpectrogramCreateParams) => Promise<{ ok: true } | { error: string }>;
  onDelete: (specId: string) => Promise<{ ok: true } | { error: string }>;
}) {
  const [binsPerOctave, setBinsPerOctave] = useState("12");
  const [octaves, setOctaves] = useState("7");
  const [fminHz, setFminHz] = useState("32.703");
  const [harmonics, setHarmonics] = useState<number[]>([1]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create(): Promise<void> {
    const b = Number(binsPerOctave);
    const o = Number(octaves);
    const f = Number(fminHz);
    if (!Number.isInteger(b) || b < 1 || !Number.isInteger(o) || o < 1) {
      setError("binsPerOctave / octaves は正の整数で指定してください");
      return;
    }
    if (!Number.isFinite(f) || f <= 0) {
      setError("fmin は正の有限数で指定してください");
      return;
    }
    if (harmonics.length === 0) {
      setError("harmonics を 1 つ以上選択してください");
      return;
    }
    setBusy("create");
    setError(null);
    const result = await onCreate({ binsPerOctave: b, octaves: o, fminHz: f, harmonics });
    setBusy(null);
    if ("error" in result) setError(result.error);
  }

  async function remove(specId: string): Promise<void> {
    if (!confirm("この spectrogram を削除しますか？")) return;
    setBusy(specId);
    setError(null);
    const result = await onDelete(specId);
    setBusy(null);
    if ("error" in result) setError(result.error);
    else if (view?.specId === specId) onChangeView(null);
  }

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
                {spec.status === "ready" && (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    表示
                    <select
                      value={selectValue}
                      onChange={(e) => {
                        const mode = e.target.value;
                        onChangeView(mode === "" ? null : { specId: spec.id, mode });
                      }}
                      disabled={busy !== null}
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
                  disabled={busy !== null || spec.status === "pending"}
                >
                  {busy === spec.id ? "削除中…" : "削除"}
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
              value={binsPerOctave}
              onChange={(e) => setBinsPerOctave(e.target.value)}
              disabled={busy !== null}
              style={{ width: 80 }}
            />
            <datalist id="bins-per-octave-presets">
              {[12, 19, 24, 31, 36, 41, 48, 53, 62, 72, 82].map((b) => (
                <option key={b} value={String(b)} />
              ))}
            </datalist>
          </label>
          <label style={specLabelStyle}>
            octaves
            <input
              type="number"
              min="1"
              max="10"
              step="1"
              value={octaves}
              onChange={(e) => setOctaves(e.target.value)}
              disabled={busy !== null}
              style={{ width: 64 }}
            />
          </label>
          <label style={specLabelStyle}>
            fmin (Hz)
            <input
              type="number"
              min="8"
              step="0.001"
              value={fminHz}
              onChange={(e) => setFminHz(e.target.value)}
              disabled={busy !== null}
              style={{ width: 100 }}
            />
          </label>
        </div>
        <p style={{ fontSize: 11, color: "#666", margin: "0.4rem 0 0" }}>
          n 平均律は bins/octave に n（細かくするならその倍数）を指定。最大 96、 bins/octave ×
          octaves ≤ {MAX_SPECTROGRAM_BINS}。
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
                checked={harmonics.includes(h)}
                onChange={(e) =>
                  setHarmonics((prev) =>
                    e.target.checked
                      ? [...prev, h].toSorted((a, b) => a - b)
                      : prev.filter((x) => x !== h),
                  )
                }
                disabled={busy !== null}
              />
              ×{h}
            </label>
          ))}
        </div>
        <p style={{ fontSize: 11, color: "#666", margin: "0.4rem 0" }}>
          harmonic CQT は選んだ各倍音 (fmin×h) ごとに CQT を計算します。複数選ぶと RGB
          合成表示が使えます。
        </p>
        <button type="button" onClick={create} disabled={busy !== null}>
          {busy === "create" ? "開始中…" : "生成開始"}
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
