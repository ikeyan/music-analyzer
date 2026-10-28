import {
  type ConvNet,
  type Tensor,
  convNetHaloFrames,
  runConvNet,
  validateConvNet,
} from "./conv-net";
import {
  type MaybeYield,
  autoGamma,
  computeCqt,
  estimateCqtOps,
  magnitudesToU8,
  padBinsToFull,
} from "./cqt";
import { EDO, edo41StepToHz } from "./edo41";
import noteModelJson from "./note-model.json";
import {
  type DecodeParams,
  DEFAULT_DECODE_PARAMS,
  type DecodedNote,
  decodeNotes,
} from "./note-decode";
import { kmeansProfiles, noteProfiles, templateChannels } from "./note-templates";
import { MAX_SPECTROGRAM_FMAX_HZ, safeCqtOctaves } from "./spectrogram";

// 解析格子は学習側 (scripts/note-model/hcqt-dump.ts) と同一でなければならない
export const NOTE_SAMPLE_RATE = 44100;
export const NOTE_HOP = 512;
export const NOTE_BINS_PER_OCTAVE = EDO;
export const NOTE_OCTAVES = 7;
export const NOTE_FIRST_STEP = EDO;
export const NOTE_FMIN_HZ = edo41StepToHz(NOTE_FIRST_STEP);
export const NOTE_BINS = NOTE_BINS_PER_OCTAVE * NOTE_OCTAVES;
export const NOTE_DB_MIN = -80;
export const NOTE_DB_MAX = 0;
// 推論 chunk (frame)。halo 分を前後に足して境界の畳み込みを埋める
const INFER_CHUNK_FRAMES = 512;
// pass 1 の検出がこれ未満だと音色テンプレート (k-means) が意味を持たないので pass 1 の結果を使う
const MIN_TEMPLATE_NOTES = 8;

export type ConvModel = {
  input: {
    harmonics: number[];
    /** 追加入力: plane h を bin 方向に shift した channel (負 = 低域側の値を見る) */
    shifts: { harmonic: number; bins: number }[];
    dbMin: number;
    dbMax: number;
    offset: number;
    scale: number;
    /** "frame": 各 frame の h=1 channel の最大値を全 channel から引く (学習側 Net.features と同じ) */
    norm?: "none" | "frame";
    /** 曲内音色テンプレート channel 数 (pass 1 の検出から k-means。0/省略で無し) */
    templates?: number;
  };
  layers: ConvNet["layers"];
  decode?: Partial<DecodeParams>;
};

export type NoteModel = ConvModel & {
  version: string;
  /** 2 パス構成のときの pass 1 (テンプレート抽出用のノート検出) モデル */
  pass1?: ConvModel;
};

function modelChannels(m: ConvModel): number {
  return m.input.harmonics.length + m.input.shifts.length + (m.input.templates ?? 0);
}

export const noteModel: NoteModel = noteModelJson as NoteModel;
validateConvNet(noteModel, modelChannels(noteModel));
if (noteModel.pass1) validateConvNet(noteModel.pass1, modelChannels(noteModel.pass1));
if ((noteModel.input.templates ?? 0) > 0 && !noteModel.pass1) {
  throw new Error("note model: templates require a pass1 model");
}

export type EstimatedNote = {
  onsetSec: number;
  offsetSec: number;
  /** 41edo step (C0 = 0、C4 = 164) */
  step: number;
  hz: number;
  confidence: number;
};

export type NoteEstimationResult = {
  version: 1;
  modelVersion: string;
  edo: 41;
  sampleRate: number;
  hop: number;
  frames: number;
  durationSec: number;
  notes: EstimatedNote[];
};

export type NotePlanes = {
  frames: number;
  /** harmonics[i] に対応する u8 dB plane (frame-major、NOTE_BINS 幅) */
  planes: Uint8Array<ArrayBuffer>[];
};

export function noteCqtParams(harmonic: number) {
  const octaves = safeCqtOctaves(
    NOTE_FMIN_HZ * harmonic,
    NOTE_BINS_PER_OCTAVE,
    NOTE_OCTAVES,
    MAX_SPECTROGRAM_FMAX_HZ,
  );
  return {
    sampleRate: NOTE_SAMPLE_RATE,
    binsPerOctave: NOTE_BINS_PER_OCTAVE,
    octaves,
    fminHz: NOTE_FMIN_HZ * harmonic,
    hop: NOTE_HOP,
    gamma: autoGamma(NOTE_BINS_PER_OCTAVE),
  };
}

// 推論の 1 (frame, bin) セルあたり乗算回数 (2 パスなら両方の合計)
export function noteModelMacsPerCell(): number {
  const macs = (m: ConvModel) => m.layers.reduce((acc, l) => acc + l.in * l.out * l.kt * l.kb, 0);
  return macs(noteModel) + (noteModel.pass1 ? macs(noteModel.pass1) : 0);
}

