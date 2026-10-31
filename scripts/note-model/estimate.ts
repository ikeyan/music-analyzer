// f32 PCM (44100 mono) にアプリの estimateNotes を掛けて結果 JSON を書き出す (学習側の評価用)
import { estimateNotes } from "../../app/lib/note-estimation";
const [inPath, outPath] = process.argv.slice(2);
const x = new Float32Array(await Bun.file(inPath!).arrayBuffer());
const t = performance.now();
const r = await estimateNotes(x);
console.error(
  `estimated ${r.notes.length} notes in ${Math.round(performance.now() - t)} ms (${(x.length / 44100).toFixed(1)} s audio)`,
);
await Bun.write(outPath!, JSON.stringify(r));
