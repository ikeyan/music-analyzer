import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { useDbFixture } from "../test-fixtures/db";
import { type AuthContext, constantTimeEqual, requireUser } from "./auth";
import { prisma } from "./prisma";
import { tempDir } from "./temp-dir";

useDbFixture();

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("returns false for different lengths", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });

  it("returns false for same length but different content", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("a".repeat(64), "b".repeat(64))).toBe(false);
  });

  it("handles multibyte utf-8 correctly", () => {
    expect(constantTimeEqual("プロジェクト", "プロジェクト")).toBe(true);
    expect(constantTimeEqual("プロジェクト", "プロジェクトA")).toBe(false);
  });
});

const ENV_KEYS = ["AUTH_PROXY_SECRET", "AUTH_PROXY_SECRET_FILE", "NODE_ENV"] as const;
type Env = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
let savedEnv: Env = {};

const SECRET = "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaa";

function makeApp() {
  return new Hono<AuthContext>().use("*", requireUser).get("/whoami", (c) => {
    const u = c.var.user;
    return c.json({
      id: u.id,
      sub: u.authentikSub,
      username: u.username,
      email: u.email,
      name: u.name,
    });
  });
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("requireUser middleware", () => {
  describe("AUTH_PROXY_SECRET set", () => {
    it("returns 401 when request lacks the header", async () => {
      process.env.AUTH_PROXY_SECRET = SECRET;
      const res = await makeApp().request("/whoami");
      expect(res.status).toBe(401);
    });

    it("returns 401 when header doesn't match", async () => {
      process.env.AUTH_PROXY_SECRET = SECRET;
      const res = await makeApp().request("/whoami", {
        headers: { "x-auth-proxy-secret": "wrong-value" },
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 when header matches but no x-authentik-uid", async () => {
      process.env.AUTH_PROXY_SECRET = SECRET;
      const res = await makeApp().request("/whoami", {
        headers: { "x-auth-proxy-secret": SECRET },
      });
      expect(res.status).toBe(401);
    });

    it("upserts user when secret + uid header match", async () => {
      process.env.AUTH_PROXY_SECRET = SECRET;
      const res = await makeApp().request("/whoami", {
        headers: {
          "x-auth-proxy-secret": SECRET,
          "x-authentik-uid": "user-123",
          "x-authentik-username": "alice",
          "x-authentik-email": "alice@example.com",
          "x-authentik-name": "Alice",
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.sub).toBe("user-123");
      expect(body.username).toBe("alice");
      expect(body.email).toBe("alice@example.com");
      expect(body.name).toBe("Alice");
    });

    it("preserves existing profile fields when subsequent request omits them", async () => {
      process.env.AUTH_PROXY_SECRET = SECRET;
      const baseHeaders = {
        "x-auth-proxy-secret": SECRET,
        "x-authentik-uid": "user-456",
      };
      // 1回目: 全フィールド付き
      await makeApp().request("/whoami", {
        headers: { ...baseHeaders, "x-authentik-username": "bob", "x-authentik-name": "Bob" },
      });
      // 2回目: username / name の header を欠落させる
      const res = await makeApp().request("/whoami", { headers: baseHeaders });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.username).toBe("bob");
      expect(body.name).toBe("Bob");
    });

    it("updates profile fields when present in subsequent request", async () => {
      process.env.AUTH_PROXY_SECRET = SECRET;
      const baseHeaders = {
        "x-auth-proxy-secret": SECRET,
        "x-authentik-uid": "user-789",
      };
      await makeApp().request("/whoami", {
        headers: { ...baseHeaders, "x-authentik-username": "carol-old" },
      });
      const res = await makeApp().request("/whoami", {
        headers: { ...baseHeaders, "x-authentik-username": "carol-new" },
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.username).toBe("carol-new");
    });
  });

  describe("AUTH_PROXY_SECRET unset", () => {
    it("returns 503 when NODE_ENV is not development", async () => {
      delete process.env.AUTH_PROXY_SECRET;
      process.env.NODE_ENV = "production";
      const res = await makeApp().request("/whoami");
      expect(res.status).toBe(503);
    });

    it("returns 503 when NODE_ENV is undefined", async () => {
      delete process.env.AUTH_PROXY_SECRET;
      delete process.env.NODE_ENV;
      const res = await makeApp().request("/whoami");
      expect(res.status).toBe(503);
    });

    it("returns 503 when NODE_ENV is staging or test", async () => {
      delete process.env.AUTH_PROXY_SECRET;
      for (const v of ["staging", "test", ""]) {
        process.env.NODE_ENV = v;
        const res = await makeApp().request("/whoami");
        expect(res.status).toBe(503);
      }
    });

    it("uses DEV_SUB when NODE_ENV is development", async () => {
      delete process.env.AUTH_PROXY_SECRET;
      process.env.NODE_ENV = "development";
      const res = await makeApp().request("/whoami");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.sub).toBe("dev:local");
    });

    it("dev: header uid overrides DEV_SUB", async () => {
      delete process.env.AUTH_PROXY_SECRET;
      process.env.NODE_ENV = "development";
      const res = await makeApp().request("/whoami", {
        headers: { "x-authentik-uid": "explicit-user" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.sub).toBe("explicit-user");
    });
  });

  describe("AUTH_PROXY_SECRET_FILE", () => {
    it("authenticates against the secret loaded from the file", async () => {
      await using td = await tempDir("auth-secret-");
      const p = join(td.path, "proxy-secret");
      writeFileSync(p, `${SECRET}\n`);
      process.env.AUTH_PROXY_SECRET_FILE = p;
      const res = await makeApp().request("/whoami", {
        headers: {
          "x-auth-proxy-secret": SECRET,
          "x-authentik-uid": "user-file-secret",
        },
      });
      expect(res.status).toBe(200);
    });

    it("rejects requests whose header doesn't match the file contents", async () => {
      await using td = await tempDir("auth-secret-");
      const p = join(td.path, "proxy-secret");
      writeFileSync(p, SECRET);
      process.env.AUTH_PROXY_SECRET_FILE = p;
      const res = await makeApp().request("/whoami", {
        headers: { "x-auth-proxy-secret": "wrong" },
      });
      expect(res.status).toBe(401);
    });

    it("fails closed (500) when both AUTH_PROXY_SECRET and AUTH_PROXY_SECRET_FILE are set", async () => {
      await using td = await tempDir("auth-secret-");
      const p = join(td.path, "proxy-secret");
      writeFileSync(p, SECRET);
      process.env.AUTH_PROXY_SECRET = SECRET;
      process.env.AUTH_PROXY_SECRET_FILE = p;
      // Hono の default error handler が console.error を呼ぶので test 出力ノイズを抑える
      const errSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await makeApp().request("/whoami", {
          headers: { "x-auth-proxy-secret": SECRET },
        });
        expect(res.status).toBe(500);
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  it("upsert results in a single User row per authentikSub", async () => {
    process.env.AUTH_PROXY_SECRET = SECRET;
    const headers = { "x-auth-proxy-secret": SECRET, "x-authentik-uid": "user-counted" };
    await makeApp().request("/whoami", { headers });
    await makeApp().request("/whoami", { headers });
    await makeApp().request("/whoami", { headers });
    const count = await prisma.user.count({ where: { authentikSub: "user-counted" } });
    expect(count).toBe(1);
  });

  it("concurrent first-login requests both succeed and converge to one row", async () => {
    process.env.AUTH_PROXY_SECRET = SECRET;
    const headers = { "x-auth-proxy-secret": SECRET, "x-authentik-uid": "user-concurrent" };
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => makeApp().request("/whoami", { headers })),
    );
    for (const res of responses) expect(res.status).toBe(200);
    const count = await prisma.user.count({ where: { authentikSub: "user-concurrent" } });
    expect(count).toBe(1);
  });
});