// CQT + CNN 推論の概算演算量 (乗算+加算)。CNN は実測 ~1.5G MAC/s で、CQT より 1 桁重い
export function estimateNoteOps(samples: number): number {
  let ops = 0;
  for (const h of noteModel.input.harmonics) {
    const p = noteCqtParams(h);
    if (p.octaves >= 1) ops += estimateCqtOps(samples, p);
  }
  const frames = Math.floor(samples / NOTE_HOP) + 1;
  return ops + 2 * frames * NOTE_BINS * noteModelMacsPerCell();
}

// note_estimation の演算量上限。CNN が ~2G ops/秒の音声なので 10 分強の音声に相当し、
// 直列 queue (cqt_spectrogram と共有) を 10 分程度以上占有する入力を弾く
export const MAX_NOTE_ANALYSIS_OPS = 1.25e12;

export async function computeNotePlanes(
  samples: Float32Array<ArrayBuffer>,
  maybeYield?: MaybeYield,
): Promise<NotePlanes> {
  const frames = Math.max(1, Math.floor(samples.length / NOTE_HOP) + 1);
  const planes: Uint8Array<ArrayBuffer>[] = [];
  for (const h of noteModel.input.harmonics) {
    const p = noteCqtParams(h);
    if (p.octaves < 1) {
      planes.push(new Uint8Array(frames * NOTE_BINS));
      continue;
    }
    const r = await computeCqt(samples, p, maybeYield);
    if (r.frames !== frames)
      throw new Error(`note planes: frame mismatch ${r.frames} != ${frames}`);
    const full = padBinsToFull(r.magnitudes, r.frames, p.binsPerOctave * p.octaves, NOTE_BINS);
    planes.push(await magnitudesToU8(full, NOTE_DB_MIN, NOTE_DB_MAX, maybeYield));
  }
  return { frames, planes };
}

// u8 dB plane → 正規化 float channel。frame [f0, f1) を切り出し、範囲外 frame は 0 (PyTorch の
// zero padding と同じ) で埋める
function fillChannel(
  out: Float32Array<ArrayBuffer>,
  channel: number,
  chunkFrames: number,
  src: Uint8Array<ArrayBuffer>,
  frames: number,
  f0: number,
  shiftBins: number,
  input: ConvModel["input"] = noteModel.input,
): void {
  const { dbMin, dbMax, offset, scale } = input;
  const range = dbMax - dbMin;
  const base = channel * chunkFrames * NOTE_BINS;
  for (let i = 0; i < chunkFrames; i++) {
    const f = f0 + i;
    const row = base + i * NOTE_BINS;
    if (f < 0 || f >= frames) {
      out.fill(0, row, row + NOTE_BINS);
      continue;
    }
    const srcRow = f * NOTE_BINS;
    for (let b = 0; b < NOTE_BINS; b++) {
      const sb = b + shiftBins;
      const u = sb >= 0 && sb < NOTE_BINS ? src[srcRow + sb]! : 0;
      out[row + b] = ((u / 255) * range + dbMin + offset) / scale;
    }
  }
}

// channel 0 (h=1) の frame ごとの最大値を全 channel から引く。音量差に対する不変性のため。
// 音声範囲外の halo frame は 0 埋めのままにする
function normalizeFrames(x: Tensor, f0: number, frames: number): void {
  const n = x.frames * x.bins;
  for (let i = 0; i < x.frames; i++) {
    const f = f0 + i;
    if (f < 0 || f >= frames) continue;
    const row = i * x.bins;
    let m = -Infinity;
    for (let b = 0; b < x.bins; b++) m = Math.max(m, x.data[row + b]!);
    for (let c = 0; c < x.channels; c++) {
      const base = c * n + row;
      for (let b = 0; b < x.bins; b++) x.data[base + b]! -= m;
    }
  }
}

export type NoteProbabilities = {
  frames: number;
  active: Float32Array<ArrayBuffer>;
  onset: Float32Array<ArrayBuffer>;
};

// 既に正規化済みの float plane (テンプレート channel) を chunk に写す。範囲外 frame は 0
function fillFloatChannel(
  out: Float32Array<ArrayBuffer>,
  channel: number,
  chunkFrames: number,
  src: Float32Array<ArrayBuffer>,
  frames: number,
  f0: number,
): void {
  const base = channel * chunkFrames * NOTE_BINS;
  for (let i = 0; i < chunkFrames; i++) {
    const f = f0 + i;
    const row = base + i * NOTE_BINS;
    if (f < 0 || f >= frames) out.fill(0, row, row + NOTE_BINS);
    else out.set(src.subarray(f * NOTE_BINS, (f + 1) * NOTE_BINS), row);
  }
}

