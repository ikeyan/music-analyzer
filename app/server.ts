import { createApp } from "honox/server";
import { showRoutes } from "hono/dev";
import { blobs } from "./api/blobs";

const app = createApp({
  init(hono) {
    hono.route("/api/blobs", blobs);
  },
});

showRoutes(app);

export default app;
