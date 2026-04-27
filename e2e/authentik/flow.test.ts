// E2E smoke test for the caddy -> authentik -> music-analyzer stack.
//
// Two run modes (gate with RUN_AUTHENTIK_E2E=1 either way):
//
//   1. Self-managed (default): boot the stack via testcontainers'
//      DockerComposeEnvironment. Convenient for local dev.
//   2. External: when AUTHENTIK_E2E_CADDY_URL and AUTHENTIK_E2E_AUTHENTIK_URL
//      are set, connect to an already-running stack. CI uses this path so
//      containers survive test-process exit and logs stay collectable on
//      failure.
//
// Both modes then call `setupMusicAnalyzer` (idempotent) from beforeAll, so
// the provider/application/outpost binding is in place regardless of who
// booted the stack.
//
// What it covers:
//   1. authentik /-/health/ready/ returns 200.
//   2. The proxy provider + application exist after setup.
//   3. The embedded outpost gates anonymous forward_auth probes.
//   4. Caddy at / forwards unauthenticated visitors into the login flow.
//
// UI-level login is intentionally out of scope here; add Playwright in a
// follow-up if we want to exercise the full sign-in flow.
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
// Authentik does a DB migration on first boot; give CI a generous window
// (override with AUTHENTIK_E2E_STARTUP_MS for local tuning).
const STARTUP_MS = Number(process.env.AUTHENTIK_E2E_STARTUP_MS ?? 10 * 60_000);
// Set KEEP_CONTAINERS=1 to skip env.down() so CI can dump logs on failure.
// Doesn't help if DockerComposeEnvironment.up() itself throws — that path
// tears down automatically inside testcontainers.
const KEEP_CONTAINERS = process.env.KEEP_CONTAINERS === "1";

// External-stack mode: caller boots compose, sets URLs and bootstrap token,
// and we just hit the endpoints. Used in CI.
const EXTERNAL_CADDY_URL = process.env.AUTHENTIK_E2E_CADDY_URL ?? "";
const EXTERNAL_AUTHENTIK_URL = process.env.AUTHENTIK_E2E_AUTHENTIK_URL ?? "";
const EXTERNAL_MODE = Boolean(EXTERNAL_CADDY_URL && EXTERNAL_AUTHENTIK_URL);

const COMPOSE_DIR = dirname(fileURLToPath(import.meta.url));
// Bootstrap token must match the one passed to the running stack in external
// mode. In self-managed mode we pick a fresh one per run.
const BOOTSTRAP_TOKEN = process.env.AUTHENTIK_BOOTSTRAP_TOKEN || `e2e-${crypto.randomUUID()}`;
const BOOTSTRAP_PASSWORD = process.env.AUTHENTIK_BOOTSTRAP_PASSWORD || `e2e-${crypto.randomUUID()}`;

let env: StartedDockerComposeEnvironment | undefined;
let caddyUrl = "";
let authentikUrl = "";

beforeAll(async () => {
  if (!RUN) return;

  if (EXTERNAL_MODE) {
    caddyUrl = EXTERNAL_CADDY_URL;
    authentikUrl = EXTERNAL_AUTHENTIK_URL;
  } else {
    env = await new DockerComposeEnvironment(COMPOSE_DIR, "compose.yaml")
      .withEnvironment({
        PG_PASS: "e2e-pg-pass",
        // 50+ chars; authentik refuses short secrets.
        AUTHENTIK_SECRET_KEY: `e2e-secret-${crypto.randomUUID()}-${crypto.randomUUID()}`,
        AUTHENTIK_BOOTSTRAP_EMAIL: "admin@localhost",
        AUTHENTIK_BOOTSTRAP_PASSWORD: BOOTSTRAP_PASSWORD,
        AUTHENTIK_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
        // Let docker assign free host ports so parallel runs don't collide.
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

  // Idempotent: creates the provider/application/outpost binding the first
  // time, no-ops on subsequent calls. In external mode this lets the test
  // own the provisioning, so the CI workflow doesn't need its own seed step.
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

// bun:test's `describe.skip` still runs `beforeAll`, so we gate both.
const d = RUN ? describe : describe.skip;

d("caddy -> authentik -> music-analyzer", () => {
  it("reports authentik as healthy", async () => {
    const res = await fetch(`${authentikUrl}/-/health/ready/`);
    expect(res.status).toBe(200);
  });

  it("has the proxy provider and application seeded", async () => {
    const auth = { Authorization: `Bearer ${BOOTSTRAP_TOKEN}` };
    const [providers, apps] = await Promise.all([
      fetch(`${authentikUrl}/api/v3/providers/proxy/?search=music-analyzer-provider`, {
        headers: auth,
      }).then((r) => r.json() as Promise<{ results: { name: string }[] }>),
      fetch(`${authentikUrl}/api/v3/core/applications/?search=music-analyzer`, {
        headers: auth,
      }).then((r) => r.json() as Promise<{ results: { slug: string }[] }>),
    ]);

    expect(providers.results.some((p) => p.name === "music-analyzer-provider")).toBe(true);
    expect(apps.results.some((a) => a.slug === "music-analyzer")).toBe(true);
  });

  it("has the embedded outpost gate anonymous forward_auth probes", async () => {
    // Caddy's forward_auth directive sends X-Forwarded-* headers to the
    // authentik outpost, not X-Original-URL. Mirror that here so the outpost
    // can reconstruct the original request URL and match a proxy provider —
    // otherwise it 404s on every request.
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
    // authentik 2025.x redirects anonymous forward_auth probes to the OAuth
    // authorize endpoint (older versions used 401 + Location).
    expect([301, 302, 303, 307, 401].includes(res.status)).toBe(true);
    expect(res.headers.get("location") ?? "").toMatch(/authorize|outpost\.goauthentik\.io/);
  });

  it("redirects unauthenticated visitors into the authentik login flow", async () => {
    const res = await fetch(`${caddyUrl}/`, { redirect: "manual" });
    expect([301, 302, 303, 307].includes(res.status)).toBe(true);
    // Caddy forwards the outpost's 302 verbatim; for a proxy provider that
    // lands on the OAuth authorize URL (with client_id / redirect_uri etc).
    // Older setups went via /outpost.goauthentik.io/start — accept both.
    expect(res.headers.get("location") ?? "").toMatch(/authorize|outpost\.goauthentik\.io/);
  });

  // The default 5s is too tight: first hit into music-analyzer's vite dev
  // server compiles the entry and can take 10s+ on CI runners, and the
  // OAuth redirect chain adds several hops on top.
  const LOGIN_TIMEOUT_MS = 60_000;

  it(
    "lets akadmin log in and reach music-analyzer through Caddy",
    async () => {
      // Drives the flow executor as akadmin, then follows the OAuth callback
      // chain so the jar carries the authentik_proxy_* cookie that
      // forward_auth honours.
      const jar = await loginAndAuthorize({
        authentikUrl,
        caddyUrl,
        username: "akadmin",
        password: BOOTSTRAP_PASSWORD,
      });

      const res = await jarFetch(jar, `${caddyUrl}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      // Match the home route's distinctive <p> fingerprint rather than just
      // "music-analyzer" — vite error overlays / authentik login pages /
      // generic 5xx bodies can all contain the project name, but only the
      // SSR'd index page contains this exact string.
      expect(html).toContain("music-analyzer / bun + hono + honox + react + prisma + sqlite");
    },
    LOGIN_TIMEOUT_MS,
  );
});
