# authentik stack

Caddy → authentik → music-analyzer の docker-compose スタック。
e2e テスト (`flow.test.ts`) と、自宅サーバの本番運用の両方で使う。

`scripts/setup.ts` は e2e テストが必要とする最小プロビジョニング
(Provider / Application / Outpost binding) のみを行う。本番固有の設定
(サインアップ封鎖、Source 連携、MFA stage 追加など) は authentik 管理 UI
側で行う。

## 自宅運用: ユーザ追加

1. `Directory → Users → Create` で User を作成 (password 未設定で OK)
2. ユーザ詳細ページの `... → View recovery link` で URL を発行
3. 本人にリンクを渡す → password を設定してログイン

## 自宅運用: 一般公開を防ぐ (一度だけ)

`Flows → default-authentication-flow` の identification stage を編集:

- `enrollment flow` を **null** に (サインアップボタンを消す)
- `recovery flow` を `default-recovery-flow` に (Forgot password? を有効化)
- `sources` を空に (使う Source ができたら戻す)

外部 IdP (Google/GitHub 等) を Source として足す場合は、その Source の
`enrollment flow` も null にしないと社外ユーザが勝手にサインアップ
できてしまう点に注意。
