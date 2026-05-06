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

  // undefined を update に渡すと Prisma は no-op するので、header 欠落時に既存値を消さない
  const username = c.req.header("x-authentik-username");
  const email = c.req.header("x-authentik-email");
  const name = c.req.header("x-authentik-name");

  const user = await prisma.user.upsert({
    where: { authentikSub: sub },
    create: { authentikSub: sub, username, email, name },
    update: { username, email, name },
  });
  c.set("user", user);
  await next();
};
