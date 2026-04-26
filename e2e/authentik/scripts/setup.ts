// Idempotent setup for the music-analyzer authentik objects.
//
// Callable from:
//   - The e2e test's beforeAll (both self-managed and external modes)
//   - The CLI (e.g. `bun run e2e/authentik/scripts/setup.ts`) for ad-hoc
//     provisioning against a running stack.
//
// What it does:
//   1. Waits for the default authorization + invalidation flows to exist
//      (covers both the post-health auth-token propagation delay and the
//      race against authentik's own blueprint worker).
//   2. Creates the music-analyzer proxy provider (or finds it).
//   3. Creates the music-analyzer application (or finds it).
//   4. Binds the provider to the embedded outpost AND sets
//      config.authentik_host — without the latter the embedded outpost
//      refuses to serve /outpost.goauthentik.io/* and 404s every request.
//   5. Waits for the outpost endpoint to return a status that proves auth is
//      actually wired up — 2xx/3xx (the unauth redirect chain) or 401 — not
//      just "anything but 404", which would let transient 5xx during boot
//      slip through as "ready". Probes with the X-Forwarded-* headers that
//      Caddy's forward_auth would send.

const PROVIDER_NAME = "music-analyzer-provider";
const APP_SLUG = "music-analyzer";
const APP_NAME = "Music Analyzer";
const EMBEDDED_OUTPOST_MANAGED_KEY = "goauthentik.io/outposts/embedded";

const AUTH_FLOW_SLUG = "default-provider-authorization-implicit-consent";
const INV_FLOW_SLUG = "default-provider-invalidation-flow";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 2_000;
const PER_REQUEST_TIMEOUT_MS = 30_000;

export interface SetupOptions {
  /** Base URL of the authentik API, as reachable from this process. */
  authentikUrl: string;
  /** Bearer token (typically AUTHENTIK_BOOTSTRAP_TOKEN). */
  token: string;
  /** URL the user visits (what Caddy serves). Becomes provider.external_host. */
  externalHost: string;
  /**
   * URL the outpost tells the user's browser to visit for login. For the
   * standard loopback CI setup this is the same authentikUrl. Defaults to
   * authentikUrl when not specified.
   */
  authentikHostForBrowser?: string;
  /** Overall deadline for the entire setup. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Log sink; defaults to console.log. Pass () => {} to silence. */
  log?: (msg: string) => void;
}

export async function setupMusicAnalyzer(opts: SetupOptions): Promise<void> {
  const log = opts.log ?? console.log;
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const authHeaders = { Authorization: `Bearer ${opts.token}` };
  const api = `${opts.authentikUrl.replace(/\/$/, "")}/api/v3`;
  const browserHost = opts.authentikHostForBrowser ?? opts.authentikUrl;

  log(`waiting for ${AUTH_FLOW_SLUG}...`);
  const authFlowPk = await waitForFlow(api, authHeaders, AUTH_FLOW_SLUG, deadline, log);
  log(`waiting for ${INV_FLOW_SLUG}...`);
  const invFlowPk = await waitForFlow(api, authHeaders, INV_FLOW_SLUG, deadline, log);
  log(`  auth_flow_pk=${authFlowPk} inv_flow_pk=${invFlowPk}`);

  let providerPk = await findProviderPk(api, authHeaders);
  if (providerPk === null) {
    providerPk = await createProvider(api, authHeaders, {
      authFlowPk,
      invFlowPk,
      externalHost: opts.externalHost,
    });
    log(`created provider pk=${providerPk}`);
  } else {
    log(`provider already exists pk=${providerPk}`);
  }

  if (!(await applicationExists(api, authHeaders))) {
    await createApplication(api, authHeaders, providerPk);
    log(`created application ${APP_SLUG}`);
  } else {
    log(`application ${APP_SLUG} already exists`);
  }

  await bindEmbeddedOutpost(api, authHeaders, providerPk, browserHost);
  log(`bound provider to embedded outpost (authentik_host=${browserHost})`);

  log("waiting for outpost /outpost.goauthentik.io/auth/caddy to serve...");
  await waitForOutpostEndpoint(opts.authentikUrl, opts.externalHost, deadline);
  log("outpost endpoint ready");
}

