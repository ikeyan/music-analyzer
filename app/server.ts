import { createApp } from "honox/server";
import { showRoutes } from "hono/dev";
import { api } from "./api";
import { blobs } from "./api/blobs";
import { startDeletionSweeper } from "./lib/gc";
import { recoverTasksOnStartup } from "./lib/task-runner";

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

// recovery が pending task の upload prefix DeletionMark を引き直すまで sweeper の
// 初回 sweep を待たせる。recovery が transient DB error で失敗した場合は retry し続け、
// 成功するまで sweep を走らせない (古い nextRetryAt で chunks を消さないため)
const RECOVERY_RETRY_DELAY_MS = 5_000;
const recoveryReady = (async () => {
  while (true) {
    try {
      await recoverTasksOnStartup();
      return;
    } catch (err) {
      console.error("task recovery failed, retrying", err);
      await Bun.sleep(RECOVERY_RETRY_DELAY_MS);
    }
  }
})();
startDeletionSweeper(undefined, recoveryReady);

showRoutes(app);

export default app;
