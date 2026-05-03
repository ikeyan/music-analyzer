// RUN_AUTHENTIK_E2E=1で起動。AUTHENTIK_E2E_*_URLが両方セットされていれば
// external mode (CIはコンテナをテスト終了後も残してログ採取するためこちら)、
// 未セットならtestcontainersで自前起動。setupMusicAnalyzerはbeforeAllで
// idempotentに呼ぶ。
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DockerComposeEnvironment,
  type StartedDockerComposeEnvironment,
  Wait,
} from "testcontainers";
import { setupMusicAnalyzer } from "./scripts/setup";
import { jarFetch, loginAndAuthorize } from "./scripts/login";

const RUN = process.env.RUN_AUTHENTIK_E2E === "1";
// authentikのfirst bootはDB migrationで重い
const STARTUP_MS = Number(process.env.AUTHENTIK_E2E_STARTUP_MS ?? 10 * 60_000);
// up()自体が落ちた場合testcontainersが自動tear-downするのでこのフラグは無効
const KEEP_CONTAINERS = process.env.KEEP_CONTAINERS === "1";

const EXTERNAL_CADDY_URL = process.env.AUTHENTIK_E2E_CADDY_URL ?? "";
const EXTERNAL_AUTHENTIK_URL = process.env.AUTHENTIK_E2E_AUTHENTIK_URL ?? "";
const EXTERNAL_MODE = Boolean(EXTERNAL_CADDY_URL && EXTERNAL_AUTHENTIK_URL);

const COMPOSE_DIR = dirname(fileURLToPath(import.meta.url));
// external modeでは起動済みstackのbootstrap値と一致必須。ランダムfallbackは
// 統合バグに偽装した決定的失敗を生むのでbeforeAllで検証する
const BOOTSTRAP_TOKEN = process.env.AUTHENTIK_BOOTSTRAP_TOKEN || `e2e-${crypto.randomUUID()}`;
const BOOTSTRAP_PASSWORD = process.env.AUTHENTIK_BOOTSTRAP_PASSWORD || `e2e-${crypto.randomUUID()}`;

let env: StartedDockerComposeEnvironment | undefined;
let caddyUrl = "";
let authentikUrl = "";

beforeAll(async () => {
  if (!RUN) return;

  if (EXTERNAL_MODE) {
    if (!process.env.AUTHENTIK_BOOTSTRAP_TOKEN) {
      throw new Error(
        "external mode (AUTHENTIK_E2E_*_URL set) requires AUTHENTIK_BOOTSTRAP_TOKEN to match the running stack's token",
      );
    }
    if (!process.env.AUTHENTIK_BOOTSTRAP_PASSWORD) {
      throw new Error(
        "external mode (AUTHENTIK_E2E_*_URL set) requires AUTHENTIK_BOOTSTRAP_PASSWORD to match akadmin's password on the running stack",
      );
    }
    caddyUrl = EXTERNAL_CADDY_URL;
    authentikUrl = EXTERNAL_AUTHENTIK_URL;
  } else {
    env = await new DockerComposeEnvironment(COMPOSE_DIR, "compose.yaml")
      .withEnvironment({
        PG_PASS: "e2e-pg-pass",
        // authentikは短いsecretを拒否するため50文字以上
        AUTHENTIK_SECRET_KEY: `e2e-secret-${crypto.randomUUID()}-${crypto.randomUUID()}`,
        AUTHENTIK_BOOTSTRAP_EMAIL: "admin@localhost",
        AUTHENTIK_BOOTSTRAP_PASSWORD: BOOTSTRAP_PASSWORD,
        AUTHENTIK_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
        // 並行実行のportコリジョン回避
        CADDY_PORT_HTTP: "0",
        AUTHENTIK_PORT_HTTP: "0",
        AUTHENTIK_PORT_HTTPS: "0",
      })
      .withWaitStrategy(
        "authentik-server-1",
        Wait.forHttp("/-/health/ready/", 9000).withStartupTimeout(STARTUP_MS),
      )
      .withWaitStrategy("caddy-1", Wait.forListeningPorts())
      .withStartupTimeout(STARTUP_MS)
      .up();

    const caddy = env.getContainer("caddy-1");
    const authentik = env.getContainer("authentik-server-1");
    caddyUrl = `http://${caddy.getHost()}:${caddy.getMappedPort(80)}`;
    authentikUrl = `http://${authentik.getHost()}:${authentik.getMappedPort(9000)}`;
  }

  await setupMusicAnalyzer({
    authentikUrl,
    token: BOOTSTRAP_TOKEN,
    externalHost: caddyUrl,
  });
}, STARTUP_MS);

