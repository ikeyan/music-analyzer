import { afterAll, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// HonoX SSR (import.meta.glob) は vite なしで import できないので、
// vite build 済みの dist/index.js を子プロセスで起動して WebView で叩く

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIST_ENTRY = join(PROJECT_ROOT, "dist", "index.js");

// Bun.WebView は backend.args を受け付けないので、root で動く CI/sandbox 向けに
// --no-sandbox を付ける wrapper script の path を渡す前提
function resolveChromePath(): string {
  if (process.env.BUN_CHROME_PATH) return process.env.BUN_CHROME_PATH;
  const candidates = [
    "/opt/chrome-for-testing/chrome-wrap",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    "Chrome not found. Set BUN_CHROME_PATH or install Chrome at one of: " + candidates.join(", "),
  );
}

async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const { port } = probe;
  if (typeof port !== "number") throw new Error("Bun.serve port unavailable");
  probe.stop(true);
  return port;
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await Bun.sleep(100);
  }
  throw new Error(`server not ready within ${timeoutMs}ms: ${url}`);
}

let server: { url: string; close: () => Promise<void> } | null = null;
let view: Bun.WebView | null = null;

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(`${DIST_ENTRY} not found. Run \`bun run build\` first.`);
  }
  const port = await pickFreePort();
  // NODE_ENV=development で AUTH_PROXY_SECRET 不要、DEV_SUB="dev:local" で auto auth。
  // dist/ で cwd を取らないと static 配信が dist/static を見つけられない
  const proc = Bun.spawn(["bun", "run", "./index.js"], {
    cwd: dirname(DIST_ENTRY),
    env: { ...process.env, PORT: String(port), NODE_ENV: "development" },
    stdout: "ignore",
    stderr: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForReady(url, 15_000);
  return {
    url,
    close: async () => {
      proc.kill();
      await proc.exited;
    },
  };
}

// onNavigated は DidStartNavigation のタイミングで呼ばれて loading は true のまま、
// loading=false まで待ってもまだ navigate を即発行すると "navigation pending"
// になる。loading が true になるのを確認してから false へ落ちるのを待ち、軽い grace を入れる
export async function navigateAndWait(
  wv: Bun.WebView,
  url: string,
  timeoutMs = 15_000,
): Promise<void> {
  wv.navigate(url);
  const deadline = Date.now() + timeoutMs;
  while (!wv.loading) {
    if (Date.now() > deadline) throw new Error(`navigate didn't start: ${url}`);
    await Bun.sleep(5);
  }
  while (wv.loading) {
    if (Date.now() > deadline) throw new Error(`navigate didn't finish: ${url}`);
    await Bun.sleep(10);
  }
  await Bun.sleep(20);
}

// 1ファイル単位で server + WebView を共有する。test 間は clearDb で DB を初期化し
// navigateAndWait で同じ URL に戻す
export function useFrontend(): {
  server: () => string;
  webview: () => Bun.WebView;
  goto: (path: string) => Promise<void>;
} {
  beforeAll(async () => {
    server = await startServer();
    view = new Bun.WebView({
      url: "about:blank",
      backend: { type: "chrome", path: resolveChromePath() },
    });
    // 初期 about:blank の load が pending のまま次の navigate を呼ぶと
    // "navigation pending" になるので loading が落ち着くまで待つ
    const deadline = Date.now() + 10_000;
    while (view.loading) {
      if (Date.now() > deadline) throw new Error("about:blank didn't finish loading");
      await Bun.sleep(10);
    }
    await Bun.sleep(20);
  }, 30_000);

  afterAll(async () => {
    try {
      view?.close();
    } catch {
      /* close() は close 直後の next tick で "WebView closed" を投げる仕様 */
    }
    view = null;
    await server?.close();
    server = null;
  });

  return {
    server: () => {
      if (!server) throw new Error("useFrontend: server not started");
      return server.url;
    },
    webview: () => {
      if (!view) throw new Error("useFrontend: webview not initialized");
      return view;
    },
    goto: async (path: string) => {
      if (!server || !view) throw new Error("useFrontend: not initialized");
      await navigateAndWait(view, `${server.url}${path}`);
    },
  };
}

// 指定 selector が現れるまで待つ。SSR は即時だが hydration や fetch 後の DOM 変化用
export async function waitFor(wv: Bun.WebView, selector: string, timeoutMs = 5_000): Promise<void> {
  const expr = `new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (document.querySelector(${JSON.stringify(selector)})) return resolve(true);
      if (Date.now() - start > ${timeoutMs}) return reject(new Error("timeout: " + ${JSON.stringify(selector)}));
      setTimeout(tick, 30);
    };
    tick();
  })`;
  await wv.evaluate(expr);
}
