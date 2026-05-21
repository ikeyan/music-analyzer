import { describe, expect, it } from "bun:test";
import { Effect, Either } from "effect";
import { useDbFixture } from "../test-fixtures/db";
import { prisma } from "./prisma";
import { txEither } from "./prisma-tx";

useDbFixture();

describe("txEither", () => {
  it("returns Right and commits writes when fn returns Right", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        txEither((tx) =>
          Effect.promise(async () => {
            await tx.user.create({ data: { authentikSub: "tx-right-commit" } });
            return "ok";
          }),
        ),
      ),
    );
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right).toBe("ok");
    const u = await prisma.user.findUnique({ where: { authentikSub: "tx-right-commit" } });
    expect(u).not.toBeNull();
  });

  it("returns Left and rolls back writes when fn returns Left", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        txEither((tx) =>
          Effect.flatMap(
            Effect.promise(() => tx.user.create({ data: { authentikSub: "tx-left-rollback" } })),
            () => Either.left({ status: 400, error: "validation failed" }),
          ),
        ),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toEqual({ status: 400, error: "validation failed" });
    }
    // Left なので rollback され、user 行は存在しない
    const u = await prisma.user.findUnique({ where: { authentikSub: "tx-left-rollback" } });
    expect(u).toBeNull();
  });

  it("propagates non-TxRollback throws out of the wrapper (and rolls back)", async () => {
    await expect(
      Effect.runPromise(
        txEither((tx) =>
          Effect.promise(async () => {
            await tx.user.create({ data: { authentikSub: "tx-throw-rollback" } });
            throw new Error("explosion");
          }),
        ),
      ),
    ).rejects.toThrow("explosion");
    const u = await prisma.user.findUnique({ where: { authentikSub: "tx-throw-rollback" } });
    expect(u).toBeNull();
  });

  it("preserves the literal Left payload type via the Effect<A, E> error channel", async () => {
    const result = await Effect.runPromise(
      Effect.either(txEither(() => Either.left({ status: 404 as const, error: "not found" }))),
    );
    // 型レベルの確認: status は 404 リテラルとして残る
    if (Either.isLeft(result)) {
      const status: 404 = result.left.status;
      expect(status).toBe(404);
    } else {
      throw new Error("expected Left");
    }
  });
});
