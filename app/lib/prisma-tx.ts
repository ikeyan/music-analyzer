import * as runtime from "@prisma/client/runtime/client";
import { Effect, Either, pipe } from "effect";
import { type Prisma, type PrismaClient } from "../generated/prisma/client";
import { prisma } from "./prisma";

// PrismaClientLike の generic 制約。深いパスを毎回書かなくて済むよう re-export する
export type LogOpts = Prisma.LogLevel;
export type OmitOpts = Prisma.PrismaClientOptions["omit"];
export type ExtArgs = runtime.Types.Extensions.InternalArgs;

// 任意の Prisma generic で prisma / tx を受けたいときの一般形。
// 呼び出し側は generics を素通しする (デフォルトを置くと推論に巻き込まれる)
export type PrismaClientLike<
  in L extends LogOpts,
  in out O extends OmitOpts,
  in out E extends ExtArgs,
> = Omit<PrismaClient<L, O, E>, runtime.ITXClientDenyList>;

export type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// tx 内で Left を返したら rollback したい。Prisma の $transaction は throw でしか
// rollback できないので、内部で throw → 外で catch して Left に戻す
class TxRollback extends Error {
  constructor(public left: unknown) {
    super();
  }
}

// tx callback は Effect<A, E> を返す。txEither も Effect<A, E> を返すので、
// 呼び出し側は Effect chain にそのまま乗せられる
export const txEither = <A, E>(fn: (tx: TxClient) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  pipe(
    Effect.promise(async () => {
      try {
        const value = await prisma.$transaction(async (tx) => {
          const r = await Effect.runPromise(Effect.either(fn(tx)));
          if (Either.isLeft(r)) throw new TxRollback(r.left);
          return r.right;
        });
        return Either.right<A>(value);
      } catch (err) {
        // throw / catch を自分で挟んでいるので left が E であることは確定
        if (err instanceof TxRollback) return Either.left(err.left as E);
        throw err;
      }
    }),
    Effect.flatMap((r) => r),
  );
