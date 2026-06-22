---
name: cqt-spectrogram
description: >
  CQT / spectrogram 解析コード (app/lib/cqt.ts, spectrogram.ts, spectrogram-task.ts) の不変条件。
  computeCqt は最上位 octave のカーネル 1 セットを全 octave で使い回すので、最上位 bin が
  Nyquist (sampleRate/2) を超えると plane 全体が aliasing する (高域 bin だけの問題ではない)。
  解析帯域 / octaves / harmonics / fmin / clamp / analysisSampleRate を変更・レビューするときに
  必ず思い出すこと。
user-invocable: false
---

# CQT 解析の不変条件

## TL;DR

- **最上位 bin ≤ Nyquist (= sampleRate/2) を常に保て。** computeCqt は最上位 octave の B 本の
  カーネルだけ設計し、信号を 1/2 ずつ downsample して同じカーネルを各 octave に当てる。
  カーネル k は **全 octave の bin k** を書く。最上位 octave が Nyquist 超なら φ_k>0.5 で
  カーネル自体が折り返し、その plane の **全 octave の bin が aliasing** する。「高域 bin を
  後から 0 に潰す」では救えない (低域 bin も汚染済み)。computeCqt は precondition で throw する。
- **clamp は bin 単位の事後ゼロ埋めではなく「計算する octave 数を絞る」。** harmonic plane h は
  `safeCqtOctaves(fmin*h, B, octaves, FMAX)` octave だけ計算し、残りは `padBinsToFull` で 0 詰め。
  カーネルが常に Nyquist 以下で設計されるので aliasing しない。
- **範囲 / cutoff の境界は octave 境界 (fmin*2^N) ではなく最上位 bin
  (fmin*2^((N\*B-1)/B)) で計算する。** 境界基準だと 1/B octave ずれて丸ごと 1 octave 余計に
  捨てる off-by-one になる (Codex 指摘の bins 72-83 黒塗り)。

## なぜ aliasing が plane 全体に及ぶか

octave 折りたたみ (librosa 方式): カーネル k の正規化周波数 f_k/fs は固定で、octave o では
bin (octaves-1-o)\*B + k を書く。つまりカーネル k は bin {k, B+k, 2B+k, …} を全部担当する。
f_k > Nyquist だとそのカーネルが折り返すので、k の低域 bin (表示帯域内) まで巻き込んでゴミになる。
→ 「最上位 octave ≤ Nyquist」は最上位 bin だけでなく **全 plane の前提条件**。

## decode sampleRate の事情

- decode は 1 回・全 plane 共有。`analysisSampleRate(fmax)` は **48000 で頭打ち** (Nyquist 24k)。
- fmax = fmin*2^octaves*max(harmonics)。高 harmonic plane の最上位は 24k を超えうる → だから
  plane ごとに octave 数を `safeCqtOctaves` で絞る。
- `MAX_SPECTROGRAM_FMAX_HZ` = 20000 は Nyquist 24k に ~20% 余裕を残した表示上限。基本 (h=1)
  レンジ fmin\*2^octaves はこれ以下に制限し、超える高 harmonic は octave 単位でクランプ。

## 変更時のチェック

- computeCqt に渡す octaves を増やす / fmin を下げる / harmonic を上げる変更で、最上位 bin が
  sampleRate/2 を超えないか。超えるなら `safeCqtOctaves` で octave を絞ったか。
- 「高域を黒く / 0 に」する発想が出たら、bin の事後ゼロ埋めではなく octave 数で絞れているか。
- 周波数 ↔ bin ↔ octave 変換で octave 境界と最上位 bin を取り違えていないか。
- decode を 1 回しか行わない前提を崩していないか (plane ごとに sampleRate を変えていないか)。
