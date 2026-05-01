// music-analyzer用authentik objectsをidempotentに用意する。
// embedded outpostへのbindではconfig.authentik_hostも必須
// (未設定だと/outpost.goauthentik.io/*が404)。

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
  authentikUrl: string;
  token: string;
  /** Caddy側URL。provider.external_hostになる */
  externalHost: string;
  /** outpostがbrowserに案内するURL。未指定ならauthentikUrl */
  authentikHostForBrowser?: string;
  timeoutMs?: number;
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

  // Provider.name/Application.slugはDB unique。並行setupはfind→createで負けて
  // 400/409になるためensure*でcatch+再findする
  const providerPk = await ensureProvider(api, authHeaders, log, {
    authFlowPk,
    invFlowPk,
    externalHost: opts.externalHost,
  });

  await ensureApplication(api, authHeaders, log, providerPk);

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
  // 最初の失敗を残してtoken誤設定や到達不能を「flowが現れない」と誤認させない
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
  // 完全一致filter (search はpagination漏れで再作成→409を招く)。
  // 念のためclient側でも一致確認
  const res = await timedFetch(
    `${api}/providers/proxy/?name__iexact=${encodeURIComponent(PROVIDER_NAME)}`,
    {
      headers: auth,
    },
  );
  if (!res.ok) throw new Error(`list providers failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { results: { pk: number; name: string }[] };
  const match = body.results.find((p) => p.name === PROVIDER_NAME);
  return match?.pk ?? null;
}

async function ensureProvider(
  api: string,
  auth: Record<string, string>,
  log: (msg: string) => void,
  p: { authFlowPk: string; invFlowPk: string; externalHost: string },
): Promise<number> {
  const existing = await findProviderPk(api, auth);
  if (existing !== null) {
    log(`provider already exists pk=${existing}`);
    return existing;
  }
  try {
    const pk = await createProvider(api, auth, p);
    log(`created provider pk=${pk}`);
    return pk;
  } catch (err) {
    // 並行createで負けた可能性があるので再find
    const second = await findProviderPk(api, auth);
    if (second !== null) {
      log(`provider was created concurrently, reusing pk=${second}`);
      return second;
    }
    throw err;
  }
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

async function ensureApplication(
  api: string,
  auth: Record<string, string>,
  log: (msg: string) => void,
  providerPk: number,
): Promise<void> {
  if (await applicationExists(api, auth)) {
    log(`application ${APP_SLUG} already exists`);
    return;
  }
  try {
    await createApplication(api, auth, providerPk);
    log(`created application ${APP_SLUG}`);
  } catch (err) {
    if (await applicationExists(api, auth)) {
      log(`application ${APP_SLUG} was created concurrently, reusing`);
      return;
    }
    throw err;
  }
}

async function applicationExists(api: string, auth: Record<string, string>): Promise<boolean> {
  // 完全一致filter (理由はfindProviderPkと同じ)
  const res = await timedFetch(`${api}/core/applications/?slug=${encodeURIComponent(APP_SLUG)}`, {
    headers: auth,
  });
  if (!res.ok) throw new Error(`list applications failed: ${res.status} ${await res.text()}`);
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

  // providersはPATCHでmergeでなく全置換されるためappend+dedupe
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
      // 2xx/3xx (login flowへredirect) または 401 (旧版) でready扱い。
      // boot中の404/5xxは未配線として待つ
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
