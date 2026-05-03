// authentikのflow executor APIを直接叩いてe2e loginを行う。
// default-authentication-flowに新stage (例: MFA) が追加されたら
// buildStagePayloadの拡張が必要。

export class CookieJar {
  // loopback前提のためpath/secure/samesiteは無視
  private byHost = new Map<string, Map<string, string>>();

  store(url: string, res: Response): void {
    const host = new URL(url).host;
    const raws = res.headers.getSetCookie();
    if (raws.length === 0) return;
    const bag = this.byHost.get(host) ?? new Map<string, string>();
    for (const raw of raws) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || value === '""') bag.delete(name);
      else bag.set(name, value);
    }
    this.byHost.set(host, bag);
  }

  headerFor(url: string): string {
    const bag = this.byHost.get(new URL(url).host);
    if (!bag || bag.size === 0) return "";
    return [...bag].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get(host: string, name: string): string | undefined {
    return this.byHost.get(host)?.get(name);
  }
}

export async function jarFetch(jar: CookieJar, url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const cookie = jar.headerFor(url);
  if (cookie) headers.set("cookie", cookie);
  // authentikのDRFはcookieのCSRFトークンをheaderにecho必須
  const csrf = jar.get(new URL(url).host, "authentik_csrf");
  if (csrf && !headers.has("x-csrftoken")) headers.set("x-csrftoken", csrf);
  if (!headers.has("referer")) headers.set("referer", url);
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  jar.store(url, res);
  return res;
}

async function followRedirects(
  jar: CookieJar,
  startUrl: string,
  init?: RequestInit,
  maxHops = 15,
): Promise<Response> {
  let url = startUrl;
  let headers = init?.headers;
  let method = init?.method ?? "GET";
  let body = init?.body;
  for (let i = 0; i < maxHops; i++) {
    const res = await jarFetch(jar, url, { method, body, headers });
    if (res.status < 300 || res.status >= 400) {
      console.log(`  [follow] #${i} ${method} ${url} -> ${res.status}`);
      return res;
    }
    const loc = res.headers.get("location");
    console.log(`  [follow] #${i} ${method} ${url} -> ${res.status} ${loc ?? "(no Location)"}`);
    if (!loc) return res;
    url = new URL(loc, url).toString();
    method = "GET";
    body = undefined;
    headers = undefined;
  }
  throw new Error(`too many redirects starting from ${startUrl}`);
}

export interface LoginOptions {
  authentikUrl: string;
  caddyUrl: string;
  username: string;
  password: string;
  flowSlug?: string;
}

export async function loginAndAuthorize(opts: LoginOptions): Promise<CookieJar> {
  const jar = new CookieJar();
  const flowSlug = opts.flowSlug ?? "default-authentication-flow";
  const flowUrl = `${opts.authentikUrl.replace(/\/$/, "")}/api/v3/flows/executor/${flowSlug}/`;

  // 初回GETでauthentik_csrf cookieも仕込まれる
  const startRes = await jarFetch(jar, flowUrl, {
    headers: { accept: "application/json" },
  });
  if (!startRes.ok) {
    throw new Error(`flow executor GET failed: ${startRes.status} ${await startRes.text()}`);
  }
  let stage = (await startRes.json()) as Record<string, unknown>;

  for (let i = 0; i < 10; i++) {
    const component = stage["component"] as string | undefined;
    if (!component) throw new Error(`flow response missing component: ${JSON.stringify(stage)}`);
    if (component === "xak-flow-redirect") break;

    const payload = buildStagePayload(component, opts);
    let res = await jarFetch(jar, flowUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    // authentikはstage POST後Post-Redirect-Getを更にチェーンしうる。
    // accept: application/jsonを保ってHTML rendererに落ちないようにする
    let hops = 0;
    while (res.status >= 300 && res.status < 400) {
      if (hops++ >= 5) {
        throw new Error(`${component} POST: too many redirects (last status ${res.status})`);
      }
      const loc = res.headers.get("location");
      if (!loc) {
        throw new Error(`${component} POST returned ${res.status} with no Location header`);
      }
      const nextUrl = new URL(loc, flowUrl).toString();
      console.log(`  [${component}] follow #${hops}: ${res.status} -> ${nextUrl}`);
      res = await jarFetch(jar, nextUrl, {
        headers: { accept: "application/json" },
      });
    }
    if (!res.ok) {
      const loc = res.headers.get("location");
      const body = await res.text();
      throw new Error(
        `flow stage ${component} POST failed: status=${res.status}${loc ? ` location=${loc}` : ""} body=${body.slice(0, 500)}`,
      );
    }
    stage = (await res.json()) as Record<string, unknown>;
  }

  // Caddy hostにproxy session cookieを着地させるためOAuth callbackチェーンを辿る
  const landing = await followRedirects(jar, `${opts.caddyUrl.replace(/\/$/, "")}/`);
  if (landing.status !== 200) {
    throw new Error(
      `expected 200 at ${opts.caddyUrl}/ after login, got ${landing.status} (final url: ${landing.url})`,
    );
  }

  return jar;
}

function buildStagePayload(component: string, opts: LoginOptions): Record<string, unknown> {
  switch (component) {
    case "ak-stage-identification":
      return { component, uid_field: opts.username };
    case "ak-stage-password":
      return { component, password: opts.password };
    default:
      throw new Error(
        `unhandled flow stage: ${component} — extend buildStagePayload if authentik's default flow added a new stage`,
      );
  }
}
