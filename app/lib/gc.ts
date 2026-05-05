import { prisma } from "./prisma";
import { deletePrefix } from "./storage";

const BATCH_SIZE = 50;
export const BASE_RETRY_DELAY_MS = 30_000;

let sweeperHandle: ReturnType<typeof setInterval> | null = null;
let running = false;

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return String(err).slice(0, 500);
}

// 指数バックオフ + 半量jitter。上限なし (Number.MAX_SAFE_INTEGER でクランプ)。
// attempts は失敗回数 (0 = まだ失敗していない) で次の delay を計算する
export function nextRetryDelayMs(attempts: number, rand: () => number = Math.random): number {
  const safe = Math.max(0, Math.floor(attempts));
  const exp = Math.min(Number.MAX_SAFE_INTEGER, BASE_RETRY_DELAY_MS * 2 ** safe);
  return exp * (0.5 + rand() * 0.5);
}

export async function sweepPendingDeletions(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const marks = await prisma.deletionMark.findMany({
      where: { nextRetryAt: { lte: new Date() } },
      orderBy: { nextRetryAt: "asc" },
      take: BATCH_SIZE,
    });
    for (const m of marks) {
      try {
        await deletePrefix(m.prefix);
        await prisma.deletionMark.deleteMany({ where: { prefix: m.prefix } });
      } catch (err) {
        const delay = nextRetryDelayMs(m.attempts + 1);
        await prisma.deletionMark
          .update({
            where: { id: m.id },
            data: {
              attempts: { increment: 1 },
              lastError: describeError(err),
              nextRetryAt: new Date(Date.now() + delay),
            },
          })
          .catch(() => {});
      }
    }
  } finally {
    running = false;
  }
}

// 起動時に1度走らせて前runで残った墓標を回収し、以後 intervalMs ごとに再試行。
// 既に走っているなら no-op
export function startDeletionSweeper(intervalMs = 60_000): void {
  if (sweeperHandle) return;
  void sweepPendingDeletions().catch(() => {});
  sweeperHandle = setInterval(() => {
    void sweepPendingDeletions().catch(() => {});
  }, intervalMs);
}

export function stopDeletionSweeper(): void {
  if (sweeperHandle) {
    clearInterval(sweeperHandle);
    sweeperHandle = null;
  }
}
