import { describe, expect, it, mock } from "bun:test";
import { useDbFixture } from "../test-fixtures/db";
import {
  BASE_RETRY_DELAY_MS,
  cleanupAbandonedUploads,
  nextRetryDelayMs,
  runSweepOnce,
  startDeletionSweeper,
  stopDeletionSweeper,
  type SweeperDeps,
} from "./gc";
import { prisma } from "./prisma";

describe("nextRetryDelayMs", () => {
  it("returns base delay range for attempts=0", () => {
    // 0.5..1.0 倍の jitter
    const min = nextRetryDelayMs(0, () => 0);
    const max = nextRetryDelayMs(0, () => 1);
    expect(min).toBe(BASE_RETRY_DELAY_MS * 0.5);
    expect(max).toBe(BASE_RETRY_DELAY_MS);
  });

  it("doubles per attempt", () => {
    expect(nextRetryDelayMs(1, () => 1)).toBe(BASE_RETRY_DELAY_MS * 2);
    expect(nextRetryDelayMs(2, () => 1)).toBe(BASE_RETRY_DELAY_MS * 4);
    expect(nextRetryDelayMs(10, () => 1)).toBe(BASE_RETRY_DELAY_MS * 1024);
  });

  it("clamps to MAX_SAFE_INTEGER for very large attempts", () => {
    const huge = nextRetryDelayMs(200, () => 1);
    expect(Number.isFinite(huge)).toBe(true);
    expect(huge).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });

  it("treats negative attempts as 0", () => {
    expect(nextRetryDelayMs(-5, () => 1)).toBe(BASE_RETRY_DELAY_MS);
  });

  it("rounds non-integer attempts down", () => {
    expect(nextRetryDelayMs(1.9, () => 1)).toBe(BASE_RETRY_DELAY_MS * 2);
  });
});

function makeDeps(overrides: {
  marks?: { id: string; prefix: string; attempts: number }[];
  deletePrefix?: (p: string) => Promise<void>;
  now?: Date;
  rand?: number;
}): {
  deps: SweeperDeps;
  findMany: ReturnType<typeof mock>;
  deleteMany: ReturnType<typeof mock>;
  update: ReturnType<typeof mock>;
  deletePrefix: ReturnType<typeof mock>;
} {
  const findMany = mock(async () => overrides.marks ?? []);
  const deleteMany = mock(async () => ({ count: 1 }));
  const update = mock(async () => ({}));
  const deletePrefix = mock(overrides.deletePrefix ?? (async () => {}));
  const deps: SweeperDeps = {
    prisma: { deletionMark: { findMany, deleteMany, update } },
    deletePrefix,
    now: () => overrides.now ?? new Date(0),
    rand: () => overrides.rand ?? 0.5,
  };
  return { deps, findMany, deleteMany, update, deletePrefix };
}

describe("runSweepOnce", () => {
  it("filters by nextRetryAt <= now and orders ascending", async () => {
    const NOW = new Date("2026-05-05T00:00:00Z");
    const { deps, findMany } = makeDeps({ now: NOW });
    await runSweepOnce(deps);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]?.[0]).toEqual({
      where: { nextRetryAt: { lte: NOW } },
      orderBy: { nextRetryAt: "asc" },
      take: 50,
    });
  });

  it("deletes S3 prefix and unmarks on success", async () => {
    const { deps, deletePrefix, deleteMany, update } = makeDeps({
      marks: [
        { id: "1", prefix: "p/a/", attempts: 0 },
        { id: "2", prefix: "p/b/", attempts: 3 },
      ],
    });
    await runSweepOnce(deps);
    expect(deletePrefix).toHaveBeenCalledTimes(2);
    expect(deletePrefix.mock.calls[0]?.[0]).toBe("p/a/");
    expect(deletePrefix.mock.calls[1]?.[0]).toBe("p/b/");
    expect(deleteMany).toHaveBeenCalledTimes(2);
    expect(deleteMany.mock.calls[0]?.[0]).toEqual({ where: { prefix: "p/a/" } });
    expect(deleteMany.mock.calls[1]?.[0]).toEqual({ where: { prefix: "p/b/" } });
    expect(update).not.toHaveBeenCalled();
  });

  it("schedules exponential backoff on failure", async () => {
    const NOW = new Date(1_000_000);
    const { deps, deleteMany, update } = makeDeps({
      marks: [{ id: "x", prefix: "boom/", attempts: 2 }],
      deletePrefix: async () => {
        throw new Error("network is down");
      },
      now: NOW,
      rand: 1, // 最大 jitter
    });
    await runSweepOnce(deps);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0]?.[0];
    expect(arg.where).toEqual({ id: "x" });
    expect(arg.data.attempts).toEqual({ increment: 1 });
    expect(arg.data.lastError).toBe("network is down");
    // attempts 2 => 失敗後の次は 3 として計算: BASE * 2^3 * (0.5 + 1*0.5) = BASE * 8
    const expectedDelay = BASE_RETRY_DELAY_MS * 8;
    expect(arg.data.nextRetryAt.getTime()).toBe(NOW.getTime() + expectedDelay);
  });

  it("continues processing remaining marks when one fails", async () => {
    const failureFor = "fail/";
    const { deps, deletePrefix, deleteMany, update } = makeDeps({
      marks: [
        { id: "1", prefix: "ok/", attempts: 0 },
        { id: "2", prefix: failureFor, attempts: 0 },
        { id: "3", prefix: "ok2/", attempts: 0 },
      ],
      deletePrefix: async (p: string) => {
        if (p === failureFor) throw new Error("nope");
      },
    });
    await runSweepOnce(deps);
    expect(deletePrefix).toHaveBeenCalledTimes(3);
    // ok/ と ok2/ は unmark、fail/ は update
    expect(deleteMany).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("truncates very long error messages", async () => {
    const longMsg = "x".repeat(2000);
    const { deps, update } = makeDeps({
      marks: [{ id: "1", prefix: "p/", attempts: 0 }],
      deletePrefix: async () => {
        throw new Error(longMsg);
      },
    });
    await runSweepOnce(deps);
    expect(update.mock.calls[0]?.[0].data.lastError.length).toBe(500);
  });

  it("stringifies non-Error throws", async () => {
    const { deps, update } = makeDeps({
      marks: [{ id: "1", prefix: "p/", attempts: 0 }],
      deletePrefix: async () => {
        throw "string thrown";
      },
    });
    await runSweepOnce(deps);
    expect(update.mock.calls[0]?.[0].data.lastError).toBe("string thrown");
  });

  it("swallows update errors so one bad row does not stop the batch", async () => {
    const { deps } = makeDeps({
      marks: [
        { id: "1", prefix: "a/", attempts: 0 },
        { id: "2", prefix: "b/", attempts: 0 },
      ],
      deletePrefix: async () => {
        throw new Error("nope");
      },
    });
    deps.prisma.deletionMark.update = mock(async () => {
      throw new Error("DB down");
    });
    await expect(runSweepOnce(deps)).resolves.toBeUndefined();
  });
});

