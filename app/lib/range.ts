// HTTP Range の解析。RFC 7233 §2.1 に準拠して end >= total は EOF にクランプ。
// suffix range (`bytes=-N`) は末尾Nバイトを返す
export type RangeResolved = { start: number; end: number };
export function parseRange(
  rangeHeader: string | null | undefined,
  total: number,
): RangeResolved | "invalid" | null {
  if (!rangeHeader) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!m) return "invalid";
  const startStr = m[1];
  const endStr = m[2];
  if (startStr === "" && endStr === "") return "invalid";
  const start = startStr === "" ? Math.max(0, total - Number(endStr)) : Number(startStr);
  const rawEnd = startStr === "" || endStr === "" ? total - 1 : Number(endStr);
  const end = Math.min(rawEnd, total - 1);
  if (Number.isNaN(start) || Number.isNaN(rawEnd) || start > end || start >= total)
    return "invalid";
  return { start, end };
}
