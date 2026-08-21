import { type CSSProperties, useEffect, useRef } from "react";
import type { NoteAnalysis, PartialFit } from "../lib/note-analysis";
import { HARMONIC_RGB, formatHz, noteName } from "./spectrogram";

const PLOT_W = 500;
const PLOT_H = 260;
const PAD_L = 38;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 18;
const LOW_SNR_DB = 10;

function partialColor(k: number): string {
  const [r, g, b] = HARMONIC_RGB[(k - 1) % HARMONIC_RGB.length]!;
  return `rgb(${r},${g},${b})`;
}

function centsFromNearestNote(freq: number): number {
  const midi = 69 + 12 * Math.log2(freq / 440);
  return (midi - Math.round(midi)) * 100;
}

function isWeak(p: PartialFit): boolean {
  return p.dbPerSec === null || p.snrDb < LOW_SNR_DB;
}

/** グリッドスナップ設定 (EDO + 基準周波数)。step 表示に使う */
export type NoteGrid = { edo: number; baseHz: number };

// partial ごとのエンベロープ (実線) + フィット直線 (破線) を重ね描きし、
// フィットの妥当性を目視検証するための canvas プロット
function EnvelopePlot({ analysis }: { analysis: NoteAnalysis }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dt = analysis.envStride / analysis.frameRate;
    const tMax = Math.max(dt, ...analysis.partials.map((p) => p.envelopeDb.length * dt));
    const allDb = analysis.partials.flatMap((p) => p.envelopeDb.filter(Number.isFinite));
    if (allDb.length === 0) return;
    const dbMax = Math.max(...allDb) + 3;
    const dbMin = Math.max(Math.min(...allDb), dbMax - 100);
    const x = (t: number) => PAD_L + ((PLOT_W - PAD_L - PAD_R) * t) / tMax;
    const y = (db: number) =>
      PAD_T + (PLOT_H - PAD_T - PAD_B) * (1 - (db - dbMin) / (dbMax - dbMin));

    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, PLOT_W, PLOT_H);

    ctx.strokeStyle = "#333";
    ctx.fillStyle = "#999";
    ctx.font = "10px sans-serif";
    ctx.lineWidth = 1;
    for (let db = Math.ceil(dbMin / 20) * 20; db <= dbMax; db += 20) {
      ctx.beginPath();
      ctx.moveTo(PAD_L, y(db));
      ctx.lineTo(PLOT_W - PAD_R, y(db));
      ctx.stroke();
      ctx.fillText(`${db}dB`, 2, y(db) + 3);
    }
    const tStep = tMax > 2 ? 1 : tMax > 0.8 ? 0.5 : 0.1;
    for (let t = 0; t <= tMax; t += tStep) {
      ctx.beginPath();
      ctx.moveTo(x(t), PAD_T);
      ctx.lineTo(x(t), PLOT_H - PAD_B);
      ctx.stroke();
      ctx.fillText(`${t.toFixed(1)}s`, x(t) + 2, PLOT_H - 6);
    }

    // onset 縦線
    ctx.strokeStyle = "#e11d48";
    ctx.beginPath();
    ctx.moveTo(x(analysis.onsetSec), PAD_T);
    ctx.lineTo(x(analysis.onsetSec), PLOT_H - PAD_B);
    ctx.stroke();

    for (const p of analysis.partials) {
      const color = partialColor(p.k);
      ctx.strokeStyle = color;
      ctx.globalAlpha = isWeak(p) ? 0.35 : 1;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([]);
      ctx.beginPath();
      for (const [i, db] of p.envelopeDb.entries()) {
        const px = x(i * dt);
        const py = y(Math.max(db, dbMin));
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      if (
        p.dbPerSec !== null &&
        p.interceptDb !== null &&
        p.fitStartSec !== null &&
        p.fitEndSec !== null
      ) {
        const t0 = p.fitStartSec;
        const t1 = p.fitEndSec;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(x(t0), y(Math.max(p.interceptDb + p.dbPerSec * t0, dbMin)));
        ctx.lineTo(x(t1), y(Math.max(p.interceptDb + p.dbPerSec * t1, dbMin)));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;
  }, [analysis]);

  return (
    <canvas
      ref={canvasRef}
      width={PLOT_W}
      height={PLOT_H}
      aria-label="partial ごとの減衰エンベロープとフィット直線"
      style={{ width: "100%", maxWidth: PLOT_W, borderRadius: 4 }}
    />
  );
}

const cellStyle: CSSProperties = {
  padding: "1px 8px",
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};

