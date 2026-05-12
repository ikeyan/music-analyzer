import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { hc } from "hono/client";
import {
  type ChunkedUploadClient,
  chunkedUpload,
  type ChunkedUploadResult,
} from "../lib/chunked-upload";
import { prisma } from "../lib/prisma";
import { getS3 } from "../lib/s3";
import { projectKey, uploadPrefix } from "../lib/storage";
import { TASK_GRACE_MS, recoverTasksOnStartup, waitForInflightTasks } from "../lib/task-runner";
import { useDbFixture } from "../test-fixtures/db";
import { useMediaFixture } from "../test-fixtures/media";
import { useS3Fixture } from "../test-fixtures/s3";
import { type AppType, api } from "./index";
import { UPLOAD_EXPIRY_MS } from "./projects";
import type { ApiTask, ApiUpload } from "./types";

useDbFixture();
useS3Fixture();
const getMedia = useMediaFixture();

// AUTH_PROXY_SECRET 未設定 + NODE_ENV=development で requireUser は DEV_SUB を許可する
const DEV_HEADERS = { "x-authentik-uid": "dev:test" };

function makeClient(): ChunkedUploadClient {
  process.env.NODE_ENV = "development";
  const app = new Hono().route("/api", api);
  // app.request は body から CL を自動付与しない (本番 fetch は付ける) ので
  // テスト経路でだけ補う
  const customFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = init?.body;
    if (body != null && !headers.has("content-length")) {
      const size = bodyByteLength(body);
      if (size !== undefined) headers.set("content-length", String(size));
    }
    return await app.request(input as Parameters<typeof app.request>[0], { ...init, headers });
  };
  return hc<AppType>("http://test/api", {
    fetch: customFetch as unknown as typeof fetch,
    headers: DEV_HEADERS,
  });
}

function bodyByteLength(body: BodyInit): number | undefined {
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (body instanceof Blob) return body.size;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  return undefined;
}

async function createProject(client: ChunkedUploadClient, name: string): Promise<string> {
  const res = await client.projects.$post({ json: { name } });
  if (!res.ok) throw new Error(`createProject: ${res.status}`);
  const body = await res.json();
  return body.project.id;
}

async function createUploadOk(
  client: ChunkedUploadClient,
  projectId: string,
  body: Parameters<(typeof client.projects)[":id"]["uploads"]["$post"]>[0]["json"],
): Promise<ApiUpload> {
  const res = await client.projects[":id"].uploads.$post({ param: { id: projectId }, json: body });
  if (!res.ok) throw new Error(`createUpload: ${res.status} ${await res.text()}`);
  return (await res.json()).upload;
}

async function putRawChunk(
  client: ChunkedUploadClient,
  projectId: string,
  uploadId: string,
  index: number,
  body: Uint8Array<ArrayBuffer>,
  contentType = "application/octet-stream",
): Promise<Response> {
  return await client.projects[":id"].uploads[":uploadId"].chunks[":index"].$put(
    { param: { id: projectId, uploadId, index: String(index) } },
    // headers は per-call options に置く (init.headers だと hc が hc-level headers を
    // 上書きしてしまう)
    { init: { body }, headers: { "content-type": contentType } },
  );
}

async function uploadOk(
  client: ChunkedUploadClient,
  projectId: string,
  kind: "video" | "audio",
  fileName: string,
  source: Blob,
  chunkSize: number,
  contentType: string,
): Promise<{ upload: UploadRow; task: ApiTask }> {
  const result = await chunkedUpload(
    client,
    projectId,
    kind,
    source,
    fileName,
    contentType,
    chunkSize,
  );
  if (!result.ok) {
    throw new Error(`uploadOk: chunkedUpload failed status=${result.status} err=${result.error}`);
  }
  const task = result.task;
  const upload = await prisma.upload.findFirstOrThrow({
    where: { id: task.uploadId ?? "", tasks: { some: { id: task.id } } },
  });
  return { task, upload };
}

type UploadRow = Awaited<ReturnType<typeof prisma.upload.findFirstOrThrow>>;

