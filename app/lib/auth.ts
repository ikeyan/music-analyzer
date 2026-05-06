import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { User } from "../generated/prisma/client";
import { prisma } from "./prisma";

export type AuthContext = {
  Variables: {
    user: User;
  };
};

const DEV_SUB = "dev:local";

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const requireUser: MiddlewareHandler<AuthContext> = async (c, next) => {
  const expectedSecret = process.env.AUTH_PROXY_SECRET;
  // dev fallback (DEV_SUB) は NODE_ENV=development のときだけ。staging/test/unset は fail-closed
  const isDevelopment = process.env.NODE_ENV === "development";

  if (expectedSecret) {
    const provided = c.req.header("x-auth-proxy-secret");
    if (!provided || !constantTimeEqual(provided, expectedSecret)) {
      return c.json({ error: "unauthenticated" }, 401);
    }
  } else if (!isDevelopment) {
    // secret 未設定 + 非 development は header spoof を許す状態なので fail-closed
    return c.json({ error: "AUTH_PROXY_SECRET not configured" }, 503);
  }

  const headerSub = c.req.header("x-authentik-uid");
  const sub = headerSub ?? (expectedSecret || !isDevelopment ? null : DEV_SUB);
  if (!sub) return c.json({ error: "unauthenticated" }, 401);

  const username = c.req.header("x-authentik-username");
  const email = c.req.header("x-authentik-email");
  const name = c.req.header("x-authentik-name");

  // 全 request が upsert すると read-only な media GET でも User 行を毎回 update し
  // SQLite write lock が連射される。find して差分があるときだけ書く
  let user = await prisma.user.findUnique({ where: { authentikSub: sub } });
  if (!user) {
    // 同一 sub の初回ログインが並行すると unique 衝突 (P2002) や SQLite write
    // conflict (P2034) で create が落ちるので、勝った request の row を再 fetch する
    try {
      user = await prisma.user.create({ data: { authentikSub: sub, username, email, name } });
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== "P2002" && code !== "P2034") throw err;
      user = await prisma.user.findUnique({ where: { authentikSub: sub } });
      if (!user) throw err;
    }
  } else if (
    (username !== undefined && user.username !== username) ||
    (email !== undefined && user.email !== email) ||
    (name !== undefined && user.name !== name)
  ) {
    user = await prisma.user.update({
      where: { authentikSub: sub },
      data: { username, email, name },
    });
  }
  c.set("user", user);
  await next();
};
