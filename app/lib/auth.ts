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
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const requireUser: MiddlewareHandler<AuthContext> = async (c, next) => {
  const expectedSecret = process.env.AUTH_PROXY_SECRET;
  const isProduction = process.env.NODE_ENV === "production";

  if (expectedSecret) {
    const provided = c.req.header("x-auth-proxy-secret");
    if (!provided || !constantTimeEqual(provided, expectedSecret)) {
      return c.json({ error: "unauthenticated" }, 401);
    }
  } else if (isProduction) {
    // 本番でsecret未設定はheader spoofを許す状態なので fail-closed にする
    return c.json({ error: "AUTH_PROXY_SECRET not configured" }, 503);
  }

  const headerSub = c.req.header("x-authentik-uid");
  const sub = headerSub ?? (expectedSecret || isProduction ? null : DEV_SUB);
  if (!sub) return c.json({ error: "unauthenticated" }, 401);

  const username = c.req.header("x-authentik-username") ?? null;
  const email = c.req.header("x-authentik-email") ?? null;
  const name = c.req.header("x-authentik-name") ?? null;

  const user = await prisma.user.upsert({
    where: { authentikSub: sub },
    create: { authentikSub: sub, username, email, name },
    update: { username, email, name },
  });
  c.set("user", user);
  await next();
};
