import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { ApiAudio, ApiNoteEstimation, ApiSpectrogram } from "../api/types";
import { edo41StepToHz } from "../lib/edo41";
import type { NoteEstimationResult } from "../lib/note-estimation";

// 41edo ノート推定の結果 (notes.json) を CQT strip の上に重ねて描く overlay と、生成/削除 UI

const PREFETCH_PX = 256;
const notesCache = new Map<string, Promise<NoteEstimationResult>>();

function fetchNotes(est: ApiNoteEstimation): Promise<NoteEstimationResult> {
  let p = notesCache.get(est.id);
  if (!p) {
    p = fetch(est.notesUrl).then((r) => {
      if (!r.ok) throw new Error(`notes: HTTP ${r.status}`);
      return r.json() as Promise<NoteEstimationResult>;
    });
    p.catch(() => notesCache.delete(est.id));
    notesCache.set(est.id, p);
  }
  return p;
}

// 信頼度 → 色相 (低: 橙, 高: 黄緑)。spectrogram の暖色 colormap の上で見えるよう明度は高めに固定
function noteColor(confidence: number, alpha: number): string {
  const hue = 30 + 60 * Math.max(0, Math.min(1, (confidence - 0.5) * 2));
  return `hsla(${hue}, 100%, 70%, ${alpha})`;
}

export function NoteOverlay({
  estimation,
  spec,
  audio,
  pxPerSec,
  viewportLeft,
  viewportWidth,
  top,
  height,
}: {
  estimation: ApiNoteEstimation;
  /** 縦軸 (fmin / octaves) をこの spectrogram に合わせる */
  spec: ApiSpectrogram;
  audio: ApiAudio;
  pxPerSec: number;
  viewportLeft: number;
  viewportWidth: number;
  top: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [result, setResult] = useState<NoteEstimationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 切替直後に前の estimation の notes を描き続けないよう、取得中は空にする
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    fetchNotes(estimation)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [estimation]);

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
    if (!canvas || width <= 0 || height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    if (!result) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const dProj = audio.projEndSec - audio.projStartSec;
    const dSrc = audio.srcEndSec - audio.srcStartSec;
    if (dProj === 0 || dSrc === 0) return;
    // SpectrogramStrip と同じ src秒 → canvas x 変換 (逆再生は負の倍率)
    const s = dProj / dSrc;
    const xAt = (srcT: number) =>
      (audio.projStartSec + (srcT - audio.srcStartSec) * s) * pxPerSec - visLeft;
    const bins = spec.binsPerOctave * spec.octaves;
    const rowH = height / bins;
    // 41edo 1 step の高さ (spectrogram の bins/octave に依らない)
    const stepH = Math.max(2, height / spec.octaves / 41);
    for (const n of result.notes) {
      const xa = xAt(n.onsetSec);
      const xb = xAt(n.offsetSec);
      const x0 = Math.min(xa, xb);
      const x1 = Math.max(xa, xb);
      if (x1 < 0 || x0 > width) continue;
      const binF = spec.binsPerOctave * Math.log2(edo41StepToHz(n.step) / spec.fminHz);
      if (binF < -0.5 || binF > bins - 0.5) continue;
      const yc = height - (binF + 0.5) * rowH;
      const y0 = yc - stepH / 2;
      const w = Math.max(1, x1 - x0);
      ctx.fillStyle = noteColor(n.confidence, 0.35);
      ctx.fillRect(x0, y0, w, stepH);
      ctx.strokeStyle = noteColor(n.confidence, 0.95);
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(0, w - 1), Math.max(0, stepH - 1));
    }
  }, [result, spec, audio, pxPerSec, visLeft, width, height]);

  if (width <= 0) return null;
  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        data-testid="note-overlay"
        style={{
          position: "absolute",
          left: visLeft,
          top,
          width,
          height,
          pointerEvents: "none",
        }}
      />
      {error && (
        <div
          role="alert"
          style={{
            position: "absolute",
            left: Math.max(visLeft, viewportLeft) + 4,
            top: top + 4,
            fontSize: 11,
            color: "white",
            background: "rgba(200,0,0,0.8)",
            padding: "1px 4px",
            borderRadius: 3,
            pointerEvents: "none",
          }}
        >
          ノート推定の読み込みに失敗: {error}
        </div>
      )}
    </>
  );
}

function statusBadge(status: ApiNoteEstimation["status"]): { label: string; color: string } {
  switch (status) {
    case "pending":
      return { label: "推定中…", color: "#1f6feb" };
    case "ready":
      return { label: "完了", color: "#1a7f37" };
    case "failed":
      return { label: "失敗", color: "crimson" };
  }
}

export function NoteEstimationSection({
  audio,
  shownId,
  onChangeShown,
  onCreate,
  onDelete,
}: {
  audio: ApiAudio;
  /** overlay 表示中の estimation id */
  shownId: string | null;
  onChangeShown: (id: string | null) => void;
  onCreate: () => Promise<{ ok: true } | { error: string }>;
  onDelete: (noteId: string) => Promise<{ ok: true } | { error: string }>;
}) {
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const running = audio.noteEstimations.some((e) => e.status === "pending");

  async function create() {
    setCreating(true);
    setError(null);
    const result = await onCreate();
    setCreating(false);
    if ("error" in result) setError(result.error);
  }

  async function remove(noteId: string) {
    if (!confirm("このノート推定を削除しますか？")) return;
    setDeleting((cur) => new Set(cur).add(noteId));
    setError(null);
    const result = await onDelete(noteId);
    setDeleting((cur) => {
      const n = new Set(cur);
      n.delete(noteId);
      return n;
    });
    if ("error" in result) setError(result.error);
    else if (shownId === noteId) onChangeShown(null);
  }

  return (
    <section style={sectionStyle} aria-label="41edo ノート推定">
      <h3 style={h3Style}>41edo ノート推定</h3>
      <p style={{ fontSize: 12, color: "#666", margin: "0.25rem 0" }}>
        音声から 41 平均律のノート (onset / offset / step) を推定し、表示中の CQT
        の上に重ねます。表示には CQT spectrogram の表示が必要です。
      </p>
      {error && (
        <p role="alert" style={{ color: "crimson", fontSize: 12, margin: "0.25rem 0" }}>
          {error}
        </p>
      )}
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: "0.4rem" }}>
        {audio.noteEstimations.map((est) => {
          const badge = statusBadge(est.status);
          return (
            <li
              key={est.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                fontSize: 12,
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontFamily: "monospace" }}>
                {new Date(est.createdAt).toLocaleString()} ({est.modelVersion})
              </span>
              <span style={{ color: badge.color, fontWeight: 600 }}>{badge.label}</span>
              {est.status !== "failed" && (
                <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={shownId === est.id}
                    onChange={(e) => onChangeShown(e.target.checked ? est.id : null)}
                  />
                  重ねて表示
                </label>
              )}
              <button
                type="button"
                onClick={() => remove(est.id)}
                disabled={deleting.has(est.id) || est.status === "pending"}
              >
                {deleting.has(est.id) ? "削除中…" : "削除"}
              </button>
            </li>
          );
        })}
      </ul>
      <div style={{ marginTop: "0.5rem" }}>
        <button type="button" onClick={create} disabled={creating || running}>
          {creating ? "開始中…" : "ノート推定を実行"}
        </button>
      </div>
    </section>
  );
}

const sectionStyle: CSSProperties = {
  margin: "0.75rem 0",
  paddingTop: "0.75rem",
  borderTop: "1px solid #eee",
};

const h3Style: CSSProperties = {
  margin: "0 0 0.5rem",
  fontSize: 14,
};
