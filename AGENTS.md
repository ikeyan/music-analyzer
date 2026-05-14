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

## テストの書き方

- テストひとつが 10 行を超えそうになったら、まず「これは何の性質を verify しているのか」を言葉にする。具体例の羅列に見えてきたら fast-check で property test 化する。
- property test を書くときは、**先に性質を 1 行で言語化** してから、その性質を成立させる **最小限の入力範囲** を arbitrary で組む。性質と無関係な属性は wide schema (Video / Audio 等) でもヘルパーで最小値に固定する。
- `numRuns` は控えめ (5–30 程度) で十分。1 回ごとの I/O コスト (Prisma write など) が高いケースは特に低めに設定し、shrink が走るよう preconditions を緩く保つ。
- 既存テストが 10 行以内に収まっていて読みやすいなら、無理に property 化しない。境界値の network test や ad-hoc な regression test は具体例で書いた方が早い。
- DB 系 property test では `useDbFixture` の `beforeEach(clearDb)` は反復の間で走らないので、各反復で **unique な id / sub** を発番する (例: `${crypto.randomUUID()}` を id prefix に混ぜる)。

### 性質と入力範囲を言語化する例

`parseRange` の「過大な end は total-1 に clamp」:

```ts
// 性質: end >= total は total-1 に clamp (RFC 7233 §2.1)
// 入力: 0<=a<total と b>=total
it("過大な end は total-1 に clamp", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: TOTAL - 1 }),
      fc.integer({ min: TOTAL, max: TOTAL * 100 }),
      (a, b) => {
        expect(parseRange(`bytes=${a}-${b}`, TOTAL)).toEqual({ start: a, end: TOTAL - 1 });
      },
    ),
    { numRuns: 20 },
  );
});
```
