import { Hono } from "hono";
import { projects } from "./projects";

// /api 以下のルートを束ねた型付き Hono。型は islands が hc<AppType> で消費する
export const api = new Hono().route("/projects", projects);

export type AppType = typeof api;