export function NoteAnalysisPanel({
  analysis,
  grid,
}: {
  analysis: NoteAnalysis;
  grid?: NoteGrid | null;
}) {
  const durationSec =
    Math.max(0, ...analysis.partials.map((p) => p.envelopeDb.length)) *
    (analysis.envStride / analysis.frameRate);
  const f0Cents = centsFromNearestNote(analysis.f0Hz);
  const f0Step = grid ? Math.round(grid.edo * Math.log2(analysis.f0Hz / grid.baseHz)) : null;
  return (
    <div style={{ fontSize: 13 }}>
      <p style={{ margin: "0.5rem 0", display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <span>
          f0: <b>{analysis.f0Hz.toFixed(2)}Hz</b> ({noteName(analysis.f0Hz)}{" "}
          {f0Cents >= 0 ? "+" : ""}
          {f0Cents.toFixed(0)}c)
          {f0Step !== null && (
            <>
              {" "}
              <b>
                step {f0Step >= 0 ? "+" : ""}
                {f0Step}
              </b>
            </>
          )}
        </span>
        <span>
          B: {analysis.inharmonicityB === null ? "—" : analysis.inharmonicityB.toExponential(2)}
        </span>
        <span>onset: {analysis.onsetSec.toFixed(3)}s</span>
        <span>
          解析区間: {analysis.fitStartSec.toFixed(3)}〜{durationSec.toFixed(3)}s
        </span>
      </p>
      <EnvelopePlot analysis={analysis} />
      <table style={{ borderCollapse: "collapse", marginTop: 8, fontSize: 12 }}>
        <thead>
          <tr style={{ color: "#666", borderBottom: "1px solid #ddd" }}>
            <th style={cellStyle}>k</th>
            <th style={cellStyle}>freq</th>
            <th style={cellStyle}>cents</th>
            {grid && <th style={cellStyle}>Δstep</th>}
            <th style={cellStyle}>dB/s</th>
            <th style={cellStyle}>τ60</th>
            <th style={cellStyle}>R²</th>
            <th style={cellStyle}>SNR</th>
            <th style={cellStyle}>beat</th>
          </tr>
        </thead>
        <tbody>
          {analysis.partials.map((p) => {
            const dStep = grid ? (p.centsFromHarmonic / 1200) * grid.edo : null;
            return (
              <tr
                key={p.k}
                style={{
                  color: isWeak(p) || p.collided ? "#9ca3af" : "#222",
                  borderBottom: "1px solid #f0f0f0",
                }}
              >
                <td style={cellStyle}>
                  <span
                    aria-hidden="true"
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: partialColor(p.k),
                      marginRight: 4,
                    }}
                  />
                  {p.k}
                </td>
                <td style={cellStyle}>{formatHz(p.freqHz)}Hz</td>
                <td style={cellStyle}>
                  {p.centsFromHarmonic >= 0 ? "+" : ""}
                  {p.centsFromHarmonic.toFixed(1)}
                </td>
                {grid && (
                  <td
                    style={{
                      ...cellStyle,
                      color: dStep !== null && Math.abs(dStep) > 0.25 ? "#b45309" : undefined,
                    }}
                    title={
                      dStep !== null && Math.abs(dStep) > 0.25
                        ? "理想倍音からのずれが 0.25 step 超 (別の音/衝突の可能性)"
                        : undefined
                    }
                  >
                    {dStep! >= 0 ? "+" : ""}
                    {dStep!.toFixed(2)}
                  </td>
                )}
                <td style={cellStyle}>
                  {p.collided ? (
                    <span
                      title="尾部床判定: フィット上限以降も持続する同一周波数の背景 (ベース等) と分離できません"
                      style={{
                        background: "#e5e7eb",
                        color: "#6b7280",
                        borderRadius: 3,
                        padding: "0 4px",
                      }}
                    >
                      衝突
                    </span>
                  ) : p.dbPerSec === null ? (
                    "—"
                  ) : (
                    p.dbPerSec.toFixed(1)
                  )}
                </td>
                <td style={cellStyle}>{p.tau60Sec === null ? "—" : `${p.tau60Sec.toFixed(2)}s`}</td>
                {/* Theil-Sen は LS 最適でないため r2 は負になり得る。負値は無意味なので伏せる */}
                <td style={cellStyle}>{p.r2 === null || p.r2 < 0 ? "—" : p.r2.toFixed(2)}</td>
                <td style={cellStyle}>{p.snrDb.toFixed(0)}dB</td>
                <td style={cellStyle}>
                  {p.beat === null
                    ? "—"
                    : `${p.beat.hz.toFixed(1)}Hz (${p.beat.strength.toFixed(2)})`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
