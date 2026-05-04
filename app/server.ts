import { createApp } from "honox/server";
import { showRoutes } from "hono/dev";
import { blobs } from "./api/blobs";
import { projects } from "./api/projects";

const app = createApp({
  init(hono) {
    hono.route("/api/blobs", blobs);
    hono.route("/api/projects", projects);
  },
});

showRoutes(app);

export default app;
