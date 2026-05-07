import { describe, expect, it } from "bun:test";
import { useDbFixture } from "../test-fixtures/db";
import { useFrontend, waitFor } from "../test-fixtures/frontend";
import { useMediaFixture } from "../test-fixtures/media";
import { useS3Fixture } from "../test-fixtures/s3";

useDbFixture();
useS3Fixture();
const getMedia = useMediaFixture();
const { webview, server, goto } = useFrontend();

async function createProject(name: string): Promise<string> {
  const res = await fetch(`${server()}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`createProject ${res.status}`);
  const body = (await res.json()) as { project: { id: string } };
  return body.project.id;
}

// File 入力に file を流し込むのは headless browser で OS file picker を踏まないよう、
// page 内で File オブジェクトを構築して input.files を native setter 経由で書き換える。
// File picker dialog は webview API では開けないのでこの形が一番素直
async function injectFileToInput(
  filePath: string,
  accept: string,
  fileName: string,
  mimeType: string,
): Promise<void> {
  const buf = await Bun.file(filePath).arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");
  await webview().evaluate(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
    const file = new File([bytes], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mimeType)} });
    const input = document.querySelector('input[type=file][accept=' + ${JSON.stringify(JSON.stringify(accept))} + ']');
    if (!input) throw new Error("file input not found: accept=" + ${JSON.stringify(accept)});
    const dt = new DataTransfer();
    dt.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files").set;
    setter.call(input, dt.files);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
}

// hydration が終わるまで poll。SSR 直後は React の onChange が attach されていないので
// file injection より前に必ず待つ
async function waitHydrated(selector: string, timeoutMs = 10_000): Promise<void> {
  await webview().evaluate(`new Promise((res, rej) => {
    const start = Date.now();
    const tick = () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el && Object.keys(el).some(k => k.startsWith("__reactFiber"))) return res();
      if (Date.now() - start > ${timeoutMs}) return rej(new Error("hydration timeout: " + ${JSON.stringify(selector)}));
      setTimeout(tick, 30);
    };
    tick();
  })`);
}

describe("ProjectDetail (frontend)", () => {
  it("音声ファイルを upload すると <audio> source に stream URL が入る", async () => {
    const id = await createProject("audio-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "test.mp3", "audio/mpeg");
    // upload + ffmpeg transcode + S3 + DB + refresh
    await waitFor(webview(), "audio source", 30_000);
    const src = await webview().evaluate<string>(
      `document.querySelector('audio source').getAttribute('src') ?? ""`,
    );
    expect(src).toMatch(/\/api\/projects\/[^/]+\/audios\/[^/]+\/stream$/);
  }, 60_000);

  it("動画ファイルを upload すると <video> に stream URL が入る", async () => {
    const id = await createProject("video-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="video/*"]');
    await injectFileToInput(getMedia().videoMp4, "video/*", "test.mp4", "video/mp4");
    await waitFor(webview(), "video[src]", 60_000);
    const src = await webview().evaluate<string>(
      `document.querySelector('video').getAttribute('src') ?? ""`,
    );
    expect(src).toMatch(/\/api\/projects\/[^/]+\/videos\/[^/]+\/stream$/);
  }, 90_000);

  it("音声 upload 後に再生ボタンを押すと audio.currentTime が進む", async () => {
    const id = await createProject("playback-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "test.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    // <audio> が canplay になるまで待ってから user-gesture click を撃つ
    await webview().evaluate(`new Promise((res, rej) => {
      const audio = document.querySelector('audio');
      if (!audio) return rej(new Error("no audio"));
      if (audio.readyState >= 2) return res();
      const t = setTimeout(() => rej(new Error("audio canplay timeout")), 5000);
      audio.addEventListener('canplay', () => { clearTimeout(t); res(); }, { once: true });
      audio.load();
    })`);
    // synthetic btn.click() は autoplay policy の user gesture にならないので
    // webview.click(selector) で CDP 経由の input event を撃つ
    await webview().click('button[aria-label="play"]');
    // 再生開始後にメディアが進むのを待つ
    const advanced = await webview().evaluate<number>(`new Promise(res => {
      const audio = document.querySelector('audio');
      const start = Date.now();
      const tick = () => {
        if (audio && audio.currentTime > 0) return res(audio.currentTime);
        if (Date.now() - start > 3000) return res(audio?.currentTime ?? 0);
        setTimeout(tick, 50);
      };
      tick();
    })`);
    expect(advanced).toBeGreaterThan(0);
  }, 60_000);
});
