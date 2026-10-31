# 41edo ノート推定モデルの学習パイプライン

`app/lib/note-model.json` (推論は `app/lib/note-estimation.ts` + `conv-net.ts`) を作り直す手順。
アプリ本体は bun/TS だが、学習だけ Python (numpy, torch CPU) を使う。

規約: 作業ディレクトリ `W` に中間ファイルを溜め、**全コマンドは `cd W` してから** スクリプトを
リポジトリのパスで呼ぶ (Python スクリプトはカレントの `feat_*` / `targets_*` を読み書きする)。
以下 `NM=<repo>/scripts/note-model`。

## 1. 教師データ (wav + MIDI)

```bash
cd W
python3 $NM/midi_notes.py song.mid song_notes.json           # note-on/off → JSON
ffmpeg -i song.wav -ac 1 -ar 44100 -f f32le song_44100.f32  # mono f32 PCM
```

MIDI ノート番号は「1 番号 = 41edo 1 step」だが、基準 (どの番号がどの周波数か) は音色ごとに違う。
`calibrate3.py <song> <offsetSec>` (定常部の harmonic-sum 走査) と `diffscan.py <song> <offsetSec>`
(onset 差分) でトラックごとに基準と wav↔MIDI の時間オフセットを測り、`targets.py` の `CFG` に書く。

## 2. 特徴量 (HCQT、アプリと同じ実装)

```bash
bun run $NM/hcqt-dump.ts song_44100.f32 feat_song   # feat_song_h{1,2,3,4,5,6,8}.u8 + feat_song_meta.json
python3 $NM/targets.py song                         # targets_song.npz (frame × 287 bin の active/onset)
```

`hcqt-dump.ts` は `app/lib/note-estimation.ts` の `computeNotePlanes` をそのまま呼ぶので、格子
(fs 44100 / hop 512 / bin 0 = C1 / 41 bins per octave × 7 / harmonics 1,2,3,4,5,6,8) は推論と常に一致する。

## 3. 合成データ

実曲だけだと音色が 2 種類しかなく曲間の汎化が弱い。ランダム倍音構成の 41edo 曲を足す:

```bash
python3 $NM/synth.py 30 60                          # syn00..29 (60 s ずつ、正確な教師付き)
for i in $(seq 0 29); do n=$(printf syn%02d $i); bun run $NM/hcqt-dump.ts ${n}_44100.f32 feat_$n; done
python3 $NM/targets_syn.py $(for i in $(seq 0 29); do printf "syn%02d " $i; done)
```

## 4. 学習と書き出し (2 パス構成)

現行モデルは 2 パス: pass 1 (倍音 plane + サブハーモニック shift 入力の CNN) でノートを検出し、
検出ノートの倍音プロファイルを曲ごとに k-means (K=3) して得た音色テンプレートとの内積を
3 channel 追加した pass 2 の CNN が最終出力になる (`app/lib/note-templates.ts`)。
曲ごとの楽器に適応するので未見曲の note F1 が +0.03〜0.09 上がった。

```bash
# pass 1 (単独でも動くモデル。既存の app/lib/note-model.json の pass1 を流用してもよい)
OMP_NUM_THREADS=8 python3 -u $NM/train_exp.py --songs kipa,xenprog,yxeni,mafle,fnas --eval_songs "" \
  --train_extra $(cat syn30.txt) --max_steps 5000 --export pass1.json --version edo41-cnn-pass1
# pass 2 (テンプレートは pass 1 の検出から作る)
OMP_NUM_THREADS=8 python3 -u $NM/train_timbre.py --songs kipa,xenprog,yxeni,mafle,fnas --eval_songs "" \
  --train_extra $(cat syn30.txt) --templates 3 --templates_from model:pass1.json --max_steps 5000 \
  --export pass2.json --version edo41-cnn-v5
python3 $NM/assemble_v2.py pass2.json pass1.json note-model.json 3   # 最終出力の decode は decode_v2.FINAL
cp note-model.json <repo>/app/lib/note-model.json
```

`train_exp.py` / `train_timbre.py` は `netlib.py` (モデル定義・評価) と `json_to_pt.py` (JSON → PyTorch)
を同じディレクトリから import する。未見曲の評価は `--eval_songs`、holdout は各曲の末尾 20%。
`eval_model.py <json> <songs> full|holdout` で書き出し済み JSON (pass 1 相当) を再評価できる。

## 4'. (旧) 1 パス学習

```bash
OMP_NUM_THREADS=8 python3 -u $NM/train_final.py --songs kipa,xenprog \
  --train_extra $(for i in $(seq 0 29); do printf "syn%02d," $i; done | sed 's/,$//') \
  --epochs 40 --shift_aug 8 --pos_w 1,10 --export note-model.json --version edo41-cnn-v1
cp note-model.json <repo>/app/lib/note-model.json
```

各曲の 41edo 区間の末尾 20% を holdout にして note F1 (exact step、onset ±50 ms) で最良 epoch を選ぶ。
デコーダのパラメータ (`decode_v2.DEFAULT`) も JSON に入る。`app/lib/note-decode.ts` は `decode_v2.py`
の移植で、`app/test-fixtures/note-decode-cases.json` で一致を検証している (デコーダを変えたら
fixture も作り直し、`bun test app/lib/note-decode.test.ts` を通す)。

## 5. アプリ側の経路で評価

```bash
bun run $NM/estimate.ts song_44100.f32 ts_notes_song.json   # estimateNotes をそのまま実行
python3 $NM/eval_ts.py song ts_notes_song.json              # MIDI と突き合わせ (同音同時の GT はマージ)
```
