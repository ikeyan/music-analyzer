// ユーザー (UI / API レスポンス / DB の error 列) に見せる用の error 文字列。
// 長すぎる stack/メッセージで DB 列やログを溢れさせないよう 500 char で打ち切る。
// String() は toString/valueOf が壊れた値 (例: { toString: 0 }) で throw するので fallback
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  try {
    return String(err).slice(0, 500);
  } catch {
    return Object.prototype.toString.call(err);
  }
}
