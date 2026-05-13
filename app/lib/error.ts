// ユーザー (UI / API レスポンス / DB の error 列) に見せる用の error 文字列。
// 長すぎる stack/メッセージで DB 列やログを溢れさせないよう 500 char で打ち切る
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return String(err).slice(0, 500);
}
