# コーディング指針

## コメントの書き方

- デフォルトはコメントなし。有能な読者がコメントなしで混乱する、またはコードが壊れていると誤解する場合だけコメントを書く。
- 書くときは制約・結論だけを1〜2行で書く。導出や推論の連鎖は書かない。
- 言語機能の説明はしない（lookbehind、ジェネレータ、演算子の挙動など）。読者は言語を知っている前提。
- 自分の思考過程をコメントにしない。レビューで指摘された旧実装の説明や、検討して却下した代替案も書かない。最終的に残るのは「現在のコードがなぜこの形でなければならないか」の制約だけ。
- 対象コードより長くなったコメントは大抵書きすぎ。一度疑う。

### 悪い例: 言語機能と思考過程をそのまま書いている

```sh
# Lookbehind asserts the prefix without consuming it, so the
# replacement only needs to be the new version. sed has no
# lookarounds, hence perl.
perl -i -pe 's|(?<="packageManager": "bun\@)[^"]+|'"$tag"'|' package.json
```

### 良い例: コメントなし

```sh
perl -i -pe 's|(?<="packageManager": "bun\@)[^"]+|'"$tag"'|' package.json
```

### 悪い例: 結論に至るまでの因果を全部書いている

```yaml
# On pull_request_target github.ref resolves to the base branch,
# so without a PR-specific suffix every PR's sync would land in
# the same group and cancel-in-progress would clobber siblings.
group: sync-${{ github.workflow }}-pr-${{ github.event.pull_request.number }}
```

### 良い例: 制約を1行

```yaml
# pull_request_targetでgithub.refはbase branchになるためPR番号で一意化
group: sync-${{ github.workflow }}-pr-${{ github.event.pull_request.number }}
```
