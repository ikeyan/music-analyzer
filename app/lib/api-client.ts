import { hc } from "hono/client";
import type { AppType } from "../api";

// Hono RPC client。型は server 側 chain から自動推論される。
// $url() は内部で `new URL(merged)` を呼ぶので relative base だと Invalid URL。
// SSR で評価される event handler 外の base 文字列としては relative で十分なので、
// browser 文脈のときだけ location.origin で絶対化する
const base = typeof window !== "undefined" ? `${window.location.origin}/api` : "/api";
export const apiClient = hc<AppType>(base);
