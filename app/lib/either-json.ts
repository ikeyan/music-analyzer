import { Either } from "effect";
import type { TypedResponse } from "hono";
import { createMiddleware } from "hono/factory";
import type { JSONParsed } from "hono/utils/types";

// throw HTTPException は hc の response 型に乗らないので Either で返す。
// `<const E>` で literal status / 追加プロパティをそのまま伝播させる
export type ApiErrorStatus = 400 | 404 | 409 | 410 | 500;
export type ApiError = { status: ApiErrorStatus; error: string };

export function leftErr<const E extends ApiError>(e: E): Either.Either<never, E> {
  return Either.left(e);
}

// c.json の戻り値型と一致させて as を排除する
type LeftRes<E extends ApiError> = Response &
  TypedResponse<JSONParsed<Omit<E, "status">>, E["status"], "json">;
type RightRes<R> = Response & TypedResponse<JSONParsed<R>, 200, "json">;

// handler を wrapping する方式だと validator 由来の Input が HOF 越しに伝わらず
// c.req.valid が無力化されるので、middleware で c.var に関数を生やす。
// overload を切らないと isLeft narrow 後の Left<E, R> でも R が phantom として残り、
// c.json(r.right) 経由で R が response 型に leak する
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
