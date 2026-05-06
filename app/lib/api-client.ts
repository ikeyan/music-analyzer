import { hc } from "hono/client";
import type { AppType } from "../api";

// Hono RPC client。型は server 側 chain から自動推論される
export const apiClient = hc<AppType>("/api");