async function waitForFlow(
  api: string,
  auth: Record<string, string>,
  slug: string,
  deadline: number,
  log: (msg: string) => void,
): Promise<string> {
  // Surface the first non-ok status / exception so a misconfigured token or
  // unreachable host doesn't masquerade as "flow never appeared" five
  // minutes later.
  let firstFailureLogged = false;
  const noteFailure = (detail: string): void => {
    if (firstFailureLogged) return;
    firstFailureLogged = true;
    log(`  waitForFlow(${slug}): first failure — ${detail}`);
  };
  while (Date.now() < deadline) {
    try {
      const res = await timedFetch(`${api}/flows/instances/?slug=${slug}`, { headers: auth });
      if (res.ok) {
        const body = (await res.json()) as { results: { pk: string; slug: string }[] };
        const match = body.results.find((f) => f.slug === slug);
        if (match) return match.pk;
      } else {
        noteFailure(`HTTP ${res.status}`);
      }
    } catch (err) {
      noteFailure(err instanceof Error ? err.message : String(err));
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`flow ${slug} did not become available within the timeout`);
}

async function findProviderPk(api: string, auth: Record<string, string>): Promise<number | null> {
  // `search` is the DRF SearchFilter that authentik's providers viewset
  // exposes; an unknown filter key (e.g. ?name=) gets silently ignored and
  // the API returns an unfiltered first page, which would let us pick up an
  // unrelated provider in external mode. Re-verify with an exact name match
  // client-side so the result can never be a false positive.
  const res = await timedFetch(
    `${api}/providers/proxy/?search=${encodeURIComponent(PROVIDER_NAME)}`,
    {
      headers: auth,
    },
  );
  if (!res.ok) throw new Error(`list providers failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { results: { pk: number; name: string }[] };
  const match = body.results.find((p) => p.name === PROVIDER_NAME);
  return match?.pk ?? null;
}

async function createProvider(
  api: string,
  auth: Record<string, string>,
  p: { authFlowPk: string; invFlowPk: string; externalHost: string },
): Promise<number> {
  const res = await timedFetch(`${api}/providers/proxy/`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: PROVIDER_NAME,
      mode: "forward_single",
      external_host: p.externalHost,
      authorization_flow: p.authFlowPk,
      invalidation_flow: p.invFlowPk,
    }),
  });
  if (!res.ok) throw new Error(`create provider failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { pk: number };
  return body.pk;
}

async function applicationExists(api: string, auth: Record<string, string>): Promise<boolean> {
  const res = await timedFetch(`${api}/core/applications/?search=${encodeURIComponent(APP_SLUG)}`, {
    headers: auth,
  });
  if (!res.ok) throw new Error(`list applications failed: ${res.status} ${await res.text()}`);
  // Same defensive client-side filter as findProviderPk: an unknown server-
  // side filter key returns the unfiltered first page in DRF.
  const body = (await res.json()) as { results: { slug: string }[] };
  return body.results.some((a) => a.slug === APP_SLUG);
}

async function createApplication(
  api: string,
  auth: Record<string, string>,
  providerPk: number,
): Promise<void> {
  const res = await timedFetch(`${api}/core/applications/`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ name: APP_NAME, slug: APP_SLUG, provider: providerPk }),
  });
  if (!res.ok) throw new Error(`create application failed: ${res.status} ${await res.text()}`);
}

async function bindEmbeddedOutpost(
  api: string,
  auth: Record<string, string>,
  providerPk: number,
  authentikHost: string,
): Promise<void> {
  const listRes = await timedFetch(`${api}/outposts/instances/`, { headers: auth });
  if (!listRes.ok)
    throw new Error(`list outposts failed: ${listRes.status} ${await listRes.text()}`);
  const list = (await listRes.json()) as {
    results: {
      pk: string;
      managed: string | null;
      config: Record<string, unknown>;
      providers: number[];
    }[];
  };
  const embedded = list.results.find((o) => o.managed === EMBEDDED_OUTPOST_MANAGED_KEY);
  if (!embedded) {
    throw new Error(`embedded outpost (managed=${EMBEDDED_OUTPOST_MANAGED_KEY}) not found`);
  }

  // Append + dedupe rather than replace: in external mode the embedded
  // outpost may already gate other applications, and providers is a full-
  // replacement field on PATCH (not a merge).
  const existing = Array.isArray(embedded.providers) ? embedded.providers : [];
  const providers = Array.from(new Set([...existing, providerPk]));

  const patchRes = await timedFetch(`${api}/outposts/instances/${embedded.pk}/`, {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      providers,
      config: { ...embedded.config, authentik_host: authentikHost },
    }),
  });
  if (!patchRes.ok) {
    throw new Error(`patch outpost failed: ${patchRes.status} ${await patchRes.text()}`);
  }
}

async function waitForOutpostEndpoint(
  authentikUrl: string,
  externalHost: string,
  deadline: number,
): Promise<void> {
  const externalHostHeader = new URL(externalHost).host;
  const url = `${authentikUrl.replace(/\/$/, "")}/outpost.goauthentik.io/auth/caddy`;
  const headers = {
    "X-Forwarded-Host": externalHostHeader,
    "X-Forwarded-Uri": "/",
    "X-Forwarded-Proto": "http",
    "X-Forwarded-Method": "GET",
  };
  while (Date.now() < deadline) {
    try {
      const res = await timedFetch(url, { headers, redirect: "manual" });
      // 2xx: outpost returned an allow decision (unlikely for an anon probe).
      // 3xx: redirect into the login flow — the normal "gate is up" answer.
      // 401: older authentik versions answer challenges this way.
      // Anything else (404 while binding propagates, 5xx during boot, etc.)
      // means the gate is not yet wired up — keep waiting.
      const ready = (res.status >= 200 && res.status < 400) || res.status === 401;
      if (ready) return;
    } catch {
      // retry
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`outpost endpoint did not become ready within the deadline`);
}

async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS) });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// CLI entrypoint: `bun run e2e/authentik/scripts/setup.ts`
if (import.meta.main) {
  const authentikUrl = process.env.AUTHENTIK_E2E_AUTHENTIK_URL || "http://localhost:9000";
  const caddyUrl = process.env.AUTHENTIK_E2E_CADDY_URL || "http://localhost:8080";
  const token = process.env.AUTHENTIK_BOOTSTRAP_TOKEN;
  if (!token) {
    console.error("AUTHENTIK_BOOTSTRAP_TOKEN is required");
    process.exit(1);
  }
  await setupMusicAnalyzer({ authentikUrl, token, externalHost: caddyUrl });
}
