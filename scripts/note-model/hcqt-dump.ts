// アプリの computeNotePlanes で HCQT plane (u8 dB) を計算し、学習用に書き出す。
// 格子はアプリ側の定数に固定されるので学習と推論の特徴量がずれない
import {
  NOTE_BINS,
  NOTE_BINS_PER_OCTAVE,
  NOTE_DB_MAX,
  NOTE_DB_MIN,
  NOTE_FMIN_HZ,
  NOTE_HOP,
  NOTE_OCTAVES,
  NOTE_SAMPLE_RATE,
  computeNotePlanes,
  noteCqtParams,
  noteModel,
} from "../../app/lib/note-estimation";

const [inPath, outPrefix] = process.argv.slice(2);
if (!inPath || !outPrefix) throw new Error("usage: hcqt-dump.ts <in.f32 (mono 44100)> <outPrefix>");
const x = new Float32Array(await Bun.file(inPath).arrayBuffer());
const t = performance.now();
const { frames, planes } = await computeNotePlanes(x);
const harmonics = noteModel.input.harmonics;
for (const [i, h] of harmonics.entries()) await Bun.write(`${outPrefix}_h${h}.u8`, planes[i]!);
await Bun.write(
  `${outPrefix}_meta.json`,
  JSON.stringify({
    sampleRate: NOTE_SAMPLE_RATE,
    fminHz: NOTE_FMIN_HZ,
    binsPerOctave: NOTE_BINS_PER_OCTAVE,
    octaves: NOTE_OCTAVES,
    hop: NOTE_HOP,
    gamma: noteCqtParams(1).gamma,
    harmonics,
    bins: NOTE_BINS,
    dbMin: NOTE_DB_MIN,
    dbMax: NOTE_DB_MAX,
    frames,
    planes: Object.fromEntries(
      harmonics.map((h) => [h, { octaves: noteCqtParams(h).octaves, frames }]),
    ),
  }),
);
console.error(
  `${outPrefix}: ${frames} frames × ${harmonics.length} planes in ${Math.round(performance.now() - t)} ms`,
);
