import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { prisma } from "../lib/prisma";
import { getS3 } from "../lib/s3";
import { uploadChunkKey, uploadPrefix } from "../lib/storage";
import { waitForInflightTasks } from "../lib/task-runner";
import { useDbFixture } from "../test-fixtures/db";
import { useMediaFixture } from "../test-fixtures/media";
import { useS3Fixture } from "../test-fixtures/s3";
import { UPLOAD_EXPIRY_MS, projects } from "./projects";
import type { ApiProjectDetail, ApiTask, ApiUpload } from "./types";

useDbFixture();
useS3Fixture();
const getMedia = useMediaFixture();

// AUTH_PROXY_SECRET 未設定 + NODE_ENV=development で requireUser は DEV_SUB を許可する
const DEV_HEADERS = { "x-authentik-uid": "dev:test" };

function appWithProjects(): Hono {
  return new Hono().route("/api/projects", projects);
}

async function createProject(app: Hono, name: string): Promise<string> {
  const res = await app.request("/api/projects", {
    method: "POST",
    headers: { ...DEV_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`createProject: ${res.status}`);
  const body = (await res.json()) as { project: { id: string } };
  return body.project.id;
}

async function uploadChunked(
  app: Hono,
  projectId: string,
  kind: "video" | "audio",
  fileName: string,
  bytes: Uint8Array,
  chunkSize: number,
  contentType: string,
): Promise<{ upload: ApiUpload; task: ApiTask }> {
  const create = await app.request(`/api/projects/${projectId}/uploads`, {
    method: "POST",
    headers: { ...DEV_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({
      kind,
      fileName,
      contentType,
      totalBytes: bytes.byteLength,
      chunkSize,
    }),
  });
  expect(create.status).toBe(201);
  const upload = ((await create.json()) as { upload: ApiUpload }).upload;
  for (let i = 0; i < upload.totalChunks; i++) {
    const start = i * upload.chunkSize;
    const end = Math.min(bytes.byteLength, start + upload.chunkSize);
    const slice = bytes.slice(start, end);
    const res = await app.request(`/api/projects/${projectId}/uploads/${upload.id}/chunks/${i}`, {
      method: "PUT",
      headers: { ...DEV_HEADERS, "content-type": contentType },
      body: slice,
    });
    expect(res.status).toBe(200);
  }
  const complete = await app.request(`/api/projects/${projectId}/uploads/${upload.id}/complete`, {
    method: "POST",
    headers: { ...DEV_HEADERS },
  });
  expect(complete.status).toBe(201);
  const task = ((await complete.json()) as { task: ApiTask }).task;
  return { upload, task };
}

async function pollTaskUntil(
  app: Hono,
  projectId: string,
  taskId: string,
  predicate: (t: ApiTask) => boolean,
  timeoutMs = 60_000,
): Promise<ApiTask> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await app.request(`/api/projects/${projectId}/tasks/${taskId}`, {
      headers: DEV_HEADERS,
    });
    if (res.ok) {
      const t = ((await res.json()) as { task: ApiTask }).task;
      if (predicate(t)) return t;
    }
    await Bun.sleep(50);
  }
  throw new Error("pollTaskUntil timeout");
}

describe("chunked upload + media validation task", () => {
  it("audio: 複数チャンクで送って task が succeeded で Audio 行が生える", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "chunk-audio");
    const bytes = new Uint8Array(await Bun.file(getMedia().audioMp3).arrayBuffer());
    // 1KB 単位で意図的に細かく刻む
    const { upload, task } = await uploadChunked(
      app,
      pid,
      "audio",
      "tone.mp3",
      bytes,
      1024,
      "audio/mpeg",
    );
    expect(upload.totalChunks).toBeGreaterThan(1);
    expect(task.status === "pending" || task.status === "running").toBe(true);
    const finished = await pollTaskUntil(
      app,
      pid,
      task.id,
      (t) => t.status === "succeeded",
      90_000,
    );
    expect(finished.status).toBe("succeeded");
    expect(finished.audioId).toBeTruthy();

    const detailRes = await app.request(`/api/projects/${pid}`, { headers: DEV_HEADERS });
    const detail = ((await detailRes.json()) as { project: ApiProjectDetail }).project;
    expect(detail.audios).toHaveLength(1);
    expect(detail.audios[0]!.name).toBe("tone.mp3");

    // status 更新と prefix cleanup の間に微小窓があるので inflight の完了を待つ
    await waitForInflightTasks();
    const after = await getS3().list({ prefix: uploadPrefix(pid, upload.id) });
    expect(after.contents ?? []).toHaveLength(0);
  }, 120_000);

  it("video: 単一チャンクでも upload → task succeeded で Video 行が生える", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "chunk-video");
    const bytes = new Uint8Array(await Bun.file(getMedia().videoMp4).arrayBuffer());
    const { task } = await uploadChunked(
      app,
      pid,
      "video",
      "clip.mp4",
      bytes,
      bytes.byteLength,
      "video/mp4",
    );
    const finished = await pollTaskUntil(
      app,
      pid,
      task.id,
      (t) => t.status === "succeeded" || t.status === "failed",
      180_000,
    );
    expect(finished.status).toBe("succeeded");
    expect(finished.videoId).toBeTruthy();
  }, 240_000);

  it("invalid media は task が failed になりエラー文言が乗る", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "chunk-bad");
    const bytes = new TextEncoder().encode("not media");
    const { task } = await uploadChunked(
      app,
      pid,
      "audio",
      "garbage.bin",
      bytes,
      Math.max(bytes.byteLength, 1024),
      "application/octet-stream",
    );
    const finished = await pollTaskUntil(
      app,
      pid,
      task.id,
      (t) => t.status === "succeeded" || t.status === "failed",
      60_000,
    );
    expect(finished.status).toBe("failed");
    expect(finished.error ?? "").toContain("could not parse uploaded file");
  }, 90_000);

  it("complete 前に全 chunk が揃っていなければ 400", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "chunk-missing");
    const create = await app.request(`/api/projects/${pid}/uploads`, {
      method: "POST",
      headers: { ...DEV_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "audio",
        fileName: "x.bin",
        totalBytes: 100,
        chunkSize: 64 * 1024,
      }),
    });
    const upload = ((await create.json()) as { upload: ApiUpload }).upload;
    const complete = await app.request(`/api/projects/${pid}/uploads/${upload.id}/complete`, {
      method: "POST",
      headers: DEV_HEADERS,
    });
    expect(complete.status).toBe(400);
  });

  it("Upload 作成時に 1h grace の DeletionMark を立てる", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "chunk-gc");
    const before = Date.now();
    const create = await app.request(`/api/projects/${pid}/uploads`, {
      method: "POST",
      headers: { ...DEV_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "audio",
        fileName: "x.bin",
        totalBytes: 1,
        chunkSize: 64 * 1024,
      }),
    });
    const upload = ((await create.json()) as { upload: ApiUpload }).upload;
    const prefix = uploadPrefix(pid, upload.id);
    const mark = await prisma.deletionMark.findFirst({ where: { prefix } });
    expect(mark).not.toBeNull();
    const delta = mark!.nextRetryAt.getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(UPLOAD_EXPIRY_MS - 1000);
    expect(delta).toBeLessThanOrEqual(UPLOAD_EXPIRY_MS + 5000);
  });

  it("DELETE /uploads/:uploadId で chunks が即時 cleanup される", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "chunk-abort");
    const create = await app.request(`/api/projects/${pid}/uploads`, {
      method: "POST",
      headers: { ...DEV_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "audio",
        fileName: "x.bin",
        totalBytes: 4,
        chunkSize: 64 * 1024,
      }),
    });
    const upload = ((await create.json()) as { upload: ApiUpload }).upload;
    await app.request(`/api/projects/${pid}/uploads/${upload.id}/chunks/0`, {
      method: "PUT",
      headers: { ...DEV_HEADERS, "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(await getS3().exists(uploadChunkKey(pid, upload.id, 0))).toBe(true);
    const del = await app.request(`/api/projects/${pid}/uploads/${upload.id}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(del.status).toBe(204);
    expect(await getS3().exists(uploadChunkKey(pid, upload.id, 0))).toBe(false);
  });

  it("waitForInflightTasks は task 完了後に解決する", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "chunk-wait");
    const bytes = new Uint8Array(await Bun.file(getMedia().audioMp3).arrayBuffer());
    await uploadChunked(app, pid, "audio", "tone.mp3", bytes, 1024, "audio/mpeg");
    await waitForInflightTasks();
    const tasks = await prisma.task.findMany({ where: { projectId: pid } });
    expect(tasks.every((t) => t.status === "succeeded" || t.status === "failed")).toBe(true);
  }, 120_000);
});