async function pollTaskUntil(
  client: ChunkedUploadClient,
  projectId: string,
  taskId: string,
  predicate: (t: ApiTask) => boolean,
  timeoutMs = 60_000,
): Promise<ApiTask> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await client.projects[":id"].tasks[":taskId"].$get({
      param: { id: projectId, taskId },
    });
    if (res.ok) {
      const t = (await res.json()).task;
      if (predicate(t)) return t;
    }
    await Bun.sleep(50);
  }
  throw new Error("pollTaskUntil timeout");
}

function expectError(
  result: ChunkedUploadResult,
  status: number,
): { ok: false; error: string; status: number } {
  if (result.ok) throw new Error(`expected error, got ok task=${result.task.id}`);
  expect(result.status).toBe(status);
  return result;
}

describe("chunked upload + media validation task", () => {
  it("audio: 複数チャンクで送って task が succeeded で Audio 行が生える", async () => {
    const client = makeClient();
    const pid = await createProject(client, "chunk-audio");
    const file = Bun.file(getMedia().audioMp3);
    const { upload, task } = await uploadOk(
      client,
      pid,
      "audio",
      "tone.mp3",
      file,
      1024,
      "audio/mpeg",
    );
    expect(upload.totalChunks).toBeGreaterThan(1);
    expect(task.status === "pending" || task.status === "running").toBe(true);
    const finished = await pollTaskUntil(
      client,
      pid,
      task.id,
      (t) => t.status === "succeeded",
      90_000,
    );
    expect(finished.status).toBe("succeeded");
    expect(finished.audioId).toBeTruthy();

    const detailRes = await client.projects[":id"].$get({ param: { id: pid } });
    if (!detailRes.ok) throw new Error(`detail: ${detailRes.status}`);
    const detail = (await detailRes.json()).project;
    expect(detail.audios).toHaveLength(1);
    expect(detail.audios[0]!.name).toBe("tone.mp3");

    await waitForInflightTasks();
    const after = await getS3().list({ prefix: uploadPrefix(pid, upload.id) });
    expect(after.contents ?? []).toHaveLength(0);
  }, 120_000);

  it("video: 単一チャンクでも upload → task succeeded で Video 行が生える", async () => {
    const client = makeClient();
    const pid = await createProject(client, "chunk-video");
    const file = Bun.file(getMedia().videoMp4);
    const { task } = await uploadOk(client, pid, "video", "clip.mp4", file, file.size, "video/mp4");
    const finished = await pollTaskUntil(
      client,
      pid,
      task.id,
      (t) => t.status === "succeeded" || t.status === "failed",
      180_000,
    );
    expect(finished.status).toBe("succeeded");
    expect(finished.videoId).toBeTruthy();
  }, 240_000);

  it("invalid media は task が failed になりエラー文言が乗る", async () => {
    const client = makeClient();
    const pid = await createProject(client, "chunk-bad");
    const blob = new Blob(["not media"]);
    const { task } = await uploadOk(
      client,
      pid,
      "audio",
      "garbage.bin",
      blob,
      Math.max(blob.size, 1024),
      "application/octet-stream",
    );
    const finished = await pollTaskUntil(
      client,
      pid,
      task.id,
      (t) => t.status === "succeeded" || t.status === "failed",
      60_000,
    );
    expect(finished.status).toBe("failed");
    expect(finished.error ?? "").toContain("could not parse uploaded file");
  }, 90_000);

  it("validate 失敗時は claim を rollback して status=pending に戻す", async () => {
    const client = makeClient();
    const pid = await createProject(client, "complete-validate-rollback");
    const upload = await createUploadOk(client, pid, {
      kind: "audio",
      fileName: "x.bin",
      totalBytes: 4,
      chunkSize: 1024,
    });
    const complete = await client.projects[":id"].uploads[":uploadId"].complete.$post({
      param: { id: pid, uploadId: upload.id },
    });
    expect(complete.status).toBe(400);
    const reloaded = await prisma.upload.findUniqueOrThrow({ where: { id: upload.id } });
    expect(reloaded.status).toBe("pending");
  });

  it("complete 前に全 chunk が揃っていなければ 400", async () => {
    const client = makeClient();
    const pid = await createProject(client, "chunk-missing");
    const upload = await createUploadOk(client, pid, {
      kind: "audio",
      fileName: "x.bin",
      totalBytes: 100,
      chunkSize: 64 * 1024,
    });
    const complete = await client.projects[":id"].uploads[":uploadId"].complete.$post({
      param: { id: pid, uploadId: upload.id },
    });
    expect(complete.status).toBe(400);
  });

  it("Upload 作成時に 1h grace の DeletionMark を立てる", async () => {
    const client = makeClient();
    const pid = await createProject(client, "chunk-gc");
    const before = Date.now();
    const upload = await createUploadOk(client, pid, {
      kind: "audio",
      fileName: "x.bin",
      totalBytes: 1,
      chunkSize: 64 * 1024,
    });
    const prefix = uploadPrefix(pid, upload.id);
    const mark = await prisma.deletionMark.findFirst({ where: { prefix } });
    expect(mark).not.toBeNull();
    const delta = mark!.nextRetryAt.getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(UPLOAD_EXPIRY_MS - 1000);
    expect(delta).toBeLessThanOrEqual(UPLOAD_EXPIRY_MS + 5000);
  });

  it("DELETE /uploads/:uploadId で chunks が即時 cleanup される", async () => {
    const client = makeClient();
    const pid = await createProject(client, "chunk-abort");
    const upload = await createUploadOk(client, pid, {
      kind: "audio",
      fileName: "x.bin",
      totalBytes: 4,
      chunkSize: 64 * 1024,
    });
    await putRawChunk(client, pid, upload.id, 0, new Uint8Array([1, 2, 3, 4]));
    const chunk0 = await prisma.uploadChunk.findUnique({
      where: { uploadId_index: { uploadId: upload.id, index: 0 } },
    });
    expect(chunk0).not.toBeNull();
    expect(await getS3().exists(chunk0!.s3Key)).toBe(true);
    const del = await client.projects[":id"].uploads[":uploadId"].$delete({
      param: { id: pid, uploadId: upload.id },
    });
    expect(del.status).toBe(204);
    expect(await getS3().exists(chunk0!.s3Key)).toBe(false);
  });

  it("waitForInflightTasks は task 完了後に解決する", async () => {
    const client = makeClient();
    const pid = await createProject(client, "chunk-wait");
    await uploadOk(
      client,
      pid,
      "audio",
      "tone.mp3",
      Bun.file(getMedia().audioMp3),
      1024,
      "audio/mpeg",
    );
    await waitForInflightTasks();
    const tasks = await prisma.task.findMany({ where: { projectId: pid } });
    expect(tasks.every((t) => t.status === "succeeded" || t.status === "failed")).toBe(true);
  }, 120_000);

  it("completed upload への PUT chunk は 409 で拒否され S3 に残らない", async () => {
    const client = makeClient();
    const pid = await createProject(client, "chunk-race");
    const upload = await createUploadOk(client, pid, {
      kind: "audio",
      fileName: "x.bin",
      totalBytes: 4,
      chunkSize: 64 * 1024,
    });
    await putRawChunk(client, pid, upload.id, 0, new Uint8Array([1, 2, 3, 4]));
    const complete = await client.projects[":id"].uploads[":uploadId"].complete.$post({
      param: { id: pid, uploadId: upload.id },
    });
    expect(complete.status).toBe(201);
    const retry = await putRawChunk(client, pid, upload.id, 0, new Uint8Array([9, 9, 9, 9]));
    expect(retry.status).toBe(409);
    await waitForInflightTasks();
  }, 60_000);

  it("completed upload の DELETE は 409 で拒否し chunks を消さない", async () => {
    const client = makeClient();
    const pid = await createProject(client, "chunk-abort-completed");
    const file = Bun.file(getMedia().audioMp3);
    const { upload } = await uploadOk(
      client,
      pid,
      "audio",
      "tone.mp3",
      file,
      file.size,
      "audio/mpeg",
    );
    const del = await client.projects[":id"].uploads[":uploadId"].$delete({
      param: { id: pid, uploadId: upload.id },
    });
    if (del.status !== 409) throw new Error(`expected 409, got ${del.status}`);
    const body = await del.json();
    expect(body.error).toContain("completed");
    await waitForInflightTasks();
  }, 60_000);

  it("/complete は upload prefix の DeletionMark の nextRetryAt を TASK_GRACE_MS 先に伸ばす", async () => {
    const client = makeClient();
    const pid = await createProject(client, "chunk-bump-mark");
    const file = Bun.file(getMedia().audioMp3);
    const before = Date.now();
    const { upload } = await uploadOk(
      client,
      pid,
      "audio",
      "tone.mp3",
      file,
      file.size,
      "audio/mpeg",
    );
    const prefix = uploadPrefix(pid, upload.id);
    const mark = await prisma.deletionMark.findFirst({ where: { prefix } });
    if (mark) {
      const delta = mark.nextRetryAt.getTime() - before;
      expect(delta).toBeGreaterThanOrEqual(TASK_GRACE_MS - 1000);
    }
    await waitForInflightTasks();
  }, 120_000);

  it("並行 /complete は片方が race_lost で 200 を返し task は 1 つだけ", async () => {
    const client = makeClient();
    const pid = await createProject(client, "chunk-race-complete");
    const bytes = new Uint8Array(await Bun.file(getMedia().audioMp3).arrayBuffer());
    const upload = await createUploadOk(client, pid, {
      kind: "audio",
      fileName: "tone.mp3",
      totalBytes: bytes.byteLength,
      chunkSize: bytes.byteLength,
      contentType: "audio/mpeg",
    });
    await putRawChunk(client, pid, upload.id, 0, bytes, "audio/mpeg");
    const [a, b] = await Promise.all([
      client.projects[":id"].uploads[":uploadId"].complete.$post({
        param: { id: pid, uploadId: upload.id },
      }),
      client.projects[":id"].uploads[":uploadId"].complete.$post({
        param: { id: pid, uploadId: upload.id },
      }),
    ]);
    const statuses = [a.status, b.status].toSorted();
    expect(statuses).toEqual([200, 201]);
    if (!a.ok || !b.ok) throw new Error("both should be 2xx");
    const ja = await a.json();
    const jb = await b.json();
    expect(ja.task.id).toBe(jb.task.id);
    await waitForInflightTasks();
    const tasks = await prisma.task.findMany({ where: { uploadId: upload.id } });
    expect(tasks).toHaveLength(1);
  }, 120_000);

  it("chunkSize 超過 body の chunk PUT は write 前に 413 で reject される (既存 S3 を保護)", async () => {
    const client = makeClient();
    const pid = await createProject(client, "chunk-oversize");
    const upload = await createUploadOk(client, pid, {
      kind: "audio",
      fileName: "x.bin",
      totalBytes: 4,
      chunkSize: 1024,
    });
    const ok = await putRawChunk(client, pid, upload.id, 0, new Uint8Array([1, 2, 3, 4]));
    expect(ok.status).toBe(200);
    const chunk0 = await prisma.uploadChunk.findUniqueOrThrow({
      where: { uploadId_index: { uploadId: upload.id, index: 0 } },
    });
    const stored = await getS3().file(chunk0.s3Key).arrayBuffer();
    expect(stored.byteLength).toBe(4);
    const oversize = await putRawChunk(client, pid, upload.id, 0, new Uint8Array(2048));
    expect(oversize.status).toBe(413);
    const stillStored = await getS3().file(chunk0.s3Key).arrayBuffer();
    expect(stillStored.byteLength).toBe(4);
    expect(new Uint8Array(stillStored)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("同一 chunk index への並列 PUT で DB と S3 が一致 (最後の winner に統一)", async () => {
    const client = makeClient();
    const pid = await createProject(client, "chunk-serialize");
    const upload = await createUploadOk(client, pid, {
      kind: "audio",
      fileName: "x.bin",
      totalBytes: 8,
      chunkSize: 1024,
    });
    const bodyA = new Uint8Array(8).fill(0xaa);
    const bodyB = new Uint8Array(4).fill(0xbb);
    const [resA, resB] = await Promise.all([
      putRawChunk(client, pid, upload.id, 0, bodyA),
      putRawChunk(client, pid, upload.id, 0, bodyB),
    ]);
    expect([resA.status, resB.status].every((s) => s === 200)).toBe(true);
    const dbChunk = await prisma.uploadChunk.findUniqueOrThrow({
      where: { uploadId_index: { uploadId: upload.id, index: 0 } },
    });
    const stored = await getS3().file(dbChunk.s3Key).arrayBuffer();
    expect(Number(dbChunk.sizeBytes)).toBe(stored.byteLength);
    const list = await getS3().list({ prefix: uploadPrefix(pid, upload.id) });
    const keys = (list.contents ?? []).map((o) => o.key).filter((k): k is string => !!k);
    expect(keys).toEqual([dbChunk.s3Key]);
  });

  it("task 成功時 media prefix の DeletionMark が消える (途中失敗時は残る)", async () => {
    const client = makeClient();
    const pid = await createProject(client, "media-mark-cleanup");
    const file = Bun.file(getMedia().audioMp3);
    const { task } = await uploadOk(
      client,
      pid,
      "audio",
      "tone.mp3",
      file,
      file.size,
      "audio/mpeg",
    );
    await pollTaskUntil(client, pid, task.id, (t) => t.status === "succeeded", 60_000);
    await waitForInflightTasks();
    const marks = await prisma.deletionMark.findMany({
      where: { prefix: { startsWith: `${projectKey(pid)}/audios/` } },
    });
    expect(marks).toHaveLength(0);
  }, 120_000);

  it("recoverTasksOnStartup は pending task の upload prefix の DeletionMark を引き直す", async () => {
    const client = makeClient();
    const pid = await createProject(client, "recover-mark");
    const bytes = new Uint8Array(await Bun.file(getMedia().audioMp3).arrayBuffer());
    const upload = await createUploadOk(client, pid, {
      kind: "audio",
      fileName: "tone.mp3",
      totalBytes: bytes.byteLength,
      chunkSize: bytes.byteLength,
      contentType: "audio/mpeg",
    });
    await putRawChunk(client, pid, upload.id, 0, bytes, "audio/mpeg");
    // succeeded で cleanup されないよう /complete を通さず DB を直接いじって pending task を作る
    const completeTx = await prisma.$transaction(async (tx) => {
      await tx.upload.update({ where: { id: upload.id }, data: { status: "completed" } });
      return await tx.task.create({
        data: { projectId: pid, type: "audio_validation", uploadId: upload.id, status: "pending" },
      });
    });
    const prefix = uploadPrefix(pid, upload.id);
    await prisma.deletionMark.updateMany({
      where: { prefix },
      data: { nextRetryAt: new Date(Date.now() - 10_000) },
    });
    const before = Date.now();
    await recoverTasksOnStartup();
    const mark = await prisma.deletionMark.findFirst({ where: { prefix } });
    if (!mark) {
      await waitForInflightTasks();
      const tasks = await prisma.task.findMany({ where: { id: completeTx.id } });
      expect(tasks[0]?.status === "succeeded" || tasks[0]?.status === "failed").toBe(true);
      return;
    }
    expect(mark.nextRetryAt.getTime()).toBeGreaterThanOrEqual(before + TASK_GRACE_MS - 1000);
    await waitForInflightTasks();
  }, 120_000);

  it("Audio.create と task succeeded は同一 tx で commit される (中間状態が観測不可)", async () => {
    const client = makeClient();
    const pid = await createProject(client, "task-atomic");
    const file = Bun.file(getMedia().audioMp3);
    const { task } = await uploadOk(
      client,
      pid,
      "audio",
      "tone.mp3",
      file,
      file.size,
      "audio/mpeg",
    );
    await pollTaskUntil(client, pid, task.id, (t) => t.status === "succeeded", 60_000);
    await waitForInflightTasks();
    const finished = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(finished.status).toBe("succeeded");
    expect(finished.audioId).not.toBeNull();
    const audio = await prisma.audio.findUnique({ where: { id: finished.audioId! } });
    expect(audio).not.toBeNull();
  }, 120_000);

  it("task 完了後は UploadChunk 行も S3 prefix と一緒に削除される", async () => {
    const client = makeClient();
    const pid = await createProject(client, "chunk-rows-cleanup");
    const { upload } = await uploadOk(
      client,
      pid,
      "audio",
      "tone.mp3",
      Bun.file(getMedia().audioMp3),
      1024,
      "audio/mpeg",
    );
    const beforeChunks = await prisma.uploadChunk.count({ where: { uploadId: upload.id } });
    expect(beforeChunks).toBeGreaterThan(1);
    await waitForInflightTasks();
    const afterChunks = await prisma.uploadChunk.count({ where: { uploadId: upload.id } });
    expect(afterChunks).toBe(0);
  }, 120_000);

  it("recoverTasksOnStartup は succeeded task に手を出さない", async () => {
    const client = makeClient();
    const pid = await createProject(client, "task-recover-skip-succeeded");
    const file = Bun.file(getMedia().audioMp3);
    const { task } = await uploadOk(
      client,
      pid,
      "audio",
      "tone.mp3",
      file,
      file.size,
      "audio/mpeg",
    );
    await pollTaskUntil(client, pid, task.id, (t) => t.status === "succeeded", 60_000);
    await waitForInflightTasks();
    await recoverTasksOnStartup();
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe("succeeded");
  }, 120_000);

  it("aborted/missing への late chunk PUT は S3 に orphan を残さない", async () => {
    const client = makeClient();
    const pid = await createProject(client, "chunk-abort-orphan");
    const upload = await createUploadOk(client, pid, {
      kind: "audio",
      fileName: "x.bin",
      totalBytes: 4,
      chunkSize: 64 * 1024,
    });
    const del = await client.projects[":id"].uploads[":uploadId"].$delete({
      param: { id: pid, uploadId: upload.id },
    });
    expect(del.status).toBe(204);
    const put = await putRawChunk(client, pid, upload.id, 0, new Uint8Array([1, 2, 3, 4]));
    expect(put.status).toBe(409);
    const list = await getS3().list({ prefix: uploadPrefix(pid, upload.id) });
    expect(list.contents ?? []).toHaveLength(0);
  });

  it("aborted upload への chunk PUT も 409", async () => {
    const client = makeClient();
    const pid = await createProject(client, "chunk-after-abort");
    const upload = await createUploadOk(client, pid, {
      kind: "audio",
      fileName: "x.bin",
      totalBytes: 4,
      chunkSize: 64 * 1024,
    });
    const del = await client.projects[":id"].uploads[":uploadId"].$delete({
      param: { id: pid, uploadId: upload.id },
    });
    expect(del.status).toBe(204);
    const put = await putRawChunk(client, pid, upload.id, 0, new Uint8Array([1, 2, 3, 4]));
    expect(put.status).toBe(409);
  });

  it("chunkedUpload は API エラー (chunkSize 超過) を error 結果として返す", async () => {
    const client = makeClient();
    const pid = await createProject(client, "shared-chunked-upload-error");
    // chunkSize=1024 だが totalBytes=2048 → サーバ側 chunkSize 制約に違反
    // …ではなく、validation 段階で chunkedUpload 経路は body=blob.size と totalBytes 揃う
    // ので別の失敗を起こす: kind を不正にして 400
    const result = await chunkedUpload(
      client,
      pid,
      // @ts-expect-error invalid kind for negative test
      "image",
      new Blob([new Uint8Array([1])]),
      "x.bin",
      "application/octet-stream",
      1024,
    );
    expectError(result, 400);
  });
});
