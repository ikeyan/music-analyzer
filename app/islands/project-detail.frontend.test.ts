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

  it("音声 upload 後に再生ボタンを押すと audio.currentTime が進み、一時停止で止まる", async () => {
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
    // 一時停止で audio.paused が true になり currentTime が止まる
    await webview().click('button[aria-label="pause"]');
    const before = await webview().evaluate<number>(`document.querySelector('audio').currentTime`);
    await Bun.sleep(300);
    const after = await webview().evaluate<{ time: number; paused: boolean }>(
      `({ time: document.querySelector('audio').currentTime, paused: document.querySelector('audio').paused })`,
    );
    expect(after.paused).toBe(true);
    // 300ms の grace 内に 50ms 以上前進していなければ止まったとみなす
    expect(Math.abs(after.time - before)).toBeLessThan(0.05);
  }, 60_000);

  it("track の ↑↓ ボタンで並び替えると order が入れ替わる", async () => {
    const id = await createProject("reorder-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "first.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    await injectFileToInput(getMedia().audioMp3, "audio/*", "second.mp3", "audio/mpeg");
    // 2 audio source が出るまで poll
    await webview().evaluate(`new Promise((res, rej) => {
      const start = Date.now();
      const tick = () => {
        if (document.querySelectorAll('audio').length >= 2) return res();
        if (Date.now() - start > 30000) return rej(new Error("second audio timeout"));
        setTimeout(tick, 100);
      };
      tick();
    })`);
    // 「first を下に移動」をクリック → first と second が swap
    await webview().click('button[aria-label="first.mp3 を下に移動"]');
    // refresh で API から取り直したあと name の順序を見る (order asc で並ぶ)
    await webview().evaluate(`new Promise((res, rej) => {
      const start = Date.now();
      const tick = () => {
        const names = Array.from(document.querySelectorAll('honox-island span'))
          .map(s => s.textContent ?? "")
          .filter(t => t.includes(".mp3"));
        if (names.length >= 2 && names[0].includes("second") && names[1].includes("first")) return res();
        if (Date.now() - start > 5000) return rej(new Error("reorder not reflected: " + JSON.stringify(names)));
        setTimeout(tick, 50);
      };
      tick();
    })`);
  }, 90_000);

  it("非メディアファイルを upload すると task list に失敗とエラー文言が出る", async () => {
    const id = await createProject("error-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    // 適当な非メディア bytes をぶつけて ffprobe failure 経路を踏ませる。
    // /complete は通り、task が失敗するので task list に "失敗" として出る
    await webview().evaluate(`(() => {
      const bytes = new TextEncoder().encode("not a media file");
      const file = new File([bytes], "garbage.bin", { type: "application/octet-stream" });
      const input = document.querySelector('input[type=file][accept="audio/*"]');
      const dt = new DataTransfer();
      dt.items.add(file);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files").set;
      setter.call(input, dt.files);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitFor(webview(), '[role="alert"]', 30_000);
    const taskText = await webview().evaluate<string>(
      `(document.querySelector('section[aria-label="処理中のタスク"]')?.textContent ?? "")`,
    );
    expect(taskText).toContain("garbage.bin");
    expect(taskText).toContain("失敗");
    expect(taskText).toContain("could not parse uploaded file");
  }, 60_000);

  it("upload 中にリロードしても task list に処理中タスクが残る", async () => {
    const id = await createProject("reload-task");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "reload-tone.mp3", "audio/mpeg");
    // task が出たらすぐリロード (succeeded で消えてしまう前に)
    await waitFor(webview(), 'section[aria-label="処理中のタスク"]', 30_000);
    await goto(`/projects/${id}`);
    // リロード後も処理中タスクの fileName / kind ラベルが表示される or 既に audio に
    // 昇格して timeline に出ている (どちらでも UX 上 OK)
    const result = await webview().evaluate<{ task: string; hasAudio: boolean }>(`(() => {
      const taskSection = document.querySelector('section[aria-label="処理中のタスク"]');
      return {
        task: taskSection?.textContent ?? "",
        hasAudio: document.querySelector("audio source") !== null,
      };
    })()`);
    if (!result.hasAudio) {
      expect(result.task).toContain("reload-tone.mp3");
    }
    await waitFor(webview(), "audio source", 30_000);
  }, 90_000);

  it("削除ボタンで track が消える", async () => {
    const id = await createProject("delete-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    // confirm() を auto-accept する
    await webview().evaluate(`window.confirm = () => true`);
    await injectFileToInput(getMedia().audioMp3, "audio/*", "delete-me.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    await webview().click('button[aria-label="delete-me.mp3 を削除"]');
    // refresh 後 <audio> が DOM から消える
    await webview().evaluate(`new Promise((res, rej) => {
      const start = Date.now();
      const tick = () => {
        if (document.querySelectorAll('audio').length === 0) return res();
        if (Date.now() - start > 5000) return rej(new Error("audio still present"));
        setTimeout(tick, 50);
      };
      tick();
    })`);
  }, 60_000);
});
