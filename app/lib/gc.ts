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

// テストから fake の prisma / deletePrefix / now / rand を差し込めるよう、
// 純粋にループ処理だけを行う形で切り出した内部実装
type SweeperPrismaMark = { id: string; prefix: string; attempts: number };
export type SweeperDeps = {
  prisma: {
    deletionMark: {
      findMany: (args: {
        where: { nextRetryAt: { lte: Date } };
        orderBy: { nextRetryAt: "asc" };
        take: number;
      }) => Promise<SweeperPrismaMark[]>;
      deleteMany: (args: { where: { prefix: string } }) => Promise<unknown>;
      update: (args: {
        where: { id: string };
        data: {
          attempts: { increment: number };
          lastError: string;
          nextRetryAt: Date;
        };
      }) => Promise<unknown>;
    };
  };
  deletePrefix: (prefix: string) => Promise<void>;
  now?: () => Date;
  rand?: () => number;
};

export async function runSweepOnce(deps: SweeperDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const rand = deps.rand ?? Math.random;
  const marks = await deps.prisma.deletionMark.findMany({
    where: { nextRetryAt: { lte: now() } },
    orderBy: { nextRetryAt: "asc" },
    take: BATCH_SIZE,
  });
  for (const m of marks) {
    try {
      await deps.deletePrefix(m.prefix);
      await deps.prisma.deletionMark.deleteMany({ where: { prefix: m.prefix } });
    } catch (err) {
      const delay = nextRetryDelayMs(m.attempts + 1, rand);
      await deps.prisma.deletionMark
        .update({
          where: { id: m.id },
          data: {
            attempts: { increment: 1 },
            lastError: describeError(err),
            nextRetryAt: new Date(now().getTime() + delay),
          },
        })
        .catch(() => {});
    }
  }
}

export async function sweepPendingDeletions(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runSweepOnce({ prisma, deletePrefix });
  } finally {
    running = false;
  }
}

// 期限切れ pending と aborted な Upload を DB から消す。
// completed は task が responsible なので除外。pending+expired と aborted は task を
// 持たない (task は /complete でしか作られない) ので Upload→Task FK 違反は起きない
export async function cleanupAbandonedUploads(now: () => Date = () => new Date()): Promise<void> {
  const targets = await prisma.upload.findMany({
    where: {
      OR: [{ status: "pending", expiresAt: { lte: now() } }, { status: "aborted" }],
    },
    select: { id: true },
    take: BATCH_SIZE,
  });
  for (const u of targets) {
    try {
      await prisma.$transaction([
        prisma.uploadChunk.deleteMany({ where: { uploadId: u.id } }),
        prisma.upload.delete({ where: { id: u.id } }),
      ]);
    } catch {
      /* 次の tick で retry */
    }
  }
}

let sweeperReady: Promise<unknown> | null = null;

async function runGatedSweep(): Promise<void> {
  if (sweeperReady) {
    try {
      await sweeperReady;
    } catch {
      /* recovery 失敗でも sweep は走らせる */
    }
  }
  await sweepPendingDeletions();
  await cleanupAbandonedUploads();
}

// 既に走っていれば no-op。`ready` が渡れば全 sweep (初回 + 各 tick) がそれを待つ
export function startDeletionSweeper(intervalMs = 60_000, ready?: Promise<unknown>): void {
  if (sweeperHandle) return;
  sweeperReady = ready ?? null;
  void runGatedSweep().catch(() => {});
  sweeperHandle = setInterval(() => {
    void runGatedSweep().catch(() => {});
  }, intervalMs);
}

export function stopDeletionSweeper(): void {
  if (sweeperHandle) {
    clearInterval(sweeperHandle);
    sweeperHandle = null;
  }
  sweeperReady = null;
}
