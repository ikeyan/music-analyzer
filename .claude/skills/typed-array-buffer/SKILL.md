---
name: typed-array-buffer
description: >
  Uint8Array (および ArrayBufferView 系) を引数型・戻り値型・変数注釈で書くときは
  常に <ArrayBuffer> 型引数を付ける。デフォルトの <ArrayBufferLike> は
  BufferSource (= ArrayBufferView<ArrayBuffer> | ArrayBuffer) に渡せず、
  BodyInit / fetch / Blob / TextEncoder 等の境界で型エラーになる。
  TypedArray を扱う TS コードを書く / レビューする際に常に思い出すこと。
user-invocable: false
---

# Uint8Array は常に `<ArrayBuffer>` を付ける

## TL;DR

```ts
// NG: Uint8Array<ArrayBufferLike> になり BodyInit に渡せない
function foo(body: Uint8Array): Response { ... }

// OK
function foo(body: Uint8Array<ArrayBuffer>): Response { ... }
```

`new Uint8Array(...)` などのコンストラクタ呼び出しの戻り値は最初から
`Uint8Array<ArrayBuffer>` 型なので、**変数注釈や引数型を書かない限り**
キャストや明示的注釈は不要。問題が起きるのは型を**書いた**ときだけ。

## なぜ

TS の `BufferSource` 定義 (lib.webworker.d.ts / lib.dom.d.ts):

```ts
type BufferSource = ArrayBufferView<ArrayBuffer> | ArrayBuffer;
```

`<ArrayBuffer>` が strict で指定されている。一方 `Uint8Array<T extends
ArrayBufferLike = ArrayBufferLike>` のデフォルトは `<ArrayBufferLike>`
なので、引数を `Uint8Array` と書いた瞬間に `Uint8Array<ArrayBufferLike>`
となり、`BufferSource` ≒ `BodyInit` ≒ `BlobPart` 等に assign 不能になる。

これは `Uint8Array` だけでなく `Uint16Array`, `Int32Array`, `Float64Array`,
`DataView` など `ArrayBufferView` 系列の全 typed array に共通する。

## どこで踏むか

- `fetch(url, { body: ... })` の body
- `new Blob([...])` の BlobPart
- `new Response(body)` の body
- `Bun.S3Client.write(key, body)` の body
- `crypto.subtle.digest(algo, data)` の data
- 自前 helper の引数: `function send(body: Uint8Array)` ← 罠

## 正しい書き方

| 場面                              | 書き方                                                 |
| --------------------------------- | ------------------------------------------------------ |
| 引数型                            | `body: Uint8Array<ArrayBuffer>`                        |
| 戻り値型                          | `): Uint8Array<ArrayBuffer>`                           |
| 変数注釈 (希少)                   | `const buf: Uint8Array<ArrayBuffer> = ...`             |
| キャスト                          | **不要**。コンストラクタ戻り値は自動で `<ArrayBuffer>` |
| `instanceof Uint8Array` の narrow | 戻り値の `byteLength` 等を読むだけなら無注釈で OK      |

## 例外: ジェネリック中継

bytes をそのまま素通しする helper なら、型引数を保持するのが正しい:

```ts
function pass<T extends ArrayBufferLike>(buf: Uint8Array<T>): Uint8Array<T> {
  return buf;
}
```

ただし返した bytes を fetch 等に渡す側はやはり `<ArrayBuffer>` を期待する
ので、API 境界では結局 narrow が必要。

## レビュー時のチェック

新規/変更コードに `Uint8Array` (型引数なし) が**型注釈位置**で出てきたら
`Uint8Array<ArrayBuffer>` に直す。コンストラクタ呼び出し位置 (`new
Uint8Array(...)`) は触らない。
