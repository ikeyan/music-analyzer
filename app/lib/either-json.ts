import { Either } from "effect";
import type { TypedResponse } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { JSONParsed } from "hono/utils/types";
import type { IsNumericLiteral } from "type-fest";

// 4xx / 5xx の literal numeric にだけマッチする制約。enumerate せずに
// `${S}` extends `${4|5}${string}` で先頭桁を見る
type ApiErrorConstraint<S extends ContentfulStatusCode> =
  IsNumericLiteral<S> extends true ? (`${S}` extends `${4 | 5}${string}` ? S : never) : never;

export type ApiError = { status: ContentfulStatusCode; error: string };

export function leftErr<const E extends ApiError>(
  e: E & { status: ApiErrorConstraint<E["status"]> },
): Either.Either<never, E> {
  return Either.left(e);
}

// c.json の戻り値型と一致させて as を排除する
type LeftRes<E extends ApiError> = Response &
  TypedResponse<JSONParsed<Omit<E, "status">>, E["status"], "json">;
type RightRes<R> = Response & TypedResponse<JSONParsed<R>, 200, "json">;

// narrow 済み Left<E, R> でも match させたいので、A 位置が unknown / never の Left/Right を
// 並べる。実際に来うる形 (Either.left() の戻り値、または isLeft 後の narrow) を網羅する
export type EitherJsonFn = {
  <const E extends ApiError>(
    r: Either.Left<E, never> | Either.Left<never, unknown> | Either.Right<unknown, never>,
  ): LeftRes<E>;
  <const E extends ApiError, R>(r: Either.Either<R, E>): LeftRes<E> | RightRes<R>;
};

export const provideEitherJson = createMiddleware<{
  Variables: { eitherJson: EitherJsonFn };
}>(async (c, next) => {
  const eitherJson: EitherJsonFn = <const E extends ApiError, R>(r: Either.Either<R, E>) => {
    if (Either.isLeft(r)) {
      const { status, ...body } = r.left;
      return c.json(body, status);
    }
    return c.json(r.right);
  };
  c.set("eitherJson", eitherJson);
  await next();
});