describe("startDeletionSweeper / stopDeletionSweeper", () => {
  it("starts an interval and stops it cleanly", () => {
    startDeletionSweeper(10_000_000); // 大きい値で実際のtickは試験中に発火しない
    stopDeletionSweeper();
    // start → stop → start でハンドルが再生成されること
    startDeletionSweeper(10_000_000);
    stopDeletionSweeper();
  });

  it("is idempotent: second start is a no-op", () => {
    startDeletionSweeper(10_000_000);
    startDeletionSweeper(10_000_000);
    stopDeletionSweeper();
  });

  it("stop without prior start is a no-op", () => {
    expect(() => stopDeletionSweeper()).not.toThrow();
  });
});

describe("cleanupAbandonedUploads", () => {
  useDbFixture();

  async function makeProject(): Promise<string> {
    const user = await prisma.user.create({
      data: { authentikSub: `cleanup-test-${Math.random()}` },
    });
    const project = await prisma.project.create({ data: { userId: user.id, name: "p" } });
    return project.id;
  }

  it("expired pending と aborted な Upload を chunks ごと削除する", async () => {
    const pid = await makeProject();
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60_000);
    const expired = await prisma.upload.create({
      data: {
        projectId: pid,
        kind: "audio",
        fileName: "x",
        totalBytes: 1n,
        chunkSize: 1024,
        totalChunks: 1,
        expiresAt: past,
      },
    });
    await prisma.uploadChunk.create({
      data: { uploadId: expired.id, index: 0, sizeBytes: 1n, s3Key: "x" },
    });
    const aborted = await prisma.upload.create({
      data: {
        projectId: pid,
        kind: "audio",
        fileName: "y",
        totalBytes: 1n,
        chunkSize: 1024,
        totalChunks: 1,
        expiresAt: future,
        status: "aborted",
      },
    });
    const stillPending = await prisma.upload.create({
      data: {
        projectId: pid,
        kind: "audio",
        fileName: "z",
        totalBytes: 1n,
        chunkSize: 1024,
        totalChunks: 1,
        expiresAt: future,
      },
    });

    await cleanupAbandonedUploads();

    expect(await prisma.upload.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await prisma.uploadChunk.count({ where: { uploadId: expired.id } })).toBe(0);
    expect(await prisma.upload.findUnique({ where: { id: aborted.id } })).toBeNull();
    expect(await prisma.upload.findUnique({ where: { id: stillPending.id } })).not.toBeNull();
  });
});

describe("startDeletionSweeper ready gating", () => {
  useDbFixture();

  it("recurring sweeps wait until the ready promise settles", async () => {
    // due な mark を入れておく。gate が効いていればこの mark は sweep されない
    await prisma.deletionMark.create({
      data: { prefix: "gate-test/", nextRetryAt: new Date(Date.now() - 1000) },
    });
    const { promise: ready, resolve: resolveReady } = Promise.withResolvers<void>();
    // intervalMs=20 で 150ms 走らせれば gate が無ければ 5+ 回 sweep が走る
    startDeletionSweeper(20, ready);
    try {
      await Bun.sleep(150);
      const stillPending = await prisma.deletionMark.findFirst({
        where: { prefix: "gate-test/" },
      });
      // sweep が走っていれば attempts が増えるか mark が消える (S3 未設定で
      // deletePrefix が例外 → attempts++)。gate が効いていれば attempts=0 のまま
      expect(stillPending?.attempts).toBe(0);
    } finally {
      resolveReady();
      stopDeletionSweeper();
    }
  });
});
