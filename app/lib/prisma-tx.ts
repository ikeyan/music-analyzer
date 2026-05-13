import * as runtime from "@prisma/client/runtime/client";
import { Either } from "effect";
import { type Prisma, type PrismaClient } from "../generated/prisma/client";
import { prisma } from "./prisma";

// 任意の Prisma generic で prisma / tx を受けたいときの一般形。
// 呼び出し側は generics を素通しする (デフォルトを置くと推論に巻き込まれる)
export type PrismaClientLike<
  in LogOpts extends Prisma.LogLevel,
  in out OmitOpts extends Prisma.PrismaClientOptions["omit"],
  in out ExtArgs extends runtime.Types.Extensions.InternalArgs,
> = Omit<PrismaClient<LogOpts, OmitOpts, ExtArgs>, runtime.ITXClientDenyList>;

// このプロジェクトの prisma singleton の $transaction callback が受け取る tx の型。
// `typeof prisma` も構造的にこれと assignable なので、prisma / tx の両方を 1 引数で受けられる
export type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// tx 内で Left を返したら rollback したい。Prisma の $transaction は throw でしか
// rollback できないので、内部で throw → 外で catch して Left に戻す
class TxRollback extends Error {
  constructor(public left: unknown) {
    super();
  }
}

export async function txEither<A, E>(
  fn: (
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  ) => Promise<Either.Either<A, E>>,
): Promise<Either.Either<A, E>> {
  try {
    const a = await prisma.$transaction(async (tx) => {
      const r = await fn(tx);
      if (Either.isLeft(r)) throw new TxRollback(r.left);
      return r.right;
    });
    return Either.right(a);
  } catch (err) {
    // throw / catch を自分で挟んでいるので left が E であることは確定
    if (err instanceof TxRollback) return Either.left(err.left as E);
    throw err;
  }
}