export async function runConvModel(
  model: ConvModel,
  input: NotePlanes,
  templates: Float32Array<ArrayBuffer>[],
  maybeYield?: MaybeYield,
): Promise<NoteProbabilities> {
  const { frames, planes } = input;
  if (templates.length !== (model.input.templates ?? 0)) {
    throw new Error(`note model: expected ${model.input.templates ?? 0} template channels`);
  }
  const halo = convNetHaloFrames(model);
  const channels = modelChannels(model);
  const active = new Float32Array(frames * NOTE_BINS);
  const onset = new Float32Array(frames * NOTE_BINS);
  const planeOf = new Map(model.input.harmonics.map((h, i) => [h, planes[i]!]));
  for (let f0 = 0; f0 < frames; f0 += INFER_CHUNK_FRAMES) {
    const f1 = Math.min(frames, f0 + INFER_CHUNK_FRAMES);
    const chunkFrames = f1 - f0 + 2 * halo;
    const x: Tensor = {
      channels,
      frames: chunkFrames,
      bins: NOTE_BINS,
      data: new Float32Array(channels * chunkFrames * NOTE_BINS),
    };
    let c = 0;
    for (const plane of planes) {
      fillChannel(x.data, c++, chunkFrames, plane, frames, f0 - halo, 0, model.input);
    }
    for (const s of model.input.shifts) {
      const plane = planeOf.get(s.harmonic);
      if (!plane) throw new Error(`note model: shift refers to missing harmonic ${s.harmonic}`);
      fillChannel(x.data, c++, chunkFrames, plane, frames, f0 - halo, s.bins, model.input);
    }
    for (const t of templates) fillFloatChannel(x.data, c++, chunkFrames, t, frames, f0 - halo);
    if (model.input.norm === "frame") normalizeFrames(x, f0 - halo, frames);
    const y = await runConvNet(model, x, maybeYield);
    if (y.channels !== 2 || y.frames !== f1 - f0) {
      throw new Error(`note model: unexpected output ${y.channels}ch × ${y.frames} frames`);
    }
    const n = (f1 - f0) * NOTE_BINS;
    for (let i = 0; i < n; i++) {
      active[f0 * NOTE_BINS + i] = 1 / (1 + Math.exp(-y.data[i]!));
      onset[f0 * NOTE_BINS + i] = 1 / (1 + Math.exp(-y.data[n + i]!));
    }
  }
  return { frames, active, onset };
}

/** 確率と、それを出したモデル (デコード設定はモデルごとに異なる) */
export type ModelProbabilities = NoteProbabilities & { model: ConvModel };

function decodeWith(model: ConvModel, prob: NoteProbabilities): DecodedNote[] {
  const params: DecodeParams = { ...DEFAULT_DECODE_PARAMS, ...model.decode };
  return decodeNotes(prob.active, prob.onset, prob.frames, NOTE_BINS, params);
}

// pass 1 の検出ノートから曲内の音色テンプレートを作り、pass 2 の追加 channel にする
export async function buildTemplateChannels(
  model: NoteModel,
  input: NotePlanes,
  maybeYield?: MaybeYield,
): Promise<{ templates: Float32Array<ArrayBuffer>[]; fallback?: ModelProbabilities }> {
  const k = model.input.templates ?? 0;
  if (k === 0 || !model.pass1) return { templates: [] };
  const prob1 = await runConvModel(model.pass1, input, [], maybeYield);
  const notes = decodeWith(model.pass1, prob1);
  if (notes.length < MIN_TEMPLATE_NOTES) {
    return { templates: [], fallback: { ...prob1, model: model.pass1 } };
  }
  const { dbMin, dbMax, offset, scale } = model.input;
  const planes = input.planes.length;
  const read = (h: number, f: number, b: number) =>
    ((input.planes[h]![f * NOTE_BINS + b]! / 255) * (dbMax - dbMin) + dbMin + offset) / scale;
  const centers = kmeansProfiles(noteProfiles(notes, planes, input.frames, NOTE_BINS, read), k);
  if (maybeYield) await maybeYield();
  return { templates: templateChannels(centers, planes, input.frames, NOTE_BINS, read) };
}

export async function runNoteModel(
  input: NotePlanes,
  maybeYield?: MaybeYield,
): Promise<ModelProbabilities> {
  const { templates, fallback } = await buildTemplateChannels(noteModel, input, maybeYield);
  if (fallback) return fallback;
  return { ...(await runConvModel(noteModel, input, templates, maybeYield)), model: noteModel };
}

export function notesFromProbabilities(
  prob: NoteProbabilities,
  durationSec: number,
  model: ConvModel = noteModel,
): NoteEstimationResult {
  const decoded = decodeWith(model, prob);
  const secPerFrame = NOTE_HOP / NOTE_SAMPLE_RATE;
  return {
    version: 1,
    modelVersion: noteModel.version,
    edo: 41,
    sampleRate: NOTE_SAMPLE_RATE,
    hop: NOTE_HOP,
    frames: prob.frames,
    durationSec,
    notes: decoded.map((n) => {
      const step = NOTE_FIRST_STEP + n.bin;
      return {
        onsetSec: n.startFrame * secPerFrame,
        offsetSec: Math.min(durationSec, n.endFrame * secPerFrame),
        step,
        hz: edo41StepToHz(step),
        confidence: Math.round(n.confidence * 1000) / 1000,
      };
    }),
  };
}

export async function estimateNotes(
  samples: Float32Array<ArrayBuffer>,
  maybeYield?: MaybeYield,
): Promise<NoteEstimationResult> {
  const planes = await computeNotePlanes(samples, maybeYield);
  const prob = await runNoteModel(planes, maybeYield);
  return notesFromProbabilities(prob, samples.length / NOTE_SAMPLE_RATE, prob.model);
}
