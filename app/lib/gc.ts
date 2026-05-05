import { prisma } from "./prisma";
import { deletePrefix } from "./storage";

const BATCH_SIZE = 50;

let sweeperHandle: ReturnType<typeof setInterval> | null = null;
let running = false;

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return String(err).slice(0, 500);
}

export async function sweepPendingDeletions(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const marks = await prisma.deletionMark.findMany({
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });
    for (const m of marks) {
      try {
        await deletePrefix(m.prefix);
        await prisma.deletionMark.deleteMany({ where: { prefix: m.prefix } });
      } catch (err) {
        await prisma.deletionMark
          .update({
            where: { id: m.id },
            data: { attempts: { increment: 1 }, lastError: describeError(err) },
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
