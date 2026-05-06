import { createApp } from "honox/server";
import { showRoutes } from "hono/dev";
import { api } from "./api";
import { blobs } from "./api/blobs";
import { startDeletionSweeper } from "./lib/gc";

// /api/blobs はバケット全体を素通しする dev/scratch 用 endpoint なので
// development 環境以外では mount しない (production / staging に晒すと
// バケット全件 list / read / write が無認証で開く)
const ENABLE_BLOBS = process.env.NODE_ENV === "development";

const app = createApp({
  init(hono) {
    if (ENABLE_BLOBS) hono.route("/api/blobs", blobs);
    hono.route("/api", api);
  },
});

startDeletionSweeper();

showRoutes(app);

export default app;
