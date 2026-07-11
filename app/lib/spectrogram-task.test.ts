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
      baseBins: number;
      levels: number;
      hop: number;
      harmonics: number[];
    };
    expect(meta.bins).toBe(60);
    expect(meta.harmonics).toEqual([1, 2]);
    expect(meta.frames).toBeGreaterThan(0);
    expect(meta.levels).toBeGreaterThanOrEqual(1);
    // base plane は [fmin, Nyquist] を覆うので表示 bins より広い
    expect(meta.baseBins).toBeGreaterThan(meta.bins);

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

    // base plane (harmonic=0) は取得でき、baseBins 幅を持つ
    const baseTile = await specsApi[":specId"].tiles[":harmonic"][":level"][":index"].$get({
      param: {
        id: projectId,
        audioId,
        specId: spectrogram.id,
        harmonic: "0",
        level: "0",
        index: "0",
      },
    });
    expect(baseTile.status).toBe(200);
    const base = new Uint8Array(await baseTile.arrayBuffer());
    expect(base.length).toBe(Math.min(2048, meta.frames) * meta.baseBins);

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

  it("base plane の octave 数が表示 octave 数を超えても hop 整列で完走する", async () => {
    const client = makeClient();
    const { projectId, audioId } = await seedAudio(client);
    // fmax 16Hz → fs=3000, baseOctaves=7 > octaves=1。hop が 2^(baseOctaves-1) に整列しないと
    // base plane の computeCqt が throw する
    const created = await client.projects[":id"].audios[":audioId"].spectrograms.$post({
      param: { id: projectId, audioId },
      json: { binsPerOctave: 12, octaves: 1, fminHz: 8, harmonics: [1] },
    });
    expect(created.status).toBe(201);
    if (!created.ok) throw new Error("unreachable");
    const { spectrogram, task } = await created.json();

    await waitForInflightTasks();
    const doneTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(doneTask.status).toBe("succeeded");
    const metaRes = await client.projects[":id"].audios[":audioId"].spectrograms[
      ":specId"
    ].meta.$get({ param: { id: projectId, audioId, specId: spectrogram.id } });
    const meta = (await metaRes.json()) as { bins: number; baseBins: number };
    expect(meta.bins).toBe(12);
    expect(meta.baseBins).toBe(84);
  }, 60_000);

  it("audio 実体が S3 にないと task/spectrogram が failed になり mark も残らない", async () => {
    const client = makeClient();
    const { projectId, audioId } = await seedAudio(client);
    await getS3().delete(audioTranscodedKey(projectId, audioId));
    const created = await client.projects[":id"].audios[":audioId"].spectrograms.$post({
      param: { id: projectId, audioId },
      json: { binsPerOctave: 12, octaves: 5, fminHz: 55, harmonics: [1] },
    });
    expect(created.status).toBe(201);
    if (!created.ok) throw new Error("unreachable");
    const { task } = await created.json();

    await waitForInflightTasks();
    const doneTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(doneTask.status).toBe("failed");
    const spec = await prisma.spectrogram.findUniqueOrThrow({ where: { id: task.id } });
    expect(spec.status).toBe("failed");
    expect(await prisma.deletionMark.count()).toBe(0);
  });

  it("メモリ見積もりが予算超過なら decode せずに failed になる", async () => {
    const client = makeClient();
    const { projectId, audioId } = await seedAudio(client);
    // 2h × fmax ~16.7kHz (fs ~43kHz) は PCM だけで予算超過
    await prisma.audio.update({
      where: { id: audioId },
      data: { durationSec: 7200, srcEndSec: 7200, projEndSec: 7200 },
    });
    const created = await client.projects[":id"].audios[":audioId"].spectrograms.$post({
      param: { id: projectId, audioId },
      json: { binsPerOctave: 12, octaves: 9, fminHz: 32.7, harmonics: [1] },
    });
    expect(created.status).toBe(201);
    if (!created.ok) throw new Error("unreachable");
    const { task } = await created.json();

    await waitForInflightTasks();
    const doneTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(doneTask.status).toBe("failed");
    expect(doneTask.error).toContain("exceeds budget");
  });

  it("低周波 × 高 bins の演算量見積もりが予算超過なら decode せずに failed になる", async () => {
    const client = makeClient();
    const { projectId, audioId } = await seedAudio(client);
    // VQT が低域の窓長を頭打ちにするので単一 plane では ops が膨らみにくい。
    // 高 bins × 8 harmonic plane × 長尺で全 plane 合算が予算を超える構成にする
    await prisma.audio.update({
      where: { id: audioId },
      data: { durationSec: 3600, srcEndSec: 3600, projEndSec: 3600 },
    });
    const created = await client.projects[":id"].audios[":audioId"].spectrograms.$post({
      param: { id: projectId, audioId },
      json: { binsPerOctave: 96, octaves: 4, fminHz: 8, harmonics: [1, 2, 3, 4, 5, 6, 7, 8] },
    });
    expect(created.status).toBe(201);
    if (!created.ok) throw new Error("unreachable");
    const { task } = await created.json();

    await waitForInflightTasks();
    const doneTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(doneTask.status).toBe("failed");
    expect(doneTask.error).toContain("estimated compute");
  });

  it("基本レンジ fmin*2^octaves が上限超過なら 400", async () => {
    const client = makeClient();
    const { projectId, audioId } = await seedAudio(client);
    // 100*2^10 = 102400 > 20000
    const res = await client.projects[":id"].audios[":audioId"].spectrograms.$post({
      param: { id: projectId, audioId },
      json: { binsPerOctave: 12, octaves: 10, fminHz: 100, harmonics: [1] },
    });
    expect(res.status).toBe(400);
  });

  it("基本レンジは上限内で harmonic だけ上限超過なら受理 (高域は clamp)", async () => {
    const client = makeClient();
    const { projectId, audioId } = await seedAudio(client);
    // 32.7*2^7 = 4185.6 <= 20000 だが ×5 倍音 = 20928 > 20000
    const res = await client.projects[":id"].audios[":audioId"].spectrograms.$post({
      param: { id: projectId, audioId },
      json: { binsPerOctave: 12, octaves: 7, fminHz: 32.7, harmonics: [1, 5] },
    });
    expect(res.status).toBe(201);
    // background task を drain してから抜ける (次 test の clearDb と race させない)
    await waitForInflightTasks();
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