afterAll(async () => {
  if (KEEP_CONTAINERS || EXTERNAL_MODE) return;
  await env?.down({ timeout: 30_000 });
});

// describe.skipでもbeforeAllは走るのでRUNでgateする
const d = RUN ? describe : describe.skip;

d("caddy -> authentik -> music-analyzer", () => {
  it("reports authentik as healthy", async () => {
    const res = await fetch(`${authentikUrl}/-/health/ready/`);
    expect(res.status).toBe(200);
  });

  it("has the proxy provider and application seeded", async () => {
    const auth = { Authorization: `Bearer ${BOOTSTRAP_TOKEN}` };
    // 完全一致filter (search はpaginationで対象が落ちうる)
    const [providers, apps] = await Promise.all([
      fetch(`${authentikUrl}/api/v3/providers/proxy/?name__iexact=music-analyzer-provider`, {
        headers: auth,
      }).then((r) => r.json() as Promise<{ results: { name: string }[] }>),
      fetch(`${authentikUrl}/api/v3/core/applications/?slug=music-analyzer`, {
        headers: auth,
      }).then((r) => r.json() as Promise<{ results: { slug: string }[] }>),
    ]);

    expect(providers.results.some((p) => p.name === "music-analyzer-provider")).toBe(true);
    expect(apps.results.some((a) => a.slug === "music-analyzer")).toBe(true);
  });

  it("has the embedded outpost gate anonymous forward_auth probes", async () => {
    // Caddyのforward_authはX-Forwarded-*を送る (X-Original-URLではない)。
    // 元URLを再構成できないとoutpostは404になる
    const caddyHost = new URL(caddyUrl).host;
    const res = await fetch(`${authentikUrl}/outpost.goauthentik.io/auth/caddy`, {
      headers: {
        "X-Forwarded-Host": caddyHost,
        "X-Forwarded-Uri": "/",
        "X-Forwarded-Proto": "http",
        "X-Forwarded-Method": "GET",
      },
      redirect: "manual",
    });
    // authentik 2025.xはOAuth authorizeへredirect。旧版は401+Location
    expect([301, 302, 303, 307, 401].includes(res.status)).toBe(true);
    expect(res.headers.get("location") ?? "").toMatch(/authorize|outpost\.goauthentik\.io/);
  });

  it("redirects unauthenticated visitors into the authentik login flow", async () => {
    const res = await fetch(`${caddyUrl}/`, { redirect: "manual" });
    expect([301, 302, 303, 307].includes(res.status)).toBe(true);
    // 旧setupは/outpost.goauthentik.io/start経由だったため両方許容
    expect(res.headers.get("location") ?? "").toMatch(/authorize|outpost\.goauthentik\.io/);
  });

  // vite devの初回コンパイルがCIで10s+、OAuthチェーンも数hop乗るのでデフォ5sでは不足
  const LOGIN_TIMEOUT_MS = 60_000;

  it(
    "lets akadmin log in and reach music-analyzer through Caddy",
    async () => {
      const jar = await loginAndAuthorize({
        authentikUrl,
        caddyUrl,
        username: "akadmin",
        password: BOOTSTRAP_PASSWORD,
      });

      const res = await jarFetch(jar, `${caddyUrl}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      // viteエラーoverlay / authentik login / 5xxにも"music-analyzer"は出るので
      // SSRされたindex固有の文字列で同定
      expect(html).toContain("music-analyzer / bun + hono + honox + react + prisma + sqlite");
    },
    LOGIN_TIMEOUT_MS,
  );
});
