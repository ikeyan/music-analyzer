import type { MiddlewareHandler } from "hono";
import type { User } from "../generated/prisma/client";
import { prisma } from "./prisma";

export type AuthContext = {
  Variables: {
    user: User;
  };
};

const DEV_SUB = "dev:local";

export const requireUser: MiddlewareHandler<AuthContext> = async (c, next) => {
  const sub =
    c.req.header("x-authentik-uid") ?? (process.env.NODE_ENV === "production" ? null : DEV_SUB);
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
