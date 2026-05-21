---
name: prisma-claim-first
description: >
  Prisma の $transaction 内で findFirst/findUnique → 条件チェック → update/updateMany
  と書くと、並行 request が同じ行を read+write しに来て deadlock / write conflict
  (SQLite SQLITE_BUSY, Prisma P2034) を起こす。代わりに全 precondition を updateMany
  の where に畳んで claim-first で原子化し、失敗時 (count === 0) だけ findFirst で
  診断する。診断時の throw は $transaction が自動 rollback してくれる。
  Prisma tx 内で row を read してから update / updateMany するコードを書く /
  レビューする際に常に思い出すこと。
user-invocable: false
---

# Prisma tx: select-then-update を避けて claim-first にする

## ルール

`$transaction` 内で `findFirst` → if 条件 → `updateMany` の順に書かない。
全条件を `updateMany.where` に畳んで原子的に claim し、`count === 0` の
失敗パスでだけ `findFirst` してエラー診断する。

## なぜ

`findFirst` → `updateMany` を tx 内で続けると、

- 行を read した時点で snapshot/read lock を取り、
- 後段の update で write lock への昇格が必要になる。

並行 request が同じ行で同時にこれをやると、互いが昇格を待ち合って
deadlock / write conflict になる。SQLite では `SQLITE_BUSY`、PostgreSQL
では deadlock detector が片方を kill、Prisma 側では `P2034` で観測される。

`updateMany` の `where` に precondition を畳めば、

- 該当行があれば exclusive lock を即取って書き換える
- なければ `count: 0` を返す

の単一命令になり、複数 tx は単に直列化されるだけで deadlock しない。

## ❌ 悪い例: select → check → updateMany

```ts
await prisma.$transaction(async (tx) => {
  const upload = await tx.upload.findFirst({ where: { id, projectId } });
  if (!upload) throw notFound;
  if (upload.status !== "pending") throw conflict;
  if (upload.expiresAt <= now) throw expired;
  await tx.upload.updateMany({
    where: { id, status: "pending" },
    data: { status: "completed" },
  });
});
```

## ✅ 良い例: claim-first + 失敗時のみ診断

```ts
await prisma.$transaction(async (tx) => {
  const claimed = await tx.upload.updateMany({
    where: {
      id,
      projectId,
      status: "pending",
      expiresAt: { gt: now },
    },
    data: { status: "completed" },
  });
  if (claimed.count === 0) {
    // 失敗パスでだけ row を read してエラー診断
    const upload = await tx.upload.findFirst({ where: { id, projectId } });
    if (!upload) throw notFound;
    if (upload.status !== "pending") throw conflict;
    throw expired; // status は pending、ということは expiresAt 切れ
  }
  // 以降は claim 済みの行を安全に read できる (write lock を持っている)
  const upload = await tx.upload.findUniqueOrThrow({ where: { id } });
  // ...validation, 派生 row 作成...
});
```

throw は `$transaction` が自動 rollback してくれるので、claim を取った後で
追加 validate に失敗してもロールバックで status は元に戻る。

## 適用範囲

- 状態遷移 (status を読んで status を書く): claim, complete, abort, expire
- 並行 request の race を考慮する必要がある任意の row 更新

## 適用しなくていいケース

- 単一 request しか触らないと保証できる行 (request 内で生成した row など)
- 状態遷移ではなく集約計算 (SUM, COUNT) を含む読み取り
- read だけしかしない (write がない) tx

## 派生値を read してから write する場合

read した値を使った update (例: `receivedBytes` を increment するために
`existing.sizeBytes` を読む) は、`update` の `data` で `{ increment: delta }`
のように相対演算が使えるなら read を 1 つの side query にして、本体の
update は claim-first にする。

```ts
const existing = await tx.uploadChunk.findUnique({ ... }); // delta 計算用
const delta = existing ? BigInt(size) - existing.sizeBytes : BigInt(size);
const claimed = await tx.upload.updateMany({
  where: { id, status: "pending", expiresAt: { gt: now } },
  data: { receivedBytes: { increment: delta } },
});
if (claimed.count === 0) { /* 診断 + throw */ }
```

## レビュー時のチェック

新規/変更コード内の `prisma.$transaction` / `tx.$transaction` callback で

- `tx.<model>.findFirst` / `findUnique` の戻り値で if-throw / if-return している
- そのあと同じ `<model>` を `update` / `updateMany` している

が両方あれば、claim-first に書き換えられないか確認する。
