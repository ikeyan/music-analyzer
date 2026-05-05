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

// Caddy → 本サービス間で共有する secret。設定されていれば全リクエストの
// X-Auth-Proxy-Secret と timing-safe 比較し、一致しないものは 401 にする。
// authentikを通っていない直接アクセスを fail-closed にするための
// defense-in-depth (header signing/JWT検証ではないが、proxyを必ず通したい
// 運用要件を最低限担保する)
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

  // header が absent (undefined) のときは update に渡さず既存値を保つ。
  // Prisma は undefined フィールドを update から無視する
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
