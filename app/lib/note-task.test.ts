import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { hc } from "hono/client";
import { type AppType, api } from "../api";
import { withAutoContentLength } from "../test-fixtures/app-request";
import { useDbFixture } from "../test-fixtures/db";
import { useMediaFixture } from "../test-fixtures/media";
import { useS3Fixture } from "../test-fixtures/s3";
import type { NoteEstimationResult } from "./note-estimation";
import { prisma } from "./prisma";
import { getS3 } from "./s3";
import { audioTranscodedKey, noteEstimationPrefix } from "./storage";
import { waitForInflightTasks } from "./task-runner";

useDbFixture();
useS3Fixture();
const getMedia = useMediaFixture();

const DEV_HEADERS = { "x-authentik-uid": "dev:test" };

function makeClient() {
  process.env.NODE_ENV = "development";
  const app = new Hono().route("/api", api);
  return hc<AppType>("http://test/api", {
    fetch: withAutoContentLength(app),
    headers: DEV_HEADERS,
  });
}

async function seedAudio(client: ReturnType<typeof makeClient>) {
  const projRes = await client.projects.$post({ json: { name: "notes-test" } });
  if (!projRes.ok) throw new Error(`createProject: ${projRes.status}`);
  const projectId = (await projRes.json()).project.id;
  const audioId = crypto.randomUUID();
  const key = audioTranscodedKey(projectId, audioId);
  await getS3().write(key, Bun.file(getMedia().audioWav));
  await prisma.audio.create({
    data: {
      id: audioId,
      projectId,
      order: 0,
      name: "audio.wav",
      audioKey: key,
      durationSec: 1,
      sizeBytes: 0n,
      srcStartSec: 0,
      srcEndSec: 1,
      projStartSec: 0,
      projEndSec: 1,
    },
  });
  return { projectId, audioId };
}

async function listPrefix(prefix: string): Promise<string[]> {
  const result = await getS3().list({ prefix });
  return (result.contents ?? []).flatMap((o) => (o.key ? [o.key] : []));
}

describe("note estimation task", () => {
  it("POST → task 完走 → notes.json 取得 → DELETE で S3 ごと回収", async () => {
    const client = makeClient();
    const { projectId, audioId } = await seedAudio(client);
    const notesApi = client.projects[":id"].audios[":audioId"].notes;

    const created = await notesApi.$post({ param: { id: projectId, audioId } });
    expect(created.status).toBe(201);
    if (!created.ok) throw new Error("unreachable");
    const { noteEstimation, task } = await created.json();
    expect(task.kind).toBe("notes");
    expect(task.type).toBe("note_estimation");
    expect(noteEstimation.status).toBe("pending");

    // pending 中の DELETE は 409、notes.json は 409
    const early = await notesApi[":noteId"].$delete({
      param: { id: projectId, audioId, noteId: noteEstimation.id },
    });
    expect(early.status).toBe(409);

    await waitForInflightTasks();
    const doneTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(doneTask.status).toBe("succeeded");
    const est = await prisma.noteEstimation.findUniqueOrThrow({ where: { id: noteEstimation.id } });
    expect(est.status).toBe("ready");
    expect(await prisma.deletionMark.count()).toBe(0);

    // project detail に埋め込まれる
    const detail = await client.projects[":id"].$get({ param: { id: projectId } });
    if (!detail.ok) throw new Error("detail");
    const audio = (await detail.json()).project.audios[0]!;
    expect(audio.noteEstimations.map((n) => n.id)).toEqual([noteEstimation.id]);
    expect(audio.noteEstimations[0]!.status).toBe("ready");

    const notesRes = await notesApi[":noteId"]["notes.json"].$get({
      param: { id: projectId, audioId, noteId: noteEstimation.id },
    });
    expect(notesRes.status).toBe(200);
    const result = (await notesRes.json()) as NoteEstimationResult;
    expect(result.edo).toBe(41);
    expect(result.frames).toBeGreaterThan(0);
    expect(result.durationSec).toBeCloseTo(1, 1);
    // fixture は 440Hz 正弦波。41edo で最も近い step は A4 = C4 + 31 (441.5Hz)
    expect(result.notes.some((n) => n.step === 164 + 31)).toBe(true);

    const deleted = await notesApi[":noteId"].$delete({
      param: { id: projectId, audioId, noteId: noteEstimation.id },
    });
    expect(deleted.status).toBe(204);
    expect(await prisma.noteEstimation.count()).toBe(0);
    expect(await prisma.task.count()).toBe(0);
    expect(await listPrefix(noteEstimationPrefix(projectId, audioId, noteEstimation.id))).toEqual(
      [],
    );
  }, 60_000);

  it("同じ audio への同時 POST は 1 つだけ受け付け、残りは 409", async () => {
    const client = makeClient();
    const { projectId, audioId } = await seedAudio(client);
    const res = await Promise.all(
      Array.from({ length: 4 }, () =>
        client.projects[":id"].audios[":audioId"].notes.$post({
          param: { id: projectId, audioId },
        }),
      ),
    );
    expect(res.map((r) => r.status).toSorted()).toEqual([201, 409, 409, 409]);
    expect(await prisma.noteEstimation.count()).toBe(1);
    expect(await prisma.task.count()).toBe(1);
    await waitForInflightTasks();
  }, 60_000);

  it("audio 実体が S3 にないと task/noteEstimation が failed になり mark も残らない", async () => {
    const client = makeClient();
    const { projectId, audioId } = await seedAudio(client);
    await getS3().delete(audioTranscodedKey(projectId, audioId));
    const created = await client.projects[":id"].audios[":audioId"].notes.$post({
      param: { id: projectId, audioId },
    });
    expect(created.status).toBe(201);
    if (!created.ok) throw new Error("unreachable");
    const { task } = await created.json();

    await waitForInflightTasks();
    const doneTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(doneTask.status).toBe("failed");
    const est = await prisma.noteEstimation.findUniqueOrThrow({ where: { id: task.id } });
    expect(est.status).toBe("failed");
    expect(await prisma.deletionMark.count()).toBe(0);
  });

  it("audio DELETE で noteEstimation と task も消える", async () => {
    const client = makeClient();
    const { projectId, audioId } = await seedAudio(client);
    const noteId = crypto.randomUUID();
    await prisma.noteEstimation.create({
      data: { id: noteId, audioId, status: "ready", modelVersion: "test" },
    });
    await prisma.task.create({
      data: {
        id: noteId,
        projectId,
        type: "note_estimation",
        fileName: "audio.wav",
        audioId,
        status: "succeeded",
      },
    });
    const res = await client.projects[":id"].audios[":audioId"].$delete({
      param: { id: projectId, audioId },
    });
    expect(res.status).toBe(204);
    expect(await prisma.noteEstimation.count()).toBe(0);
    expect(await prisma.task.count()).toBe(0);
  });
});
