import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { hc } from "hono/client";
import { type AppType, api } from "../api";
import { withAutoContentLength } from "../test-fixtures/app-request";
import { useDbFixture } from "../test-fixtures/db";
import { useMediaFixture } from "../test-fixtures/media";
import { useS3Fixture } from "../test-fixtures/s3";
import { prisma } from "./prisma";
import { getS3 } from "./s3";
import { audioTranscodedKey, spectrogramPrefix } from "./storage";
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

// API 経由で project を作り、S3 + DB に audio を直接 seed する (upload pipeline は別テストが担保)
async function seedAudio(client: ReturnType<typeof makeClient>) {
  const projRes = await client.projects.$post({ json: { name: "spec-test" } });
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

describe("cqt spectrogram task", () => {
  it("POST → task 完走 → meta/tiles 取得 → DELETE で S3 ごと回収", async () => {
    const client = makeClient();
    const { projectId, audioId } = await seedAudio(client);
    const specsApi = client.projects[":id"].audios[":audioId"].spectrograms;

    const created = await specsApi.$post({
      param: { id: projectId, audioId },
      json: { binsPerOctave: 12, octaves: 5, fminHz: 55, harmonics: [1, 2] },
    });
    expect(created.status).toBe(201);
    if (!created.ok) throw new Error("unreachable");
    const { spectrogram, task } = await created.json();
    expect(task.kind).toBe("spectrogram");
    expect(spectrogram.status).toBe("pending");

    await waitForInflightTasks();
    const doneTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(doneTask.status).toBe("succeeded");
    const spec = await prisma.spectrogram.findUniqueOrThrow({ where: { id: spectrogram.id } });
    expect(spec.status).toBe("ready");
    // 成功時は mark が tx 内で回収される
    expect(await prisma.deletionMark.count()).toBe(0);

    const metaRes = await specsApi[":specId"].meta.$get({
      param: { id: projectId, audioId, specId: spectrogram.id },
    });
    expect(metaRes.status).toBe(200);
    const meta = (await metaRes.json()) as {
      frames: number;
      bins: number;
      levels: number;
      hop: number;
      harmonics: number[];
    };
    expect(meta.bins).toBe(60);
    expect(meta.harmonics).toEqual([1, 2]);
    expect(meta.frames).toBeGreaterThan(0);
    expect(meta.levels).toBeGreaterThanOrEqual(1);

    const tileRes = await specsApi[":specId"].tiles[":harmonic"][":level"][":index"].$get({
      param: {
        id: projectId,
        audioId,
        specId: spectrogram.id,
        harmonic: "2",
        level: "0",
        index: "0",
      },
    });
    expect(tileRes.status).toBe(200);
    const tile = new Uint8Array(await tileRes.arrayBuffer());
    expect(tile.length).toBe(Math.min(2048, meta.frames) * meta.bins);

    // 持っていない harmonic は 404
    const badTile = await specsApi[":specId"].tiles[":harmonic"][":level"][":index"].$get({
      param: {
        id: projectId,
        audioId,
        specId: spectrogram.id,
        harmonic: "3",
        level: "0",
        index: "0",
      },
    });
    expect(badTile.status).toBe(404);

    const deleted = await specsApi[":specId"].$delete({
      param: { id: projectId, audioId, specId: spectrogram.id },
    });
    expect(deleted.status).toBe(204);
    expect(await prisma.spectrogram.count()).toBe(0);
    expect(await listPrefix(spectrogramPrefix(projectId, audioId, spectrogram.id))).toEqual([]);
  }, 60_000);

  it("fmax 超過パラメータは 400", async () => {
    const client = makeClient();
    const { projectId, audioId } = await seedAudio(client);
    const res = await client.projects[":id"].audios[":audioId"].spectrograms.$post({
      param: { id: projectId, audioId },
      json: { binsPerOctave: 12, octaves: 10, fminHz: 100, harmonics: [4] },
    });
    expect(res.status).toBe(400);
  });

  it("pending 中の DELETE は 409", async () => {
    const client = makeClient();
    const { projectId, audioId } = await seedAudio(client);
    const specId = crypto.randomUUID();
    await prisma.spectrogram.create({
      data: {
        id: specId,
        audioId,
        binsPerOctave: 12,
        octaves: 5,
        fminHz: 55,
        harmonics: "[1]",
      },
    });
    const res = await client.projects[":id"].audios[":audioId"].spectrograms[":specId"].$delete({
      param: { id: projectId, audioId, specId },
    });
    expect(res.status).toBe(409);
  });
});
