import { describe, expect, it } from "bun:test";
import { edo41StepToHz } from "./edo41";
import {
  MAX_NOTE_ANALYSIS_OPS,
  NOTE_BINS,
  NOTE_FIRST_STEP,
  NOTE_HOP,
  NOTE_SAMPLE_RATE,
  computeNotePlanes,
  estimateNoteOps,
  estimateNotes,
  noteCqtParams,
  noteModel,
  noteModelMacsPerCell,
  notesFromProbabilities,
  runNoteModel,
} from "./note-estimation";

function tone(steps: { step: number; from: number; to: number }[], seconds: number) {
  const x = new Float32Array(Math.round(seconds * NOTE_SAMPLE_RATE));
  for (const { step, from, to } of steps) {
    const f = edo41StepToHz(step);
    const i0 = Math.round(from * NOTE_SAMPLE_RATE);
    const i1 = Math.min(x.length, Math.round(to * NOTE_SAMPLE_RATE));
    for (let i = i0; i < i1; i++) {
      const t = i / NOTE_SAMPLE_RATE;
      // 倍音付き (学習データのシンセ音に寄せる)
      for (let h = 1; h <= 6; h++) {
        x[i] += (0.5 / h) * Math.sin(2 * Math.PI * f * h * t);
      }
    }
  }
  return x;
}

describe("note-estimation", () => {
  it("解析格子: bin 0 = C1、harmonic plane は 20kHz 以下に octave を絞る", () => {
    expect(noteCqtParams(1).octaves).toBe(7);
    expect(noteCqtParams(1).fminHz).toBeCloseTo(32.7032, 3);
    for (const h of noteModel.input.harmonics) {
      const p = noteCqtParams(h);
      expect(
        p.fminHz * 2 ** ((p.octaves * p.binsPerOctave - 1) / p.binsPerOctave),
      ).toBeLessThanOrEqual(20000);
    }
  });

  it("演算量見積もりは CNN 推論分を含み、上限は数分の音声を通す", () => {
    const samples = 60 * NOTE_SAMPLE_RATE;
    const frames = Math.floor(samples / NOTE_HOP) + 1;
    expect(estimateNoteOps(samples)).toBeGreaterThan(
      2 * frames * NOTE_BINS * noteModelMacsPerCell(),
    );
    expect(estimateNoteOps(5 * 60 * NOTE_SAMPLE_RATE)).toBeLessThan(MAX_NOTE_ANALYSIS_OPS);
    expect(estimateNoteOps(60 * 60 * NOTE_SAMPLE_RATE)).toBeGreaterThan(MAX_NOTE_ANALYSIS_OPS);
  });

  it("plane は frame-major の u8 で frames = floor(n/hop)+1", async () => {
    const x = new Float32Array(NOTE_HOP * 10 + 5);
    const { frames, planes } = await computeNotePlanes(x);
    expect(frames).toBe(11);
    expect(planes.length).toBe(noteModel.input.harmonics.length);
    for (const p of planes) expect(p.length).toBe(frames * NOTE_BINS);
  });

  it("推論は chunk 境界を跨いでも連続で、確率は (0,1) に収まる", async () => {
    // INFER_CHUNK_FRAMES (512) を跨ぐ長さ
    const x = tone([{ step: 164, from: 0, to: 6.5 }], 6.5);
    const planes = await computeNotePlanes(x);
    const prob = await runNoteModel(planes);
    expect(prob.model).toBe(noteModel.pass1!);
    expect(prob.frames).toBe(planes.frames);
    let ok = true;
    for (let i = 0; i < prob.active.length; i++) {
      const a = prob.active[i]!;
      const o = prob.onset[i]!;
      if (!(a > 0 && a < 1 && o > 0 && o < 1)) ok = false;
    }
    expect(ok).toBe(true);
    // 定常音の中央付近では chunk 境界 (frame 512) の前後で active 確率がほぼ同じ
    const bin = 164 - NOTE_FIRST_STEP;
    const before = prob.active[511 * NOTE_BINS + bin]!;
    const after = prob.active[512 * NOTE_BINS + bin]!;
    expect(Math.abs(before - after)).toBeLessThan(0.1);
  }, 60_000);

  it("C4 → G4 の 2 音を順に鳴らすと各 step のノートが得られる", async () => {
    const x = tone(
      [
        { step: 164, from: 0.1, to: 1.0 },
        { step: 164 + 24, from: 1.2, to: 2.1 },
      ],
      2.3,
    );
    const result = await estimateNotes(x);
    expect(result.edo).toBe(41);
    expect(result.durationSec).toBeCloseTo(2.3, 3);
    const strong = result.notes.filter((n) => n.offsetSec - n.onsetSec > 0.3);
    const steps = strong.map((n) => n.step);
    expect(steps).toContain(164);
    expect(steps).toContain(164 + 24);
    const c4 = strong.find((n) => n.step === 164)!;
    expect(c4.onsetSec).toBeGreaterThan(0.0);
    expect(c4.onsetSec).toBeLessThan(0.3);
    expect(c4.hz).toBeCloseTo(261.6256, 2);
  }, 30_000);

  it("notesFromProbabilities は frame → 秒に変換し offset を duration で丸める", () => {
    // モデル JSON のデコードパラメータ (平滑化 9 frame / backtrack 5 / 最短 8 frame) を通る長さにする
    const frames = 40;
    const active = new Float32Array(frames * NOTE_BINS);
    const onset = new Float32Array(frames * NOTE_BINS);
    for (let f = 10; f < 30; f++) active[f * NOTE_BINS + 5] = 0.9;
    const secPerFrame = NOTE_HOP / NOTE_SAMPLE_RATE;
    const r = notesFromProbabilities({ frames, active, onset }, 0.3);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]!.step).toBe(NOTE_FIRST_STEP + 5);
    // 平滑化と backtrack で onset は ±5 frame の範囲で前後する
    expect(Math.abs(r.notes[0]!.onsetSec - 10 * secPerFrame)).toBeLessThanOrEqual(5 * secPerFrame);
    // 減衰後の終端 (30 frame 超) は durationSec で丸められる
    expect(r.notes[0]!.offsetSec).toBe(0.3);
  });
});
