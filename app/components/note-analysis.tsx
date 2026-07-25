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
const FIT_SNR_MARGIN_DB = 6;

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

// フィット区間の終端をエンベロープから復元する (noiseDb = peakDb - snrDb、
// ピーク保存間引きなので peakDb は間引き後 max と一致する)
function fitEndSec(p: PartialFit, analysis: NoteAnalysis): number {
  const peakDb = Math.max(...p.envelopeDb);
  const noiseDb = peakDb - p.snrDb;
  const dt = analysis.envStride / analysis.frameRate;
  for (let i = p.envelopeDb.length - 1; i >= 0; i--) {
    if (p.envelopeDb[i]! > noiseDb + FIT_SNR_MARGIN_DB) return (i + 1) * dt;
  }
  return analysis.fitStartSec;
}

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

      if (p.dbPerSec !== null && p.interceptDb !== null) {
        const t0 = analysis.fitStartSec;
        const t1 = fitEndSec(p, analysis);
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

export function NoteAnalysisPanel({ analysis }: { analysis: NoteAnalysis }) {
  const durationSec =
    Math.max(0, ...analysis.partials.map((p) => p.envelopeDb.length)) *
    (analysis.envStride / analysis.frameRate);
  const f0Cents = centsFromNearestNote(analysis.f0Hz);
  return (
    <div style={{ fontSize: 13 }}>
      <p style={{ margin: "0.5rem 0", display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <span>
          f0: <b>{analysis.f0Hz.toFixed(2)}Hz</b> ({noteName(analysis.f0Hz)}{" "}
          {f0Cents >= 0 ? "+" : ""}
          {f0Cents.toFixed(0)}c)
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
            <th style={cellStyle}>dB/s</th>
            <th style={cellStyle}>τ60</th>
            <th style={cellStyle}>R²</th>
            <th style={cellStyle}>SNR</th>
            <th style={cellStyle}>beat</th>
          </tr>
        </thead>
        <tbody>
          {analysis.partials.map((p) => (
            <tr
              key={p.k}
              style={{
                color: isWeak(p) ? "#9ca3af" : "#222",
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
              <td style={cellStyle}>{p.dbPerSec === null ? "—" : p.dbPerSec.toFixed(1)}</td>
              <td style={cellStyle}>{p.tau60Sec === null ? "—" : `${p.tau60Sec.toFixed(2)}s`}</td>
              <td style={cellStyle}>{p.r2 === null ? "—" : p.r2.toFixed(2)}</td>
              <td style={cellStyle}>{p.snrDb.toFixed(0)}dB</td>
              <td style={cellStyle}>
                {p.beat === null
                  ? "—"
                  : `${p.beat.hz.toFixed(1)}Hz (${p.beat.strength.toFixed(2)})`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
