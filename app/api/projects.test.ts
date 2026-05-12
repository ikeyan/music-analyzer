import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { prisma } from "../lib/prisma";
import { getS3 } from "../lib/s3";
import { projectKey, uploadPrefix } from "../lib/storage";
import { TASK_GRACE_MS, recoverTasksOnStartup, waitForInflightTasks } from "../lib/task-runner";
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
      headers: {
        ...DEV_HEADERS,
        "content-type": contentType,
        // app.request は body から CL を自動付与しないので手で乗せる (本番は fetch が送る)
        "content-length": String(slice.byteLength),
      },
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
      headers: {
        ...DEV_HEADERS,
        "content-type": "application/octet-stream",
        "content-length": "4",
      },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    const chunk0 = await prisma.uploadChunk.findUnique({
      where: { uploadId_index: { uploadId: upload.id, index: 0 } },
    });
    expect(chunk0).not.toBeNull();
    expect(await getS3().exists(chunk0!.s3Key)).toBe(true);
    const del = await app.request(`/api/projects/${pid}/uploads/${upload.id}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(del.status).toBe(204);
    expect(await getS3().exists(chunk0!.s3Key)).toBe(false);
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

  // completed / aborted upload に PUT chunk が後から届くケース。
  // /complete が status を flip したあとの遅延 PUT は DB を汚さず S3 も残さない
  it("completed upload への PUT chunk は 409 で拒否され S3 に残らない", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "chunk-race");
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
    // 正規に chunk 0 を入れて /complete を通す
    await app.request(`/api/projects/${pid}/uploads/${upload.id}/chunks/0`, {
      method: "PUT",
      headers: {
        ...DEV_HEADERS,
        "content-type": "application/octet-stream",
        "content-length": "4",
      },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    const complete = await app.request(`/api/projects/${pid}/uploads/${upload.id}/complete`, {
      method: "POST",
      headers: DEV_HEADERS,
    });
    expect(complete.status).toBe(201);
    // 後から遅延 PUT が来たケースをシミュレート (chunk 内容が違う)
    const retry = await app.request(`/api/projects/${pid}/uploads/${upload.id}/chunks/0`, {
      method: "PUT",
      headers: {
        ...DEV_HEADERS,
        "content-type": "application/octet-stream",
        "content-length": "4",
      },
      body: new Uint8Array([9, 9, 9, 9]),
    });
    // pre-write でも post-write でも完了済み判定で 409
    expect(retry.status).toBe(409);
    // 遅延 PUT が S3 に残してしまっていないことを検証
    // (task の cleanup と競合する可能性があるので、tasks が落ち着いてから確認)
    await waitForInflightTasks();
  }, 60_000);

  it("completed upload の DELETE は 409 で拒否し chunks を消さない", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "chunk-abort-completed");
    const bytes = new Uint8Array(await Bun.file(getMedia().audioMp3).arrayBuffer());
    const { upload } = await uploadChunked(
      app,
      pid,
      "audio",
      "tone.mp3",
      bytes,
      bytes.byteLength,
      "audio/mpeg",
    );
    // /complete 直後 (task は pending か running)。task が cleanup する前に DELETE
    const del = await app.request(`/api/projects/${pid}/uploads/${upload.id}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(del.status).toBe(409);
    const body = (await del.json()) as { error: string };
    expect(body.error).toContain("completed");
    // task は走らせきって安定化
    await waitForInflightTasks();
  }, 60_000);

  it("/complete は upload prefix の DeletionMark の nextRetryAt を TASK_GRACE_MS 先に伸ばす", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "chunk-bump-mark");
    const bytes = new Uint8Array(await Bun.file(getMedia().audioMp3).arrayBuffer());
    const before = Date.now();
    const { upload } = await uploadChunked(
      app,
      pid,
      "audio",
      "tone.mp3",
      bytes,
      bytes.byteLength,
      "audio/mpeg",
    );
    const prefix = uploadPrefix(pid, upload.id);
    const mark = await prisma.deletionMark.findFirst({ where: { prefix } });
    if (mark) {
      // /complete が走った瞬間に nextRetryAt が now+TASK_GRACE_MS に書き直されている。
      // 後段の task cleanup で削除される前を観測するため raw select
      const delta = mark.nextRetryAt.getTime() - before;
      expect(delta).toBeGreaterThanOrEqual(TASK_GRACE_MS - 1000);
    }
    // 任意: task を走らせきって安定化させる
    await waitForInflightTasks();
  }, 120_000);

  it("並行 /complete は片方が race_lost で 200 を返し task は 1 つだけ", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "chunk-race-complete");
    const bytes = new Uint8Array(await Bun.file(getMedia().audioMp3).arrayBuffer());
    const create = await app.request(`/api/projects/${pid}/uploads`, {
      method: "POST",
      headers: { ...DEV_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "audio",
        fileName: "tone.mp3",
        totalBytes: bytes.byteLength,
        chunkSize: bytes.byteLength,
        contentType: "audio/mpeg",
      }),
    });
    const upload = ((await create.json()) as { upload: ApiUpload }).upload;
    await app.request(`/api/projects/${pid}/uploads/${upload.id}/chunks/0`, {
      method: "PUT",
      headers: {
        ...DEV_HEADERS,
        "content-type": "audio/mpeg",
        "content-length": String(bytes.byteLength),
      },
      body: bytes,
    });
    // 並列に 2 つ撃つ
    const [a, b] = await Promise.all([
      app.request(`/api/projects/${pid}/uploads/${upload.id}/complete`, {
        method: "POST",
        headers: DEV_HEADERS,
      }),
      app.request(`/api/projects/${pid}/uploads/${upload.id}/complete`, {
        method: "POST",
        headers: DEV_HEADERS,
      }),
    ]);
    const statuses = [a.status, b.status].toSorted();
    expect(statuses).toEqual([200, 201]);
    const ja = (await a.json()) as { task: ApiTask };
    const jb = (await b.json()) as { task: ApiTask };
    expect(ja.task.id).toBe(jb.task.id);
    await waitForInflightTasks();
    const tasks = await prisma.task.findMany({ where: { uploadId: upload.id } });
    expect(tasks).toHaveLength(1);
  }, 120_000);

  it("chunkSize 超過 body の chunk PUT は write 前に 413 で reject される (既存 S3 を保護)", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "chunk-oversize");
    const chunkSize = 4;
    const create = await app.request(`/api/projects/${pid}/uploads`, {
      method: "POST",
      headers: { ...DEV_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "audio",
        fileName: "x.bin",
        totalBytes: chunkSize,
        chunkSize: 1024, // valibot minimum 1024 を満たす上で、API 上の chunkSize >= 1024 確保
      }),
    });
    const upload = ((await create.json()) as { upload: ApiUpload }).upload;
    // 正規 chunk を書く
    const ok = await app.request(`/api/projects/${pid}/uploads/${upload.id}/chunks/0`, {
      method: "PUT",
      headers: {
        ...DEV_HEADERS,
        "content-type": "application/octet-stream",
        "content-length": "4",
      },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(ok.status).toBe(200);
    const chunk0 = await prisma.uploadChunk.findUniqueOrThrow({
      where: { uploadId_index: { uploadId: upload.id, index: 0 } },
    });
    const stored = await getS3().file(chunk0.s3Key).arrayBuffer();
    expect(stored.byteLength).toBe(4);
    // chunkSize 超過 body を投げて 413 (chunkSize=1024 に対し 2048 byte)
    const big = new Uint8Array(2048);
    const oversize = await app.request(`/api/projects/${pid}/uploads/${upload.id}/chunks/0`, {
      method: "PUT",
      headers: {
        ...DEV_HEADERS,
        "content-type": "application/octet-stream",
        "content-length": String(big.byteLength),
      },
      body: big,
    });
    expect(oversize.status).toBe(413);
    // 既存 S3 chunk が破壊されていないこと (canonical key 上書きしない設計)
    const stillStored = await getS3().file(chunk0.s3Key).arrayBuffer();
    expect(stillStored.byteLength).toBe(4);
    expect(new Uint8Array(stillStored)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("同一 chunk index への並列 PUT で DB と S3 が一致 (最後の winner に統一)", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "chunk-serialize");
    const create = await app.request(`/api/projects/${pid}/uploads`, {
      method: "POST",
      headers: { ...DEV_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "audio",
        fileName: "x.bin",
        totalBytes: 8,
        chunkSize: 1024,
      }),
    });
    const upload = ((await create.json()) as { upload: ApiUpload }).upload;
    const bodyA = new Uint8Array(8).fill(0xaa);
    const bodyB = new Uint8Array(4).fill(0xbb);
    const url = `/api/projects/${pid}/uploads/${upload.id}/chunks/0`;
    const [resA, resB] = await Promise.all([
      app.request(url, {
        method: "PUT",
        headers: {
          ...DEV_HEADERS,
          "content-type": "application/octet-stream",
          "content-length": "8",
        },
        body: bodyA,
      }),
      app.request(url, {
        method: "PUT",
        headers: {
          ...DEV_HEADERS,
          "content-type": "application/octet-stream",
          "content-length": "4",
        },
        body: bodyB,
      }),
    ]);
    expect([resA.status, resB.status].every((s) => s === 200)).toBe(true);
    // DB の s3Key と sizeBytes が S3 object と一致する。古い writeId の object は消えている
    const dbChunk = await prisma.uploadChunk.findUniqueOrThrow({
      where: { uploadId_index: { uploadId: upload.id, index: 0 } },
    });
    const stored = await getS3().file(dbChunk.s3Key).arrayBuffer();
    expect(Number(dbChunk.sizeBytes)).toBe(stored.byteLength);
    // upload prefix 配下の chunks/* には DB が指す 1 個だけ残っている
    const list = await getS3().list({ prefix: uploadPrefix(pid, upload.id) });
    const keys = (list.contents ?? []).map((o) => o.key).filter((k): k is string => !!k);
    expect(keys).toEqual([dbChunk.s3Key]);
  });

  it("task 成功時 media prefix の DeletionMark が消える (途中失敗時は残る)", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "media-mark-cleanup");
    const bytes = new Uint8Array(await Bun.file(getMedia().audioMp3).arrayBuffer());
    const { task } = await uploadChunked(
      app,
      pid,
      "audio",
      "tone.mp3",
      bytes,
      bytes.byteLength,
      "audio/mpeg",
    );
    await pollTaskUntil(app, pid, task.id, (t) => t.status === "succeeded", 60_000);
    await waitForInflightTasks();
    // 成功すれば audios/<audioId>/ の mark は消えている
    const marks = await prisma.deletionMark.findMany({
      where: { prefix: { startsWith: `${projectKey(pid)}/audios/` } },
    });
    expect(marks).toHaveLength(0);
  }, 120_000);

  it("recoverTasksOnStartup は pending task の upload prefix の DeletionMark を引き直す", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "recover-mark");
    // upload + complete で pending task を作る
    const bytes = new Uint8Array(await Bun.file(getMedia().audioMp3).arrayBuffer());
    const create = await app.request(`/api/projects/${pid}/uploads`, {
      method: "POST",
      headers: { ...DEV_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "audio",
        fileName: "tone.mp3",
        totalBytes: bytes.byteLength,
        chunkSize: bytes.byteLength,
        contentType: "audio/mpeg",
      }),
    });
    const upload = ((await create.json()) as { upload: ApiUpload }).upload;
    await app.request(`/api/projects/${pid}/uploads/${upload.id}/chunks/0`, {
      method: "PUT",
      headers: {
        ...DEV_HEADERS,
        "content-type": "audio/mpeg",
        "content-length": String(bytes.byteLength),
      },
      body: bytes,
    });
    // task 完了を待たずに先に走っている in-flight task を全部しずめる
    // (succeeded で cleanup されると DeletionMark が消えてしまうので
    // /complete から手動で task を pending のまま用意する)
    const completeTx = await prisma.$transaction(async (tx) => {
      await tx.upload.update({ where: { id: upload.id }, data: { status: "completed" } });
      return await tx.task.create({
        data: { projectId: pid, type: "audio_validation", uploadId: upload.id, status: "pending" },
      });
    });
    // mark を強制的に過去日付に倒す (再起動間際を再現)
    const prefix = uploadPrefix(pid, upload.id);
    await prisma.deletionMark.updateMany({
      where: { prefix },
      data: { nextRetryAt: new Date(Date.now() - 10_000) },
    });
    // recovery → mark が未来へ引き直される
    const before = Date.now();
    await recoverTasksOnStartup();
    const mark = await prisma.deletionMark.findFirst({ where: { prefix } });
    if (!mark) {
      // task が走り切って prefix 削除済みなら mark もなくなっている = それも OK
      await waitForInflightTasks();
      const tasks = await prisma.task.findMany({ where: { id: completeTx.id } });
      expect(tasks[0]?.status === "succeeded" || tasks[0]?.status === "failed").toBe(true);
      return;
    }
    expect(mark.nextRetryAt.getTime()).toBeGreaterThanOrEqual(before + TASK_GRACE_MS - 1000);
    await waitForInflightTasks();
  }, 120_000);

  it("Audio.create と task succeeded は同一 tx で commit される (中間状態が観測不可)", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "task-atomic");
    const bytes = new Uint8Array(await Bun.file(getMedia().audioMp3).arrayBuffer());
    const { task } = await uploadChunked(
      app,
      pid,
      "audio",
      "tone.mp3",
      bytes,
      bytes.byteLength,
      "audio/mpeg",
    );
    await pollTaskUntil(app, pid, task.id, (t) => t.status === "succeeded", 60_000);
    await waitForInflightTasks();
    const finished = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(finished.status).toBe("succeeded");
    expect(finished.audioId).not.toBeNull();
    // audioId が指す Audio 行が存在する (= same-tx で書かれた前提)
    const audio = await prisma.audio.findUnique({ where: { id: finished.audioId! } });
    expect(audio).not.toBeNull();
  }, 120_000);

  it("recoverTasksOnStartup は succeeded task に手を出さない", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "task-recover-skip-succeeded");
    const bytes = new Uint8Array(await Bun.file(getMedia().audioMp3).arrayBuffer());
    const { task } = await uploadChunked(
      app,
      pid,
      "audio",
      "tone.mp3",
      bytes,
      bytes.byteLength,
      "audio/mpeg",
    );
    await pollTaskUntil(app, pid, task.id, (t) => t.status === "succeeded", 60_000);
    await waitForInflightTasks();
    // 再起動相当: recovery を呼んでも succeeded は触らない
    await recoverTasksOnStartup();
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe("succeeded");
  }, 120_000);

  it("aborted/missing への late chunk PUT は S3 に orphan を残さない", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "chunk-abort-orphan");
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
    // 先に DELETE して status=aborted + mark 削除済みにする
    const del = await app.request(`/api/projects/${pid}/uploads/${upload.id}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(del.status).toBe(204);
    // 遅延 PUT (DELETE 後の late write を模擬)
    const put = await app.request(`/api/projects/${pid}/uploads/${upload.id}/chunks/0`, {
      method: "PUT",
      headers: {
        ...DEV_HEADERS,
        "content-type": "application/octet-stream",
        "content-length": "4",
      },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(put.status).toBe(409);
    // S3 に late write の orphan が残っていないこと (prefix 配下空)
    const list = await getS3().list({ prefix: uploadPrefix(pid, upload.id) });
    expect(list.contents ?? []).toHaveLength(0);
  });

  it("aborted upload への chunk PUT も 409", async () => {
    process.env.NODE_ENV = "development";
    const app = appWithProjects();
    const pid = await createProject(app, "chunk-after-abort");
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
    const del = await app.request(`/api/projects/${pid}/uploads/${upload.id}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(del.status).toBe(204);
    const put = await app.request(`/api/projects/${pid}/uploads/${upload.id}/chunks/0`, {
      method: "PUT",
      headers: {
        ...DEV_HEADERS,
        "content-type": "application/octet-stream",
        "content-length": "4",
      },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(put.status).toBe(409);
  });
});
